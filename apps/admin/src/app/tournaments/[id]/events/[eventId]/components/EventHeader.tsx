'use client';

import { useState } from 'react';
import { Badge, Button } from '@badminton/ui';
import {
  TOURNAMENT_EVENT_TYPE_LABELS,
  TOURNAMENT_EVENT_STATUS_LABELS,
  TOURNAMENT_EVENT_STATUS_COLORS,
  nextPowerOf2,
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
import { Trophy, Users, CheckCircle, Swords, BarChart3, ChevronRight, Lock, Unlock } from 'lucide-react';

interface Props {
  tournament: Record<string, unknown>;
  event: Record<string, unknown>;
  isDoubles: boolean;
  totalEntries: number;
  checkedIn: number;
  totalMatches: number;
  completedMatches: number;
}

const STATUS_STEPS: TournamentEventStatus[] = ['registration', 'checkin', 'bracket_generated', 'live', 'completed'];

export function EventHeader({ tournament, event, isDoubles, totalEntries, checkedIn, totalMatches, completedMatches }: Props) {
  const [loading, setLoading] = useState(false);
  const [lockLoading, setLockLoading] = useState(false);
  const { toast } = useToast();
  const router = useRouter();
  const drawLocked = event.draw_locked as boolean;

  const status = event.status as TournamentEventStatus;
  const eventType = event.event_type as TournamentEventType;
  const format = event.format as string;
  const currentStepIdx = STATUS_STEPS.indexOf(status);
  const bracketSize = nextPowerOf2(totalEntries);
  const byes = bracketSize - totalEntries;

  async function handleAction() {
    setLoading(true);
    try {
      if (status === 'registration') {
        await setEventStatus(event.id as string, 'checkin');
        toast('Check-in opened', 'success');
      } else if (status === 'checkin') {
        if (format === 'round_robin') {
          await generateRoundRobinMatches(event.id as string);
        } else {
          await generateSingleEliminationBracket(event.id as string);
        }
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
      <div className="flex items-start justify-between">
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
              style={{
                color: TOURNAMENT_EVENT_STATUS_COLORS[status],
                backgroundColor: `${TOURNAMENT_EVENT_STATUS_COLORS[status]}15`,
              }}
            >
              {TOURNAMENT_EVENT_STATUS_LABELS[status]}
            </span>
            <Badge variant="default">{format === 'round_robin' ? 'Round Robin' : 'Single Elimination'}</Badge>
            <Badge variant="default">{(event.match_format as string).replace(/_/g, ' ')}</Badge>
            {drawLocked && <Badge variant="default">Draw Locked</Badge>}
          </div>
        </div>

        <div className="flex gap-2">
          {['bracket_generated', 'live'].includes(status) && (
            <Button
              variant="ghost"
              size="sm"
              loading={lockLoading}
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
            >
              {actionLabel[status] ?? 'Next Step'}
            </Button>
          )}
        </div>
      </div>

      {/* Status Stepper */}
      <div className="flex items-center gap-1">
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
      <div className="grid grid-cols-4 gap-3">
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
