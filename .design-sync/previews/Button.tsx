import React from 'react';
import { Button } from '@badminton/ui';

export function Variants() {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
      <Button variant="primary">Issue Challenge</Button>
      <Button variant="secondary">View bracket</Button>
      <Button variant="ghost">Cancel</Button>
      <Button variant="success">Confirm result</Button>
      <Button variant="danger">Withdraw</Button>
    </div>
  );
}

export function Sizes() {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
      <Button size="sm">Mark paid</Button>
      <Button size="md">Issue Challenge</Button>
      <Button size="lg">Sign in to play</Button>
    </div>
  );
}

export function States() {
  return (
    <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
      <Button loading>Saving…</Button>
      <Button disabled>Bracket locked</Button>
      <Button variant="ghost" disabled>
        Unavailable
      </Button>
    </div>
  );
}
