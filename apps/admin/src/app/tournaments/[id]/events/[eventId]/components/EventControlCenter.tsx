'use client';

import { useState } from 'react';
import { Badge } from '@badminton/ui';
import {
  TOURNAMENT_EVENT_TYPE_LABELS,
  TOURNAMENT_EVENT_STATUS_LABELS,
  TOURNAMENT_EVENT_STATUS_COLORS,
  isPlayedMatch,
  isPoolToBracket,
  playsRoundRobin,
  endsInKnockout,
  eventHasDraw,
  currentPhase,
} from '@badminton/shared';
import type {
  TournamentEventType,
  TournamentEventStatus,
  TournamentBonusSettings,
  EventWaiverStatus,
} from '@badminton/shared';
import { Trophy, Users, CheckCircle, BarChart3, Settings, Swords, ListOrdered, Pause } from 'lucide-react';
import type {
  TournamentRow,
  TournamentEventRow,
  TournamentMatchRow,
  ParticipantWithPlayer,
  PairWithPlayers,
} from '@/lib/tournament-types';
import type { SiblingEvent } from '../../../event-format-fields';
import type { DrawCapabilities } from '@/lib/participant-controls';
import { hasResultsTab } from '@/lib/event-tabs';
import { EventHeader } from './EventHeader';
import { ParticipantsTab } from './ParticipantsTab';
import { CheckInTab } from './CheckInTab';
import { BracketTab } from './BracketTab';
import { RoundRobinTab } from './RoundRobinTab';
import { ResultsTab } from './ResultsTab';
import { LeaderboardTab } from './LeaderboardTab';

// 'pool' is a tab of its own rather than a mode of 'bracket' (00107). On a
// pool_to_bracket event BOTH halves exist at once from the moment the knockout
// is drawn, and they are different things to look at: the pool is a table and a
// fixture list, the bracket is a tree. One tab that switched between them would
// hide half the event behind a control, and would have no answer for the exec
// who wants the standings open while entering a quarter-final.
type TabId = 'participants' | 'checkin' | 'pool' | 'bracket' | 'results' | 'leaderboard';

interface Props {
  tournament: TournamentRow;
  event: TournamentEventRow;
  participants: ParticipantWithPlayer[];
  pairs: PairWithPlayers[];
  matches: TournamentMatchRow[];
  // avatar_url feeds the searchable player picker; siblingEvents feeds the
  // pool-seeding picker. Both are pass-through.
  allPlayers: Array<{ id: string; full_name: string; avatar_url?: string | null }>;
  siblingEvents: SiblingEvent[];
  isDoubles: boolean;
  // Resolved from platform_settings on the server — client components cannot
  // read the table, so the Results tab gets it as a prop.
  //
  // `null` when the event is not `completed`, because that is the only status
  // with a Results tab and the page does not spend a round trip on a value
  // nothing can render. Never substituted with a default: the fallback constants
  // exist to keep a FAILED read from reading as "bonuses off", and using them
  // for a read that never happened would make that distinction meaningless.
  bonusSettings: TournamentBonusSettings | null;
  // What the viewer may DO on the participants tab, one flag per server action
  // behind a control. Resolved on the server for the same reason bonusSettings
  // is: a client component cannot ask the permission model anything.
  drawCapabilities: DrawCapabilities;
  // Event-waiver state per player id, resolved on the server because the
  // comparison needs a SHA-256 of the tournament's text and node:crypto cannot
  // run here. `null` means DO NOT SHOW THE COLUMN — either this tournament has
  // no waiver, or this viewer does not hold tournaments.draw.waivers.read. An
  // empty map would read as "nobody has signed", which is a different and much
  // more alarming claim.
  waiverStates: Record<string, EventWaiverStatus> | null;
}

export function EventControlCenter({ tournament, event, participants, pairs, matches, allPlayers, siblingEvents, isDoubles, bonusSettings, drawCapabilities, waiverStates }: Props) {
  const status = event.status as TournamentEventStatus;
  const eventType = event.event_type as TournamentEventType;
  const format = event.format;

  // Determine available tabs based on status
  const tabs: Array<{ id: TabId; label: string; icon: React.ReactNode }> = [
    { id: 'participants', label: 'Participants', icon: <Users className="w-4 h-4" /> },
  ];

  if (status !== 'registration') {
    tabs.push({ id: 'checkin', label: 'Check-In', icon: <CheckCircle className="w-4 h-4" /> });
  }

  // WHICH HALVES EXIST. A single-phase event has exactly one of these and it is
  // the one it always had; a pool_to_bracket event grows the second when its
  // knockout is drawn.
  const poolToBracket = isPoolToBracket(format);
  const poolMatches = poolToBracket ? matches.filter((m) => m.phase === 'pool') : matches;
  const bracketMatches = poolToBracket ? matches.filter((m) => m.phase === 'bracket') : matches;
  const hasDraw = eventHasDraw(status);

  if (hasDraw && playsRoundRobin(format)) {
    tabs.push({
      id: 'pool',
      label: poolToBracket ? 'Round Robin' : 'Round Robin',
      icon: <Swords className="w-4 h-4" />,
    });
  }
  // The knockout tab appears only once there is a knockout. On a
  // pool_to_bracket event that is a real distinction: the pool is drawn and
  // played first, and offering an empty Bracket tab through all of it would
  // invite an exec to go looking for a draw that deliberately does not exist yet.
  if (hasDraw && endsInKnockout(format) && (!poolToBracket || bracketMatches.length > 0)) {
    tabs.push({ id: 'bracket', label: 'Bracket', icon: <Swords className="w-4 h-4" /> });
  }

  // hasResultsTab() rather than a second `status === 'completed'`: the event
  // page decides whether to fetch the bonus settings from the same predicate,
  // and the two must not be able to drift apart. Leaderboard needs nothing from
  // platform_settings, so it keeps its own condition.
  if (hasResultsTab(status)) {
    tabs.push({ id: 'results', label: 'Results', icon: <BarChart3 className="w-4 h-4" /> });
  }

  if (status === 'completed') {
    tabs.push({ id: 'leaderboard', label: 'Leaderboard', icon: <ListOrdered className="w-4 h-4" /> });
  }

  // Default to the most relevant tab
  // The half that is CURRENT, not a fixed tab id — an exec opening a
  // pool_to_bracket event mid-round-robin wants the round robin.
  const defaultTab: TabId = hasResultsTab(status) ? 'results'
    : ['pool_generated', 'pool_live'].includes(status) ? 'pool'
    : ['bracket_generated', 'live'].includes(status) ? (endsInKnockout(format) ? 'bracket' : 'pool')
    : status === 'checkin' ? 'checkin'
    : 'participants';

  const [activeTab, setActiveTab] = useState<TabId>(defaultTab);

  // Stats
  const entries: Array<ParticipantWithPlayer | PairWithPlayers> = isDoubles ? pairs : participants;
  const totalEntries = entries.length;
  const checkedIn = entries.filter((e) => e.status === 'checked_in').length;
  const totalMatches = matches.length;
  const completedMatches = matches.filter((m) =>
    m.status === 'completed' || m.status === 'walkover' || m.is_bye
  ).length;
  // A SECOND, NARROWER COUNT, and the two must not be merged. `completedMatches`
  // above is the PROGRESS figure — how many slots no longer need a court — so it
  // counts byes, which is right for "11/15 matches" and for greying Finalize.
  // `playedMatches` is how many matches somebody actually PLAYED, which is the
  // question the redraw asks: rebuilding the draw deletes every match, and a bye
  // has no score and no Elo to lose. Gating the redraw on the progress figure
  // would grey the button on every draw whose field is not a power of two.
  //
  // COUNTED WITHIN THE CURRENT PHASE (00107). The redraw rebuilds one half, and
  // assertNoResultsEntered refuses on that half's results only — so a
  // pool_to_bracket event arriving at its knockout with a fully played pool
  // must NOT show "9 matches have been played, void them first" against a
  // Regenerate button that would not touch any of them. currentPhase is null
  // for the other two formats, where this is the whole event exactly as before.
  const phaseNow = currentPhase(format, status);
  const phaseMatches = phaseNow === 'pool' ? poolMatches : phaseNow === 'bracket' ? bracketMatches : matches;
  const playedMatches = phaseMatches.filter(isPlayedMatch).length;

  return (
    <div className="space-y-6">
      {/* Event Header */}
      <EventHeader
        tournament={tournament}
        event={event}
        siblingEvents={siblingEvents}
        isDoubles={isDoubles}
        totalEntries={totalEntries}
        checkedIn={checkedIn}
        totalMatches={totalMatches}
        completedMatches={completedMatches}
        playedMatches={playedMatches}
        // How many matches the REDRAW would actually replace — the current
        // phase's, not the event's. The confirm dialog names this number, and
        // on a pool_to_bracket event "the 18 matches in the current draw are
        // deleted" would be a false and alarming claim about a knockout of 3.
        phaseMatches={phaseMatches.length}
        // The POOL's own progress, which is what decides whether the knockout
        // can be drawn yet. Equal to the whole event on the other two formats,
        // where nothing reads it.
        poolTotal={poolMatches.length}
        poolDecided={poolMatches.filter((m) => m.status === 'completed' || m.status === 'walkover' || m.is_bye).length}
        drawCapabilities={drawCapabilities}
        // WHETHER THE DRAW THAT EXISTS HAS A BRONZE MATCH, read off the matches
        // themselves. The third-place choice is deliberately not stored on
        // tournament_events — the generated match IS the record — so this is
        // the only truthful source, and it is what the Regenerate confirm
        // pre-ticks its checkbox from. Without it a regenerate would silently
        // drop the playoff (EventHeader's `offerThirdPlace` is false outside
        // `checkin`) or silently add one, which is the same defect from the
        // other side.
        hasThirdPlace={bracketMatches.some((m) => m.is_third_place)}
      />

      {/* Suspension Banner — server actions enforce the actual blocking */}
      {tournament.suspended_at && (
        <div className="rounded-xl border border-[var(--color-accent)]/30 bg-[var(--color-accent)]/5 p-4 flex items-start gap-3" role="status">
          <Pause className="w-4 h-4 text-[var(--color-accent)] mt-0.5 shrink-0" />
          <div>
            <p className="text-sm font-medium text-[var(--text-primary)]">This tournament is suspended — actions are paused until it is resumed.</p>
            {tournament.suspension_reason && (
              <p className="text-sm text-[var(--text-muted)] mt-1">{tournament.suspension_reason}</p>
            )}
          </div>
        </div>
      )}

      {/* Tab Navigation */}
      <div className="overflow-x-auto -mx-1 px-1">
        <div className="flex gap-1 p-1 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border)] min-w-fit" role="tablist" aria-label="Event sections">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              aria-label={tab.label}
              aria-selected={activeTab === tab.id}
              role="tab"
              className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all whitespace-nowrap focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none ${
                activeTab === tab.id
                  ? 'bg-[var(--color-accent)] text-white shadow-sm'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-card)]'
              }`}
            >
              {tab.icon}
              <span className="hidden sm:inline">{tab.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* Tab Content */}
      <div role="tabpanel" aria-label={`${activeTab} tab content`}>
        {activeTab === 'participants' && (
          <ParticipantsTab
            event={event}
            participants={participants}
            pairs={pairs}
            allPlayers={allPlayers}
            isDoubles={isDoubles}
            capabilities={drawCapabilities}
            waiverStates={waiverStates}
          />
        )}
        {activeTab === 'checkin' && (
          <CheckInTab
            event={event}
            participants={participants}
            pairs={pairs}
            isDoubles={isDoubles}
            waiverStates={waiverStates}
          />
        )}
        {activeTab === 'pool' && (
          <RoundRobinTab
            event={event}
            matches={poolMatches}
            participants={participants}
            pairs={pairs}
            isDoubles={isDoubles}
            phase={poolToBracket ? 'pool' : null}
          />
        )}
        {activeTab === 'bracket' && (
          <BracketTab
            event={event}
            matches={bracketMatches}
            participants={participants}
            pairs={pairs}
            isDoubles={isDoubles}
            phase={poolToBracket ? 'bracket' : null}
          />
        )}
        {/* Both conditions say the same thing — the tab only exists at
            `completed` and that is the only status the settings are fetched for
            — but the null check is what makes it true by construction rather
            than by two lists agreeing. */}
        {activeTab === 'results' && bonusSettings && (
          <ResultsTab
            event={event}
            participants={participants}
            pairs={pairs}
            matches={matches}
            isDoubles={isDoubles}
            bonusSettings={bonusSettings}
          />
        )}
        {activeTab === 'leaderboard' && (
          <LeaderboardTab
            event={event}
            participants={participants}
            pairs={pairs}
            isDoubles={isDoubles}
          />
        )}
      </div>
    </div>
  );
}
