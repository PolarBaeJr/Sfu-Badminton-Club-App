import React from 'react';
import { Button, Card, EmptyState } from '@badminton/ui';

export function NoSessions() {
  return (
    <div style={{ maxWidth: 460 }}>
      <Card>
        <EmptyState
          title="No upcoming sessions"
          description="The Fall schedule hasn't been posted yet. Check back after Sep 1."
          action={<Button size="sm">View past sessions</Button>}
        />
      </Card>
    </div>
  );
}

export function NoResults() {
  return (
    <div style={{ maxWidth: 460 }}>
      <EmptyState
        title="No matches found"
        description='Nothing matches "smash club" — try a player name or event.'
      />
    </div>
  );
}

export function TitleOnly() {
  return (
    <div style={{ maxWidth: 460 }}>
      <EmptyState title="No pending challenges" />
    </div>
  );
}
