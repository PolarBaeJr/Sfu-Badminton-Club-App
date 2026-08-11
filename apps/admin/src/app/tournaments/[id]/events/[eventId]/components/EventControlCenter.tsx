'use client';

import { useState } from 'react';
import { Badge } from '@badminton/ui';
import {
  TOURNAMENT_EVENT_TYPE_LABELS,
  TOURNAMENT_EVENT_STATUS_LABELS,
  TOURNAMENT_EVENT_STATUS_COLORS,
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
import { EventHeader } from './EventHeader';
import { ParticipantsTab } from './ParticipantsTab';
import { CheckInTab } from './CheckInTab';
import { BracketTab } from './BracketTab';
import { RoundRobinTab } from './RoundRobinTab';
import { ResultsTab } from './ResultsTab';
import { LeaderboardTab } from './LeaderboardTab';

type TabId = 'participants' | 'checkin' | 'bracket' | 'results' | 'leaderboard';

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
  bonusSettings: TournamentBonusSettings;
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

  if (['bracket_generated', 'live', 'completed'].includes(status)) {
    tabs.push({ id: 'bracket', label: format === 'round_robin' ? 'Round Robin' : 'Bracket', icon: <Swords className="w-4 h-4" /> });
  }

  if (status === 'completed') {
    tabs.push({ id: 'results', label: 'Results', icon: <BarChart3 className="w-4 h-4" /> });
    tabs.push({ id: 'leaderboard', label: 'Leaderboard', icon: <ListOrdered className="w-4 h-4" /> });
  }

  // Default to the most relevant tab
  const defaultTab: TabId = status === 'completed' ? 'results'
    : ['bracket_generated', 'live'].includes(status) ? 'bracket'
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
        {activeTab === 'bracket' && format === 'round_robin' && (
          <RoundRobinTab
            event={event}
            matches={matches}
            participants={participants}
            pairs={pairs}
            isDoubles={isDoubles}
          />
        )}
        {activeTab === 'bracket' && format !== 'round_robin' && (
          <BracketTab
            event={event}
            matches={matches}
            participants={participants}
            pairs={pairs}
            isDoubles={isDoubles}
          />
        )}
        {activeTab === 'results' && (
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
