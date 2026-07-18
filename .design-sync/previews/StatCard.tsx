import React from 'react';
import { StatCard } from '@badminton/ui';

export function EloStats() {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 16 }}>
      <StatCard label="Singles ELO" value={612} change="+24 this week" changeType="positive" />
      <StatCard label="Doubles ELO" value={548} change="-12 this week" changeType="negative" />
      <StatCard label="Win rate" value="64%" change="25 matches" changeType="neutral" />
    </div>
  );
}

export function Single() {
  return (
    <div style={{ maxWidth: 260 }}>
      <StatCard label="Season income" value="$1,240.00" change="82 fees collected" changeType="neutral" />
    </div>
  );
}
