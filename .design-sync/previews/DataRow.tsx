import React from 'react';
import { AvatarChip, Badge, DataRow } from '@badminton/ui';

export function ChallengeList() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 420 }}>
      <DataRow
        leading={<AvatarChip name="Priya Patel" size="md" />}
        title="Priya Patel challenged you"
        sub="Singles · ELO 1184 · expires in 2 days"
        trailing={<Badge variant="info">Pending</Badge>}
        onClick={() => {}}
      />
      <DataRow
        leading={<AvatarChip name="Marcus Wong" size="md" />}
        title="Marcus Wong"
        sub="Doubles partner · 12-4 together"
        trailing={<span className="mono muted" style={{ fontSize: 12 }}>&rsaquo;</span>}
        href="#"
      />
      <DataRow
        leading={<AvatarChip name="Aiko Tanaka" size="md" />}
        title="Aiko Tanaka"
        sub="Last played Jul 12 · won 21-17, 21-19"
        trailing={<Badge variant="success">W</Badge>}
      />
    </div>
  );
}

export function NotificationStates() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 420 }}>
      <DataRow
        accent
        leading={<AvatarChip name="Sam Osei" size="sm" />}
        title="Match result confirmed"
        sub="You beat Sam Osei 21-15, 18-21, 21-12 · +18 ELO"
      />
      <DataRow
        dim
        leading={<AvatarChip name="Elena Petrova" size="sm" />}
        title="Elena Petrova declined your challenge"
        sub="Jul 09 · read"
      />
    </div>
  );
}
