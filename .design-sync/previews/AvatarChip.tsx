import React from 'react';
import { AvatarChip } from '@badminton/ui';

export function Sizes() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
      <AvatarChip name="Jordan Lee" size="xs" />
      <AvatarChip name="Jordan Lee" size="sm" />
      <AvatarChip name="Jordan Lee" size="md" />
      <AvatarChip name="Jordan Lee" size="lg" />
      <AvatarChip name="Jordan Lee" size="xl" />
    </div>
  );
}

export function ToneScale() {
  const players = [
    'Jordan Lee',
    'Priya Patel',
    'Marcus Wong',
    'Aiko Tanaka',
    'Sam Osei',
    'Elena Petrova',
    'Diego Ramos',
  ];
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      {players.map((p, i) => (
        <AvatarChip key={p} name={p} size="md" tone={i + 1} />
      ))}
    </div>
  );
}

export function DeterministicById() {
  // Same rendering everywhere the same player id appears
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
      <AvatarChip name="Priya Patel" id="usr_9f31" size="md" />
      <AvatarChip name="Marcus Wong" id="usr_1c07" size="md" />
      <AvatarChip name="Aiko Tanaka" id="usr_44b2" size="md" />
      <AvatarChip name="Sam Osei" id="usr_a8d9" size="md" />
    </div>
  );
}

export function RingMarksYou() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
      <AvatarChip name="Jordan Lee" size="md" ring />
      <span className="mono muted" style={{ fontSize: 11 }}>
        ring marks &ldquo;you&rdquo; in lists
      </span>
    </div>
  );
}
