import React from 'react';
import { StatBlock } from '@badminton/ui';

export function StatGrid() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12, maxWidth: 520 }}>
      <StatBlock label="Singles ELO" value={1184} sub="K=24 · 67% win rate" />
      <StatBlock label="Doubles ELO" value={1058} sub="w/ Marcus Wong" />
      <StatBlock label="Matches" value={35} sub="26W · 9L this season" />
    </div>
  );
}

export function LargeHero() {
  return (
    <div style={{ maxWidth: 300 }}>
      <StatBlock label="Club rank" value="#2" large sub="of 148 active players" />
    </div>
  );
}

export function BareInline() {
  // card={false} — used when several stats share one parent card
  return (
    <div
      style={{
        display: 'flex',
        gap: 32,
        padding: '14px 18px',
        border: '1px solid var(--line)',
        borderRadius: 12,
        background: 'var(--surface)',
        maxWidth: 420,
      }}
    >
      <StatBlock card={false} label="Streak" value="W5" />
      <StatBlock card={false} label="Best win" value="+31" sub="vs Jordan Lee" />
      <StatBlock card={false} label="Attendance" value="92%" />
    </div>
  );
}
