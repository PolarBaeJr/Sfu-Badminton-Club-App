import React from 'react';
import { Badge } from '@badminton/ui';

export function Variants() {
  return (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center' }}>
      <Badge variant="default">Comp team</Badge>
      <Badge variant="success">Paid</Badge>
      <Badge variant="warning">Fee due</Badge>
      <Badge variant="danger">Forfeit</Badge>
      <Badge variant="info">Checked in</Badge>
      <Badge variant="neutral">Rec drop-in</Badge>
    </div>
  );
}

export function InContext() {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10, maxWidth: 340 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>Priya Patel</span>
        <Badge variant="success">Paid · Spring 2026</Badge>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>Marcus Wong</span>
        <Badge variant="warning">Fee due</Badge>
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <span style={{ fontSize: 14, fontWeight: 600 }}>MD Bracket · Round of 16</span>
        <Badge variant="info">Live</Badge>
      </div>
    </div>
  );
}
