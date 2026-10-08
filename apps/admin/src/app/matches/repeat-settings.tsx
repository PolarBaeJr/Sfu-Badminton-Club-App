'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, Dialog, Input, Textarea } from '@badminton/ui';
import { repeatChallengeFactor } from '@badminton/shared';
import { updateRepeatChallengeSettings } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';
import { REASON_MIN } from '@/lib/audit-reason';

interface RepeatSettingsCardProps {
  decayPct: number;
  windowDays: number;
  minFactor: number;
}

const ORDINALS = ['1st', '2nd', '3rd', '4th', '5th', '6th'];

/**
 * The repeat challenge rule (00268), for whoever may void a match. The same
 * three keys are on /ratings for admins; this is the exec's way in, and it can
 * write those three and nothing else.
 */
export function RepeatSettingsCard({ decayPct, windowDays, minFactor }: RepeatSettingsCardProps) {
  const [open, setOpen] = useState(false);
  const [pct, setPct] = useState(String(decayPct));
  const [days, setDays] = useState(String(windowDays));
  const [floor, setFloor] = useState(minFactor.toFixed(2));
  const [reason, setReason] = useState('');
  const [isPending, startTransition] = useTransition();
  const { toast } = useToast();
  const router = useRouter();

  const settings = { repeat_decay_pct: decayPct, repeat_min_factor: minFactor };
  const sequence = ORDINALS.map((label, prior) => ({
    label,
    percent: Math.round(repeatChallengeFactor(prior, settings) * 100),
  }));

  function handleOpen() {
    setPct(String(decayPct));
    setDays(String(windowDays));
    setFloor(minFactor.toFixed(2));
    setReason('');
    setOpen(true);
  }

  function handleSave() {
    startTransition(async () => {
      const res = await updateRepeatChallengeSettings(
        { decayPct: Number(pct), windowDays: Number(days), minFactor: Number(floor) },
        reason,
      );
      if (!res.ok) { toast(res.error, 'error'); return; }
      toast('Repeat challenge rules saved', 'success');
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-1">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">Repeat challenges</h2>
          <p className="text-sm text-[var(--text-secondary)]">
            {decayPct === 0
              ? 'Off. Every rated challenge moves ratings by the full amount, however often the same players meet.'
              : `Each earlier rated challenge between the same players in the last ${windowDays} days cuts the rating change by ${decayPct}%, down to ${Math.round(minFactor * 100)}% of normal.`}
          </p>
          {decayPct > 0 && (
            <p className="text-xs font-mono text-[var(--text-muted)]">
              {sequence.map((s) => `${s.label} ${s.percent}%`).join(' · ')}
            </p>
          )}
        </div>
        <Button variant="ghost" size="sm" onClick={handleOpen}>Edit</Button>
      </div>
      <Dialog open={open} onClose={() => setOpen(false)} title="Repeat challenges">
        <div className="space-y-4">
          <p className="text-sm text-[var(--text-secondary)]">
            Applies to rated challenges confirmed from now on. Matches already on the ladder keep the change they were given.
          </p>
          <div className="grid grid-cols-3 gap-2">
            <Input label="Reduction (%)" type="number" min="0" max="90" step="5" value={pct} onChange={(e) => setPct(e.target.value)} />
            <Input label="Window (days)" type="number" min="1" max="365" step="1" value={days} onChange={(e) => setDays(e.target.value)} />
            <Input label="Floor (0 to 1)" type="number" min="0" max="1" step="0.05" value={floor} onChange={(e) => setFloor(e.target.value)} />
          </div>
          <Textarea
            label="Reason (required for audit)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={500}
          />
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={handleSave} loading={isPending} className="flex-1" disabled={reason.trim().length < REASON_MIN}>
              Save
            </Button>
          </div>
        </div>
      </Dialog>
    </Card>
  );
}
