import React from 'react';
import { Badge, Button, DataRow, Section } from '@badminton/ui';

export function ChallengesSection() {
  return (
    <div style={{ maxWidth: 460 }}>
      <Section
        title="Incoming challenges"
        sub="Respond within 48 hours"
        trailing={<Badge variant="danger">2 new</Badge>}
      >
        <DataRow
          accent
          title="Alex Tran challenged you"
          sub="Singles · best of 3 · Thu 7 PM"
          trailing={<Button size="sm">Accept</Button>}
        />
        <DataRow
          title="Priya Sharma challenged you"
          sub="Doubles w/ partner · Sun 2 PM"
          trailing={<Button size="sm" variant="ghost">View</Button>}
        />
      </Section>
    </div>
  );
}

export function SettingsGroup() {
  return (
    <div style={{ maxWidth: 460 }}>
      <Section title="Club settings" sub="Visible to execs only">
        <DataRow title="Season" sub="Fall 2026 · Sep 8 – Dec 4" trailing={<Badge>Active</Badge>} />
        <DataRow title="Drop-in fee" sub="$5 per session" />
        <DataRow title="Venue" sub="Lorne Davies Complex" dim />
      </Section>
    </div>
  );
}

export function FlushSection() {
  return (
    <div style={{ maxWidth: 460 }}>
      <Section
        title="Top of the ladder"
        sub="Singles · Week 6"
        trailing={<Badge variant="neutral">48 players</Badge>}
        flush
        stack={false}
      >
        {[
          ['1', 'Matthew Cheng', '612'],
          ['2', 'Alex Tran', '598'],
          ['3', 'Priya Sharma', '571'],
        ].map(([rank, name, elo], i) => (
          <div
            key={rank}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 14,
              padding: '12px 20px',
              borderTop: i === 0 ? 'none' : '1px solid var(--line)',
              fontSize: 14,
            }}
          >
            <span style={{ fontFamily: 'var(--font-mono), monospace', color: 'var(--text-muted)', width: 18 }}>
              {rank}
            </span>
            <span style={{ color: 'var(--text-primary)', fontWeight: 500, flex: 1 }}>{name}</span>
            <span style={{ fontFamily: 'var(--font-mono), monospace', color: 'var(--text-primary)' }}>{elo}</span>
          </div>
        ))}
      </Section>
    </div>
  );
}
