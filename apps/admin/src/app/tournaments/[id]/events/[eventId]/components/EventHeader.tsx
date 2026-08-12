'use client';

import { useRef, useState } from 'react';
import { Badge, Button, useConfirm } from '@badminton/ui';
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
import { Trophy, Users, CheckCircle, Swords, BarChart3, ChevronRight, Lock, Unlock, SlidersHorizontal, RefreshCw } from 'lucide-react';
import { EventSettingsDialog } from './EventSettingsDialog';
import { regenerateDrawControl, type DrawCapabilities } from '@/lib/participant-controls';
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
  /** Only `generate` is read here; the rest belong to the participants tab. */
  drawCapabilities: DrawCapabilities;
  /** Does the draw that exists right now carry a 3rd place playoff match? */
  hasThirdPlace: boolean;
}

const STATUS_STEPS: TournamentEventStatus[] = ['registration', 'checkin', 'bracket_generated', 'live', 'completed'];

export function EventHeader({ tournament, event, siblingEvents, isDoubles, totalEntries, checkedIn, totalMatches, completedMatches, drawCapabilities, hasThirdPlace }: Props) {
  const [loading, setLoading] = useState(false);
  const [lockLoading, setLockLoading] = useState(false);
  const [regenLoading, setRegenLoading] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The third-place playoff is a generation-time choice, so it lives next to the
  // button that generates. It is NOT persisted on the event — the generated
  // match is the record — so this is deliberately plain local state that resets
  // with the page, which is also what makes it honest: it can only ever describe
  // the draw that is about to be built, never one that already exists.
  // DEFAULT ON, at the club owner's instruction. A club running a knockout
  // almost always plays off for third — leaving it unticked meant the common
  // case needed a deliberate act and the rare one did not, and a draw generated
  // without it cannot be given one afterwards without regenerating.
  //
  // offerThirdPlace still gates whether the box is shown at all, so a draw with
  // no semi-final round is unaffected by this default.
  const [thirdPlace, setThirdPlace] = useState(true);
  // The SECOND third-place choice: the one made inside the Regenerate confirm.
  // It cannot share `thirdPlace` above — that state describes a draw that does
  // not exist yet and defaults ON, whereas regenerating starts from whatever the
  // existing draw actually has. A ref rather than state because the confirm
  // dialog stores the message element it was handed and re-rendering EventHeader
  // does not re-render it; the checkbox owns its own state (ThirdPlaceChoice
  // below) and writes the answer out through here.
  const regenThirdPlace = useRef(hasThirdPlace);
  const { toast } = useToast();
  const confirm = useConfirm();
  const router = useRouter();
  const drawLocked = event.draw_locked as boolean;

  const status = event.status as TournamentEventStatus;
  const eventType = event.event_type as TournamentEventType;
  const format = event.format as string;
  const currentStepIdx = STATUS_STEPS.indexOf(status);
  const bracketSize = nextPowerOf2(totalEntries);
  const byes = bracketSize - totalEntries;
  // Offered only where it means something: a knockout draw. A round robin
  // already produces a full ordering, and a 2-entry draw is a final with no
  // semi-finals to lose.
  const thirdPlaceApplies = format !== 'round_robin' && bracketSize >= 4;
  // ...and at the moment the draw is generated, which is now two moments: the
  // first press at check-in, and a redraw once a bracket exists.
  const offerThirdPlace = status === 'checkin' && thirdPlaceApplies;
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
          // A pool-seeded draw's size is only known server-side, so the flag is
          // passed as ticked and the server skips it if the resulting draw turns
          // out to have no semi-final round. offerThirdPlace gates the CHECKBOX,
          // not the request, so a stale `true` from a size that has since
          // changed cannot smuggle a playoff into a two-entry draw.
          : await generateSingleEliminationBracket(event.id as string, offerThirdPlace && thirdPlace);
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

  const regenerate = regenerateDrawControl(
    { status, drawLocked },
    drawCapabilities,
  );
  const eventLabel = TOURNAMENT_EVENT_TYPE_LABELS[eventType] ?? eventType;

  /**
   * REDRAW THE EVENT, IN PLACE.
   *
   * Calls the same two actions the primary button calls at check-in, on an
   * event that already has a bracket. Both delete every match for the event and
   * rebuild from the current field, and both leave the status at
   * `bracket_generated` — so there is no state to move and nothing to put back
   * if it refuses.
   *
   * IT IS NOT A THIN RE-RUN. Everything the first generation checked is checked
   * again, because the field can have changed underneath it: a pool-seeded
   * event re-reads the pool standings and re-promotes the qualifiers (the pool
   * may have been edited, and a qualifier may have withdrawn since), a doubles
   * event re-runs assertNobodyLeftUnpaired, the whole drawn field is re-tested
   * for event-waiver signatures, and an unseeded field is re-seeded by rating.
   * That re-checking is the point: the reason to redraw is usually that the
   * field is not what it was.
   */
  async function handleRegenerate() {
    // Reset before every open — the ref outlives the dialog, and `hasThirdPlace`
    // may have changed since the last one.
    regenThirdPlace.current = hasThirdPlace;

    const ok = await confirm({
      title: `Regenerate the ${eventLabel} draw?`,
      message: (
        <div className="space-y-3">
          <p>
            The {totalMatches === 1 ? 'one match' : `${totalMatches} matches`} in the current draw
            {' '}are deleted and a new draw is built from the {totalEntries === 1 ? 'entry' : `${totalEntries} entries`}
            {' '}in the event right now. Match numbers, courts and who plays whom all change, so anyone
            who has already been told their first-round opponent will have the wrong one.
          </p>
          <p>
            Everyone in the new draw is notified that the bracket has been published, again.
            {seededFromPool && ' The field is re-read from the pool standings, so a pool result edited since the first draw is picked up.'}
            {' '}Nothing that has been played is touched: if any result has been entered, this is refused
            rather than done.
          </p>
          {thirdPlaceApplies && (
            <ThirdPlaceChoice
              defaultChecked={hasThirdPlace}
              onChange={(v) => { regenThirdPlace.current = v; }}
            />
          )}
        </div>
      ),
      confirmLabel: 'Regenerate draw',
      danger: true,
    });
    if (!ok) return;

    setRegenLoading(true);
    // Dispatched on format exactly as handleAction does — a round robin sitting
    // at bracket_generated has its own delete-and-rebuild and no playoff.
    const res = format === 'round_robin'
      ? await generateRoundRobinMatches(event.id as string)
      // Same reasoning as the check-in press: `thirdPlaceApplies` gates the
      // CHECKBOX, not the request, and createThirdPlaceMatch skips a draw with
      // no semi-final round rather than refusing the whole generation.
      : await generateSingleEliminationBracket(event.id as string, thirdPlaceApplies && regenThirdPlace.current);
    if (!res.ok) { toast(res.error, 'error'); setRegenLoading(false); return; }
    toast('Draw regenerated', 'success');
    router.refresh();
    setRegenLoading(false);
  }

  const actionLabel: Record<string, string> = {
    registration: 'Open Check-In',
    checkin: 'Generate Bracket',
    bracket_generated: 'Start Tournament',
    live: 'Finalize Tournament',
  };

  // A pool-seeded event usually has NOBODY entered yet — its field arrives at
  // generation, promoted from the pool. Gating on checked-in entries would make
  // the one button that can fill it permanently unpressable.
  const actionDisabled =
    (status === 'checkin' && checkedIn < 2 && !seededFromPool)
    // Finalizing refuses unless every match is decided (finalize.ts), and it
    // refused AFTER the click — an exec pressed the one obvious button at the
    // end of an event and got an error for a state the page already knew about.
    // totalMatches/completedMatches are already props, so the button can say so
    // before it is pressed rather than after.
    || (status === 'live' && completedMatches < totalMatches);

  // Why it is disabled, not just that it is. "Finalize" greyed with no reason
  // sends someone hunting through the bracket for what is missing.
  const actionHint =
    status === 'checkin' && checkedIn < 2 && !seededFromPool
      ? 'At least two players must be checked in'
      : status === 'live' && completedMatches < totalMatches
        ? `${totalMatches - completedMatches} match${totalMatches - completedMatches === 1 ? '' : 'es'} still to be decided`
        : undefined;

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

        {/* items-start, because the children are not the same shape. Lock Draw
            is a bare Button; Regenerate and the primary action are each a column
            of button-plus-hint. Flex stretches by default, so the bare button
            grew to the height of a neighbour's button AND its caption — which is
            why Lock Draw stood taller than Finalize Tournament with a gap of
            dead border underneath it. */}
        <div className="flex items-start gap-2">
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
          {/* SECONDARY WEIGHT, DELIBERATELY. It sits in the same ghost row as
              Lock Draw and never competes with the primary button — starting the
              tournament stays the obvious next step, and redrawing is the thing
              you go looking for. */}
          {regenerate.show && (
            <div className="flex flex-col items-end gap-1">
              <Button
                variant="ghost"
                size="sm"
                loading={regenLoading}
                disabled={regenerate.blockedReason !== null}
                aria-label={`Regenerate the ${eventLabel} draw`}
                // describedby rather than title, for the same reason the primary
                // button uses it: a title attribute wins the accessible name
                // computation and the button would announce as its own excuse.
                aria-describedby={regenerate.blockedReason ? 'regenerate-draw-hint' : undefined}
                className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
                onClick={handleRegenerate}
              >
                <RefreshCw className="w-4 h-4 mr-1" />
                Regenerate Draw
              </Button>
              {regenerate.blockedReason && (
                <p id="regenerate-draw-hint" className="text-xs text-[var(--text-muted)] max-w-[15rem] text-right">
                  {regenerate.blockedReason}
                </p>
              )}
            </div>
          )}
          {status !== 'completed' && (
            <div className="flex flex-col items-end gap-1">
              <Button
                onClick={handleAction}
                loading={loading}
                disabled={actionDisabled}
                // describedby, NOT title: a title attribute won the accessible
                // name computation, so the button announced as "11 matches still
                // to be decided" and lost "Finalize Tournament" — the action it
                // performs. The reason is already on screen below, so point at
                // that instead and it is announced as a description.
                aria-describedby={actionHint ? 'event-action-hint' : undefined}
                className="focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
              >
                {actionLabel[status] ?? 'Next Step'}
              </Button>
              {actionHint && (
                <p id="event-action-hint" className="text-xs text-[var(--text-muted)] max-w-[15rem] text-right">{actionHint}</p>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Third-place playoff — a generation-time choice, so it sits with the
          button that acts on it rather than in Event Settings, which is about
          the event's format and stays editable for a different window. */}
      {offerThirdPlace && (
        <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2.5">
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={thirdPlace}
              onChange={(e) => setThirdPlace(e.target.checked)}
              className="mt-0.5 accent-[var(--color-accent)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
            />
            <span>
              <span className="text-sm font-medium text-[var(--text-primary)] block">
                Include a 3rd place playoff
              </span>
              <span className="text-xs text-[var(--text-muted)]">
                The two semi-final losers play for 3rd, scheduled alongside the final. It is a rated match
                like any other, and it needs a court. Without it both semi-finalists finish joint 3rd.
              </span>
            </span>
          </label>
        </div>
      )}

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
          value={format === 'round_robin' ? `${totalEntries} entries` : `${bracketSize}-slot${byes > 0 ? ` (${byes} skip${byes > 1 ? 's' : ''})` : ''}`}
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

/**
 * The third-place tick box, asked again at the moment of regenerating.
 *
 * THE CHOICE HAS TO BE MADE HERE, not inherited. It is not stored on the event —
 * the generated match IS the record — so a regenerate that reused the header's
 * `thirdPlace` state would have silently DROPPED the playoff every time
 * (`offerThirdPlace` is false outside `checkin`, so the flag passed would be
 * false), and one that hard-coded the new default ON would silently ADD one to
 * every draw that had deliberately gone without. Neither is a choice anybody
 * made. So it is pre-ticked from the draw that exists and shown where the exec
 * can see it before they agree.
 *
 * ITS OWN COMPONENT, WITH ITS OWN STATE, because ConfirmProvider stores the
 * message element it was handed: an input controlled by EventHeader's state
 * would never repaint inside the dialog. This one repaints itself and reports
 * out through onChange.
 */
function ThirdPlaceChoice({ defaultChecked, onChange }: { defaultChecked: boolean; onChange: (v: boolean) => void }) {
  const [checked, setChecked] = useState(defaultChecked);
  return (
    <label className="flex items-start gap-2.5 cursor-pointer rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] px-3 py-2.5">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => { setChecked(e.target.checked); onChange(e.target.checked); }}
        className="mt-0.5 accent-[var(--color-accent)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
      />
      <span>
        <span className="text-sm font-medium text-[var(--text-primary)] block">
          Include a 3rd place playoff
        </span>
        <span className="text-xs text-[var(--text-muted)]">
          {defaultChecked
            ? 'The current draw has one. Untick to redraw without it.'
            : 'The current draw does not have one. Tick to add it to the new draw.'}
          {' '}The two semi-final losers play for 3rd, scheduled alongside the final. It is a rated
          match like any other, and it needs a court.
        </span>
      </span>
    </label>
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
