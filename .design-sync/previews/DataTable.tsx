import React from 'react';
import { AvatarChip, Badge, DataTable } from '@badminton/ui';

type LeaderRow = {
  id: string;
  rank: number;
  player: string;
  elo: number;
  record: string;
  streak: string;
  [key: string]: unknown;
};

const leaders: LeaderRow[] = [
  { id: 'p1', rank: 1, player: 'Jordan Lee', elo: 1287, record: '31-6', streak: 'W5' },
  { id: 'p2', rank: 2, player: 'Priya Patel', elo: 1184, record: '26-9', streak: 'W2' },
  { id: 'p3', rank: 3, player: 'Marcus Wong', elo: 1102, record: '22-11', streak: 'L1' },
  { id: 'p4', rank: 4, player: 'Aiko Tanaka', elo: 1058, record: '19-12', streak: 'W1' },
  { id: 'p5', rank: 5, player: 'Sam Osei', elo: 987, record: '15-14', streak: 'L3' },
];

export function Leaderboard() {
  return (
    <div style={{ maxWidth: 560 }}>
      <DataTable<LeaderRow>
        keyField="id"
        data={leaders}
        onRowClick={() => {}}
        columns={[
          { key: 'rank', header: '#', className: 'w-10' },
          {
            key: 'player',
            header: 'Player',
            render: (r) => (
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8 }}>
                <AvatarChip name={r.player} size="xs" />
                <span style={{ fontWeight: 600 }}>{r.player}</span>
              </span>
            ),
          },
          { key: 'elo', header: 'ELO' },
          { key: 'record', header: 'W-L' },
          {
            key: 'streak',
            header: 'Streak',
            render: (r) => (
              <Badge variant={r.streak.startsWith('W') ? 'success' : 'danger'}>{r.streak}</Badge>
            ),
          },
        ]}
      />
    </div>
  );
}

export function EmptyTable() {
  return (
    <div style={{ maxWidth: 560 }}>
      <DataTable<LeaderRow>
        keyField="id"
        data={[]}
        emptyMessage="No matches recorded this season"
        columns={[
          { key: 'rank', header: '#' },
          { key: 'player', header: 'Player' },
          { key: 'elo', header: 'ELO' },
        ]}
      />
    </div>
  );
}
