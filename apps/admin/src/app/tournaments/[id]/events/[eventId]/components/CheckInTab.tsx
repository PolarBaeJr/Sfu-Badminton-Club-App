'use client';

import { useState } from 'react';
import { Button, AvatarChip } from '@badminton/ui';
import {
  checkInParticipant,
  markParticipantNoShow,
  checkInPair,
  markPairNoShow,
  bulkCheckIn,
} from '@/lib/tournament-actions';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import { CheckCircle, XCircle, Clock, Users, UserCheck } from 'lucide-react';
import { getName } from './entry-name';
import type { TournamentEventRow, ParticipantWithPlayer, PairWithPlayers } from '@/lib/tournament-types';

interface Props {
  event: TournamentEventRow;
  participants: ParticipantWithPlayer[];
  pairs: PairWithPlayers[];
  isDoubles: boolean;
}

export function CheckInTab({ event, participants, pairs, isDoubles }: Props) {
  const [loading, setLoading] = useState<string | null>(null);
  const [bulkLoading, setBulkLoading] = useState(false);
  const { toast } = useToast();
  const router = useRouter();

  const entries: Array<ParticipantWithPlayer | PairWithPlayers> = isDoubles ? pairs : participants;
  const checkedIn = entries.filter(e => e.status === 'checked_in');
  const notCheckedIn = entries.filter(e => e.status === 'registered');
  const noShows = entries.filter(e => e.status === 'no_show');
  const progress = entries.length > 0 ? (checkedIn.length / entries.length) * 100 : 0;

  async function handleCheckIn(id: string) {
    setLoading(id);
    try {
      if (isDoubles) {
        await checkInPair(id);
      } else {
        await checkInParticipant(id);
      }
      toast('Checked in', 'success');
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(null);
  }

  async function handleNoShow(id: string) {
    setLoading(`noshow-${id}`);
    try {
      if (isDoubles) {
        await markPairNoShow(id);
      } else {
        await markParticipantNoShow(id);
      }
      toast('Marked as no-show', 'success');
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(null);
  }

  async function handleBulkCheckIn() {
    setBulkLoading(true);
    try {
      await bulkCheckIn(event.id, isDoubles ? 'pairs' : 'participants');
      toast('All present participants checked in', 'success');
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setBulkLoading(false);
  }

  const canCheckIn = event.status === 'checkin' || event.status === 'registration';

  return (
    <div className="space-y-6">
      {/* Header with progress */}
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-xl font-bold text-[var(--text-primary)] flex items-center gap-2">
              <UserCheck className="w-5 h-5 text-[var(--color-success)]" />
              {event.status === 'checkin' ? 'CHECK-IN OPEN' : 'Check-In Status'}
            </h2>
            <p className="text-sm text-[var(--text-muted)] mt-1">
              {checkedIn.length} / {entries.length} checked in
            </p>
          </div>
          {canCheckIn && notCheckedIn.length > 0 && (
            <Button onClick={handleBulkCheckIn} loading={bulkLoading} variant="ghost" className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none">
              Check In All Present
            </Button>
          )}
        </div>

        {/* Progress bar */}
        <div className="h-3 rounded-full bg-[var(--bg-elevated)] overflow-hidden" role="progressbar" aria-valuenow={Math.round(progress)} aria-valuemin={0} aria-valuemax={100} aria-label={`Check-in progress: ${checkedIn.length} of ${entries.length}`}>
          <div
            className="h-full rounded-full transition-all duration-500"
            style={{
              width: `${progress}%`,
              backgroundColor: progress === 100 ? 'var(--color-success)' : 'var(--color-accent)',
            }}
          />
        </div>
        <div className="flex justify-between mt-2 text-xs text-[var(--text-muted)]">
          <span>{checkedIn.length} checked in</span>
          <span>{notCheckedIn.length} waiting</span>
          {noShows.length > 0 && <span className="text-[var(--color-warning)]"><span className="sr-only">Warning: </span>{noShows.length} no-shows</span>}
        </div>
      </div>

      {/* Two columns: Not checked in | Checked in */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {/* Not Yet Checked In */}
        <div>
          <h3 className="text-sm font-semibold text-[var(--text-muted)] uppercase tracking-wider mb-3 flex items-center gap-2">
            <Clock className="w-4 h-4" />
            Not Yet Checked In ({notCheckedIn.length})
          </h3>
          <div className="space-y-2">
            {notCheckedIn.map((entry) => (
              <EntryCard
                key={entry.id}
                entry={entry}
                isDoubles={isDoubles}
                actions={canCheckIn ? (
                  <div className="flex gap-1.5">
                    <Button
                      size="sm"
                      onClick={() => handleCheckIn(entry.id)}
                      loading={loading === entry.id}
                      className="bg-[var(--color-success)] hover:bg-[var(--color-success)]/80 focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
                    >
                      <CheckCircle className="w-3.5 h-3.5 mr-1" /> Check In
                    </Button>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleNoShow(entry.id)}
                      loading={loading === `noshow-${entry.id}`}
                      aria-label="Mark as no-show"
                      className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
                    >
                      <XCircle className="w-3.5 h-3.5 text-[var(--color-danger)]" />
                    </Button>
                  </div>
                ) : null}
              />
            ))}
            {notCheckedIn.length === 0 && (
              <p className="text-sm text-[var(--text-muted)] text-center py-4">All participants checked in!</p>
            )}
          </div>
        </div>

        {/* Checked In */}
        <div>
          <h3 className="text-sm font-semibold text-[var(--color-success)] uppercase tracking-wider mb-3 flex items-center gap-2">
            <CheckCircle className="w-4 h-4" />
            Checked In ({checkedIn.length})
          </h3>
          <div className="space-y-2">
            {checkedIn.map((entry) => (
              <EntryCard
                key={entry.id}
                entry={entry}
                isDoubles={isDoubles}
                checked
                actions={
                  entry.checked_in_at && (
                    <span className="text-[10px] text-[var(--text-muted)] font-mono">
                      {new Date(entry.checked_in_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  )
                }
              />
            ))}
          </div>
        </div>
      </div>

      {/* No Shows */}
      {noShows.length > 0 && (
        <div>
          <h3 className="text-sm font-semibold text-[var(--color-warning)] uppercase tracking-wider mb-3 flex items-center gap-2">
            <XCircle className="w-4 h-4" />
            No Shows ({noShows.length})
          </h3>
          <div className="space-y-2">
            {noShows.map((entry) => (
              <EntryCard key={entry.id} entry={entry} isDoubles={isDoubles} dimmed />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function EntryCard({
  entry,
  isDoubles,
  checked,
  dimmed,
  actions,
}: {
  entry: ParticipantWithPlayer | PairWithPlayers;
  isDoubles: boolean;
  checked?: boolean;
  dimmed?: boolean;
  actions?: React.ReactNode;
}) {
  const name = getName(entry, isDoubles);

  return (
    <div
      className={`flex items-center justify-between p-3 rounded-lg border transition-colors ${
        checked
          ? 'bg-[var(--color-success)]/5 border-[var(--color-success)]/20'
          : dimmed
          ? 'bg-[var(--bg-elevated)] border-[var(--border)] opacity-50'
          : 'bg-[var(--bg-elevated)] border-[var(--border)] hover:border-[var(--border-hover)]'
      }`}
    >
      <div className="flex items-center gap-2.5">
        {entry.seed_number && (
          <span className="text-xs font-mono text-[var(--text-muted)] w-6 text-center">#{entry.seed_number}</span>
        )}
        {!isDoubles && <AvatarChip name={name} src={(entry as ParticipantWithPlayer).player?.avatar_url} size="sm" id={(entry as ParticipantWithPlayer).player?.id} />}
        <span className="text-sm font-medium text-[var(--text-primary)]">{name}</span>
      </div>
      {actions}
    </div>
  );
}
