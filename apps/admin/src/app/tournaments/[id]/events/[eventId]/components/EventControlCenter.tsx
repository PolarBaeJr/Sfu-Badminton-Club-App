'use client';

import { useState } from 'react';
import { Badge } from '@badminton/ui';
import {
  TOURNAMENT_EVENT_TYPE_LABELS,
  TOURNAMENT_EVENT_STATUS_LABELS,
  TOURNAMENT_EVENT_STATUS_COLORS,
} from '@badminton/shared';
import type { TournamentEventType, TournamentEventStatus } from '@badminton/shared';
import { Trophy, Users, CheckCircle, BarChart3, Settings, Swords } from 'lucide-react';
import { EventHeader } from './EventHeader';
import { ParticipantsTab } from './ParticipantsTab';
import { CheckInTab } from './CheckInTab';
import { BracketTab } from './BracketTab';
import { RoundRobinTab } from './RoundRobinTab';
import { ResultsTab } from './ResultsTab';

type TabId = 'participants' | 'checkin' | 'bracket' | 'results';

interface Props {
  tournament: Record<string, unknown>;
  event: Record<string, unknown>;
  participants: unknown[];
  pairs: unknown[];
  matches: unknown[];
  allPlayers: Array<{ id: string; full_name: string }>;
  isDoubles: boolean;
}

export function EventControlCenter({ tournament, event, participants, pairs, matches, allPlayers, isDoubles }: Props) {
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
  const checkedIn = entries.filter((e: any) => e.status === 'checked_in').length;
  const totalMatches = (matches as any[]).length;
  const completedMatches = (matches as any[]).filter((m: any) =>
    m.status === 'completed' || m.status === 'walkover' || m.is_bye
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
      <div className="flex gap-1 p-1 rounded-xl bg-[var(--bg-elevated)] border border-[var(--border)]">
        {tabs.map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all ${
              activeTab === tab.id
                ? 'bg-[var(--color-accent)] text-white shadow-sm'
                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-card)]'
            }`}
          >
            {tab.icon}
            {tab.label}
          </button>
        ))}
      </div>

      {/* Tab Content */}
      <div>
        {activeTab === 'participants' && (
          <ParticipantsTab
            event={event}
            participants={participants}
            pairs={pairs}
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
      </div>
    </div>
  );
}
