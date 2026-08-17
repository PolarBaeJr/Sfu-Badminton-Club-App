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
import { CheckCircle, XCircle, Clock, Users, UserCheck } from 'lucide-react';
import { getName } from './entry-name';
import type { TournamentEventRow, ParticipantWithPlayer, PairWithPlayers } from '@/lib/tournament-types';
import type { EventWaiverStatus } from '@badminton/shared';
import { WaiverState, blocksCheckIn } from './WaiverState';

interface Props {
  event: TournamentEventRow;
  participants: ParticipantWithPlayer[];
  pairs: PairWithPlayers[];
  isDoubles: boolean;
  // null = draw no waiver state at all. See WaiverState.
  waiverStates: Record<string, EventWaiverStatus> | null;
}

/** Whose signature this entry needs — one person, or both halves of a pair. */
function entryPlayerIds(entry: ParticipantWithPlayer | PairWithPlayers, isDoubles: boolean): string[] {
  return isDoubles
    ? [(entry as PairWithPlayers).player1_id, (entry as PairWithPlayers).player2_id]
    : [(entry as ParticipantWithPlayer).player_id];
}

export function CheckInTab({ event, participants, pairs, isDoubles, waiverStates }: Props) {
  const [loading, setLoading] = useState<string | null>(null);
  const [bulkLoading, setBulkLoading] = useState(false);
  const { toast } = useToast();

  const entries: Array<ParticipantWithPlayer | PairWithPlayers> = isDoubles ? pairs : participants;
  // Keyed on checked_in_at, not status. status is a single enum, so
  // withdrawing OVERWRITES 'checked_in' and the person vanishes from this list
  // — but they did turn up, and the attendance record should say so. The
  // timestamp is never cleared, so it is the honest source for "was here".
  const checkedIn = entries.filter(e => e.checked_in_at != null);
  const notCheckedIn = entries.filter(e => e.status === 'registered');
  const noShows = entries.filter(e => e.status === 'no_show');
  const progress = entries.length > 0 ? (checkedIn.length / entries.length) * 100 : 0;
  // THE NUMBER THE DESK NEEDS BEFORE THE QUEUE FORMS. Check-in refuses an
  // entrant with no current event-waiver acceptance, so this is the count of
  // presses that are going to fail — surfaced up front rather than discovered
  // one refusal at a time.
  const waiverBlocked = notCheckedIn.filter(e => blocksCheckIn(waiverStates, entryPlayerIds(e, isDoubles)));

  async function handleCheckIn(id: string) {
    setLoading(id);
    try {
      // ActionResult, not a throw. These two now refuse an entrant with no
      // current event-waiver acceptance, and Next.js REDACTS an error thrown
      // out of a server action in production — so the one message that tells
      // the officer at the door what to do about it would arrive as "an error
      // occurred". Returned as a value, it arrives intact.
      const result = isDoubles ? await checkInPair(id) : await checkInParticipant(id);
      if (!result.ok) {
        toast(result.error, 'error');
        setLoading(null);
        return;
      }
      toast('Checked in', 'success');
      // No router.refresh() here. Every one of these actions ends in
      // revalidateEventPaths, and the App Router already ships the re-rendered
      // tree back in the action's own response — a refresh on top rendered this
      // page a SECOND time, and on a 100-player event that page is not cheap.
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
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(null);
  }

  async function handleBulkCheckIn() {
    setBulkLoading(true);
    try {
      const result = await bulkCheckIn(event.id, isDoubles ? 'pairs' : 'participants');
      if (!result.ok) {
        toast(result.error, 'error');
        setBulkLoading(false);
        return;
      }
      // PARTIAL SUCCESS IS THE NORMAL CASE NOW, and it has to read as one. The
      // action checks in everybody who may play and names the ones it could
      // not, so a plain "all present participants checked in" would be a lie
      // that leaves an unsigned entrant looking checked in to the exec who
      // pressed the button.
      const { checkedIn, skippedForWaiver } = result.data;
      if (skippedForWaiver) {
        toast(`${checkedIn} checked in. ${skippedForWaiver}`, 'error');
      } else {
        toast(`${checkedIn} checked in`, 'success');
      }
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
        {waiverBlocked.length > 0 && (
          <p className="mt-3 text-xs text-[var(--color-warning)]" role="status">
            <span className="sr-only">Warning: </span>
            {waiverBlocked.length} {waiverBlocked.length === 1 ? 'entry has' : 'entries have'} not accepted the
            event waiver and cannot be checked in. They must accept it themselves, signed in as themselves,
            from this tournament in the club app — nobody can do it for them.
            {' '}&ldquo;Check In All Present&rdquo; will take everyone else and tell you who it skipped.
          </p>
        )}
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
                waiverStates={waiverStates}
                actions={canCheckIn ? (
                  <div className="flex gap-1.5">
                    <Button
                      size="sm"
                      onClick={() => handleCheckIn(entry.id)}
                      loading={loading === entry.id}
                      className="bg-[var(--color-success)] hover:bg-[color-mix(in_oklab,var(--color-success)_80%,transparent)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
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
                waiverStates={waiverStates}
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
  waiverStates,
}: {
  entry: ParticipantWithPlayer | PairWithPlayers;
  isDoubles: boolean;
  checked?: boolean;
  dimmed?: boolean;
  actions?: React.ReactNode;
  waiverStates?: Record<string, EventWaiverStatus> | null;
}) {
  const name = getName(entry, isDoubles);

  return (
    <div
      className={`flex items-center justify-between p-3 rounded-lg border transition-colors ${
        checked
          ? 'bg-[color-mix(in_oklab,var(--color-success)_5%,transparent)] border-[color-mix(in_oklab,var(--color-success)_20%,transparent)]'
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
        <span className="min-w-0">
          <span className="block text-sm font-medium text-[var(--text-primary)]">{name}</span>
          {/* Under the name, the way /legal puts the signature line under a
              member's. On a pair this names the half that is holding it up. */}
          <WaiverState states={waiverStates ?? null} playerIds={entryPlayerIds(entry, isDoubles)} />
        </span>
      </div>
      {actions}
    </div>
  );
}
