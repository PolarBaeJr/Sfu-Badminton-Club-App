'use client';

import { useState } from 'react';
import { Button, useConfirm } from '@badminton/ui';
import { formatDateTime, parseFormatConfig } from '@badminton/shared';
import { ArrowRight, Tag } from 'lucide-react';
import {
  approvePairCategoryRequest,
  declinePairCategoryRequest,
  cancelPairCategoryRequest,
} from '@/lib/tournament-actions';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import type { CategoryRequest, PairWithPlayers, TournamentEventRow } from '@/lib/tournament-types';

interface Props {
  requests: CategoryRequest[];
  event: TournamentEventRow;
  pairs: PairWithPlayers[];
  /** Approve and Decline: tournaments.results.edit.write, event not finalised. */
  canDecide: boolean;
  /** Cancel, on the viewer's own requests: tournaments.draw.seed.set.write. */
  canCancel: boolean;
  viewerId: string;
}

/**
 * Category changes waiting for approval (00279): a team that has played with
 * head starts cannot have its category changed directly, so the desk asks and
 * somebody who may correct a recorded result decides.
 */
export function CategoryRequestsPanel({ requests, event, pairs, canDecide, canCancel, viewerId }: Props) {
  const [busy, setBusy] = useState<string | null>(null);
  const { toast } = useToast();
  const router = useRouter();
  const confirm = useConfirm();

  const categories = parseFormatConfig(event.format_config)?.categories ?? [];
  const labelOf = (key: string | null) =>
    key == null ? 'Unset' : categories.find((c) => c.key === key)?.label ?? `${key} (removed)`;
  const teamOf = (pairId: string) => {
    const pair = pairs.find((p) => p.id === pairId);
    if (!pair) return 'A team no longer in this event';
    return pair.pair_name || [pair.player1?.full_name, pair.player2?.full_name].filter(Boolean).join(' / ') || 'Unnamed team';
  };

  async function handleApprove(request: CategoryRequest) {
    const ok = await confirm({
      title: `Change ${teamOf(request.pair_id)} to ${labelOf(request.to_category)}?`,
      message:
        'Their open matches get the new head start. Played matches keep their recorded scores; '
        + 'a played match can be corrected with "Apply the current head start" in Edit result.',
      confirmLabel: 'Approve',
    });
    if (!ok) return;
    setBusy(request.id);
    const res = await approvePairCategoryRequest(request.id);
    setBusy(null);
    if (!res.ok) { toast(res.error, 'error'); router.refresh(); return; }
    const n = res.data.rehandicapped;
    toast(
      n > 0
        ? `Category changed; head starts updated on ${n} open match${n === 1 ? '' : 'es'}`
        : 'Category changed',
      'success',
    );
    router.refresh();
  }

  async function handleDecline(request: CategoryRequest) {
    const ok = await confirm({
      title: 'Decline this category change?',
      message: `${teamOf(request.pair_id)} stays ${labelOf(request.from_category)}.`,
      confirmLabel: 'Decline',
      danger: true,
    });
    if (!ok) return;
    setBusy(request.id);
    const res = await declinePairCategoryRequest(request.id);
    setBusy(null);
    if (!res.ok) { toast(res.error, 'error'); router.refresh(); return; }
    toast('Category change declined', 'success');
    router.refresh();
  }

  async function handleCancel(request: CategoryRequest) {
    setBusy(request.id);
    const res = await cancelPairCategoryRequest(request.id);
    setBusy(null);
    if (!res.ok) { toast(res.error, 'error'); router.refresh(); return; }
    toast('Category change request cancelled', 'success');
    router.refresh();
  }

  return (
    <section
      aria-label="Category changes waiting for approval"
      className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden"
    >
      <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-[var(--border)]">
        <Tag className="w-4 h-4 text-[var(--text-muted)]" aria-hidden />
        <span className="text-sm font-medium text-[var(--text-primary)]">Category changes waiting for approval</span>
        <span className="text-xs text-[var(--text-muted)]">{requests.length}</span>
      </div>
      <ul className="divide-y divide-[var(--border)]">
        {requests.map((request) => {
          const mine = request.requested_by != null && request.requested_by === viewerId;
          return (
            <li key={request.id} className="flex flex-wrap items-start justify-between gap-3 px-4 py-3">
              <div className="min-w-0 space-y-1">
                <p className="flex flex-wrap items-center gap-1.5 text-sm text-[var(--text-primary)]">
                  <span className="font-medium">{teamOf(request.pair_id)}</span>
                  <span className="text-[var(--text-muted)]">{labelOf(request.from_category)}</span>
                  <ArrowRight className="w-3.5 h-3.5 text-[var(--text-muted)]" aria-label="to" />
                  <span className="font-medium">{labelOf(request.to_category)}</span>
                </p>
                <p className="text-sm text-[var(--text-primary)] break-words">{request.reason}</p>
                <p className="text-xs text-[var(--text-muted)]">
                  Asked by {mine ? 'you' : request.requester?.full_name ?? 'a club officer'} · {formatDateTime(request.requested_at)}
                </p>
              </div>
              <div className="inline-flex flex-nowrap items-center gap-2 [&_button]:min-h-[44px]">
                {canDecide && (
                  <>
                    <Button
                      size="sm"
                      onClick={() => handleApprove(request)}
                      loading={busy === request.id}
                      disabled={busy != null && busy !== request.id}
                      aria-label={`Approve the category change for ${teamOf(request.pair_id)}`}
                      className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleDecline(request)}
                      disabled={busy != null}
                      aria-label={`Decline the category change for ${teamOf(request.pair_id)}`}
                      className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
                    >
                      Decline
                    </Button>
                  </>
                )}
                {canCancel && mine && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleCancel(request)}
                    disabled={busy != null}
                    aria-label={`Cancel your category change request for ${teamOf(request.pair_id)}`}
                    className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
                  >
                    Cancel request
                  </Button>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
