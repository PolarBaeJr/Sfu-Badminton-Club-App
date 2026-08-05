'use client';

import { useState } from 'react';
import { Badge, Button } from '@badminton/ui';
import {
  TOURNAMENT_EVENT_TYPE_LABELS,
  TOURNAMENT_EVENT_STATUS_LABELS,
  TOURNAMENT_EVENT_STATUS_COLORS,
  nextPowerOf2,
  describeMatchShape,
} from '@badminton/shared';
import type { TournamentEventType, TournamentEventStatus } from '@badminton/shared';
import {
  setEventStatus,
  generateSingleEliminationBracket,
  generateRoundRobinMatches,
  finalizeEvent,
  lockDraw,
  unlockDraw,
} from '@/lib/tournament-actions';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import { Trophy, Users, CheckCircle, Swords, BarChart3, ChevronRight, Lock, Unlock, SlidersHorizontal } from 'lucide-react';
import { EventSettingsDialog } from './EventSettingsDialog';
import type { SiblingEvent } from '../../../event-format-fields';
import type { TournamentEventRow } from '@/lib/tournament-types';

interface Props {
  tournament: Record<string, unknown>;
  event: Record<string, unknown>;
  siblingEvents: SiblingEvent[];
  isDoubles: boolean;
  totalEntries: number;
  checkedIn: number;
  totalMatches: number;
  completedMatches: number;
}

const STATUS_STEPS: TournamentEventStatus[] = ['registration', 'checkin', 'bracket_generated', 'live', 'completed'];

export function EventHeader({ tournament, event, siblingEvents, isDoubles, totalEntries, checkedIn, totalMatches, completedMatches }: Props) {
  const [loading, setLoading] = useState(false);
  const [lockLoading, setLockLoading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const { toast } = useToast();
  const router = useRouter();
  const drawLocked = event.draw_locked as boolean;

  const status = event.status as TournamentEventStatus;
  const eventType = event.event_type as TournamentEventType;
  const format = event.format as string;
  const currentStepIdx = STATUS_STEPS.indexOf(status);
  const bracketSize = nextPowerOf2(totalEntries);
  const byes = bracketSize - totalEntries;
  // Same rule the server applies: the format is editable until a draw exists.
  const settingsEditable = totalMatches === 0 && (status === 'registration' || status === 'checkin');
  const seededFromPool = Boolean(event.seeded_from_event_id);

  async function handleAction() {
    setLoading(true);
    try {
      if (status === 'registration') {
        await setEventStatus(event.id as string, 'checkin');
        toast('Check-in opened', 'success');
      } else if (status === 'checkin') {
        const res = format === 'round_robin'
          ? await generateRoundRobinMatches(event.id as string)
          : await generateSingleEliminationBracket(event.id as string);
        // Generation refuses for ordinary reasons — an unfinished pool, a locked
        // draw — and the exec needs to read which one, so the message is shown
        // rather than swallowed by a generic failure toast.
        if (!res.ok) { toast(res.error, 'error'); setLoading(false); return; }
        toast('Bracket generated', 'success');
      } else if (status === 'bracket_generated') {
        await setEventStatus(event.id as string, 'live');
        toast('Tournament is live!', 'success');
      } else if (status === 'live') {
        await finalizeEvent(event.id as string);
        toast('Event finalized', 'success');
      }
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Action failed', 'error');
    }
    setLoading(false);
  }

  const actionLabel: Record<string, string> = {
    registration: 'Open Check-In',
    checkin: 'Generate Bracket',
    bracket_generated: 'Start Tournament',
    live: 'Finalize Tournament',
  };

  const actionDisabled = status === 'checkin' && checkedIn < 2;

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-6 space-y-5">
      {/* Title + Badges */}
      <div className="flex flex-col sm:flex-row items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-lg bg-[var(--color-accent)]/10 flex items-center justify-center">
              <Trophy className="w-5 h-5 text-[var(--color-accent)]" />
            </div>
            <div>
              <h1 className="text-2xl font-bold font-display text-[var(--text-primary)]">
                {TOURNAMENT_EVENT_TYPE_LABELS[eventType] ?? eventType}
              </h1>
              <p className="text-sm text-[var(--text-muted)] mt-0.5">
                {tournament.name as string}
              </p>
            </div>
          </div>
          <div className="flex gap-2 mt-3 ml-[52px]">
            <span
              className="text-xs font-semibold px-2.5 py-1 rounded-full"
              role="status"
              style={{
                color: TOURNAMENT_EVENT_STATUS_COLORS[status],
                backgroundColor: `${TOURNAMENT_EVENT_STATUS_COLORS[status]}15`,
              }}
            >
              <span className="sr-only">Event status: </span>{TOURNAMENT_EVENT_STATUS_LABELS[status]}
            </span>
            <Badge variant="default">{format === 'round_robin' ? 'Round Robin' : 'Single Elimination'}</Badge>
            <Badge variant="default">{describeMatchShape(event as unknown as TournamentEventRow)}</Badge>
            {seededFromPool && (
              <Badge variant="default">
                Seeded from pool by {(event.seed_by as string) === 'points' ? 'points' : 'wins'}
              </Badge>
            )}
            {drawLocked && <Badge variant="default">Draw Locked</Badge>}
          </div>
        </div>

        <div className="flex gap-2">
          {settingsEditable && (
            <Button
              variant="ghost"
              size="sm"
              aria-label="Event settings"
              className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
              onClick={() => setSettingsOpen(true)}
            >
              <SlidersHorizontal className="w-4 h-4 mr-1" />
              Settings
            </Button>
          )}
          {['bracket_generated', 'live'].includes(status) && (
            <Button
              variant="ghost"
              size="sm"
              loading={lockLoading}
              aria-label={drawLocked ? 'Unlock draw' : 'Lock draw'}
              className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
              onClick={async () => {
                setLockLoading(true);
                try {
                  if (drawLocked) {
                    await unlockDraw(event.id as string);
                    toast('Draw unlocked', 'success');
                  } else {
                    await lockDraw(event.id as string);
                    toast('Draw locked', 'success');
                  }
                  router.refresh();
                } catch (err) {
                  toast(err instanceof Error ? err.message : 'Failed', 'error');
                }
                setLockLoading(false);
              }}
            >
              {drawLocked ? <Unlock className="w-4 h-4 mr-1" /> : <Lock className="w-4 h-4 mr-1" />}
              {drawLocked ? 'Unlock Draw' : 'Lock Draw'}
            </Button>
          )}
          {status !== 'completed' && (
            <Button
              onClick={handleAction}
              loading={loading}
              disabled={actionDisabled}
              className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
            >
              {actionLabel[status] ?? 'Next Step'}
            </Button>
          )}
        </div>
      </div>

      {/* Status Stepper */}
      <div className="flex items-center gap-1" role="progressbar" aria-label={`Event progress: ${TOURNAMENT_EVENT_STATUS_LABELS[status]}`} aria-valuenow={currentStepIdx + 1} aria-valuemin={1} aria-valuemax={STATUS_STEPS.length}>
        {STATUS_STEPS.map((step, i) => {
          const isActive = i === currentStepIdx;
          const isPast = i < currentStepIdx;
          const color = TOURNAMENT_EVENT_STATUS_COLORS[step];
          return (
            <div key={step} className="flex items-center gap-1 flex-1">
              <div
                className={`h-1.5 flex-1 rounded-full transition-all ${
                  isPast || isActive ? '' : 'bg-[var(--border)]'
                }`}
                style={isPast || isActive ? { backgroundColor: color } : undefined}
              />
              {i < STATUS_STEPS.length - 1 && (
                <ChevronRight className="w-3 h-3 text-[var(--text-muted)] flex-shrink-0" />
              )}
            </div>
          );
        })}
      </div>
      <div className="flex justify-between text-[10px] text-[var(--text-muted)] uppercase tracking-wider px-1">
        {STATUS_STEPS.map((step) => (
          <span key={step} className={step === status ? 'text-[var(--text-primary)] font-semibold' : ''}>
            {TOURNAMENT_EVENT_STATUS_LABELS[step]}
          </span>
        ))}
      </div>

      {/* Stats Row */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <StatCard
          icon={<Users className="w-4 h-4" />}
          label="Registered"
          value={`${totalEntries}${event.max_participants ? `/${event.max_participants}` : ''}`}
          color="var(--color-info)"
        />
        <StatCard
          icon={<CheckCircle className="w-4 h-4" />}
          label="Checked In"
          value={`${checkedIn}/${totalEntries}`}
          color="var(--color-success)"
        />
        <StatCard
          icon={<Swords className="w-4 h-4" />}
          label="Matches"
          value={`${completedMatches}/${totalMatches}`}
          color="var(--color-accent)"
        />
        <StatCard
          icon={<BarChart3 className="w-4 h-4" />}
          label="Bracket Info"
          value={format === 'round_robin' ? `${totalEntries} entries` : `${bracketSize}-slot${byes > 0 ? ` (${byes} byes)` : ''}`}
          color="var(--color-warning)"
        />
      </div>

      {settingsOpen && (
        <EventSettingsDialog
          event={event as unknown as TournamentEventRow}
          siblings={siblingEvents}
          onClose={() => setSettingsOpen(false)}
        />
      )}
    </div>
  );
}

function StatCard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color: string }) {
  return (
    <div className="rounded-lg bg-[var(--bg-elevated)] border border-[var(--border)] p-3">
      <div className="flex items-center gap-1.5 mb-1" style={{ color }}>
        {icon}
        <span className="text-[10px] uppercase tracking-wider font-medium">{label}</span>
      </div>
      <p className="text-lg font-bold text-[var(--text-primary)] font-mono">{value}</p>
    </div>
  );
}
