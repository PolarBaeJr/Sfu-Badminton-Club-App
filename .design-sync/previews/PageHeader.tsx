import React from 'react';
import { Button, PageHeader } from '@badminton/ui';

export function FullHeader() {
  return (
    <PageHeader
      eyebrow="Season 12 · Fall 2026"
      title="Leaderboard"
      sub="Singles and doubles ELO across 48 active players"
      actions={
        <>
          <Button variant="secondary" size="sm">
            Export CSV
          </Button>
          <Button size="sm">Issue Challenge</Button>
        </>
      }
    />
  );
}

export function TitleAndSub() {
  return (
    <PageHeader
      title="Tournaments"
      sub="Register for upcoming events or browse past brackets"
    />
  );
}

export function TitleOnly() {
  return <PageHeader title="My Stats" />;
}
