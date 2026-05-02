'use client';

import { useState } from 'react';
import { Badge } from '@badminton/ui';
import {
  TOURNAMENT_EVENT_TYPE_LABELS,
  TOURNAMENT_EVENT_STATUS_LABELS,
  TOURNAMENT_EVENT_STATUS_COLORS,
} from '@badminton/shared';
import type { TournamentEventType, TournamentEventStatus } from '@badminton/shared';
import { Trophy, Users, CheckCircle, BarChart3, Settings, Swords, ListOrdered } from 'lucide-react';
import { EventHeader } from './EventHeader';
import { ParticipantsTab } from './ParticipantsTab';
import { CheckInTab } from './CheckInTab';
import { BracketTab } from './BracketTab';
import { RoundRobinTab } from './RoundRobinTab';
import { ResultsTab } from './ResultsTab';
import { LeaderboardTab } from './LeaderboardTab';
import type { TournamentAdminTabProps, TournamentMatch } from '@/app/tournaments/types';

type TabId = 'participants' | 'checkin' | 'bracket' | 'results' | 'leaderboard';

export function EventControlCenter({ tournament, event, participants, pairs, matches, allPlayers, isDoubles }: TournamentAdminTabProps) {
  const status = event.status as TournamentEventStatus;
  const eventType = event.event_type as TournamentEventType;
  const format = event.format as string;

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
  const entries = isDoubles ? pairs : participants;
  const totalEntries = entries.length;
  const checkedIn = entries.filter((e) => e.status === 'checked_in').length;
  const allMatches: TournamentMatch[] = matches ?? [];
  const totalMatches = allMatches.length;
  const completedMatches = allMatches.filter(
    (m) => m.status === 'completed' || m.status === 'walkover' || m.is_bye === true
  ).length;

  return (
    <div className="space-y-6">
      {/* Event Header */}
      <EventHeader
        tournament={tournament}
        event={event}
        isDoubles={isDoubles}
        totalEntries={totalEntries}
        checkedIn={checkedIn}
        totalMatches={totalMatches}
        completedMatches={completedMatches}
      />

      {/* Tab Navigation */}
      <div className="overflow-x-auto -mx-1 px-1">
        <div className="flex gap-1 p-1 bg-[var(--bg-elevated)] border border-[var(--border)] min-w-fit" role="tablist" aria-label="Event sections">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              aria-label={tab.label}
              aria-selected={activeTab === tab.id}
              role="tab"
              className={`flex items-center gap-2 px-4 py-2.5 text-sm font-medium transition-all whitespace-nowrap focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none ${
                activeTab === tab.id
                  ? 'bg-[var(--ds-accent)] text-white shadow-sm'
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
            tournament={tournament}
            event={event}
            participants={participants}
            pairs={pairs}
            matches={allMatches}
            allPlayers={allPlayers}
            isDoubles={isDoubles}
          />
        )}
        {activeTab === 'checkin' && (
          <CheckInTab
            event={event}
            participants={participants}
            pairs={pairs}
            isDoubles={isDoubles}
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
