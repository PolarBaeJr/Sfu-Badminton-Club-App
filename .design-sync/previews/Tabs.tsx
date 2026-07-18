import React from 'react';
import { Card, Tabs } from '@badminton/ui';

export function EventTabs() {
  return (
    <div style={{ maxWidth: 520 }}>
      <Tabs
        tabs={[
          { id: 'open-singles', label: 'Open Singles' },
          { id: 'open-doubles', label: 'Open Doubles' },
          { id: 'comp-singles', label: 'Comp Singles' },
        ]}
        activeTab="open-singles"
        onChange={() => {}}
      />
    </div>
  );
}

export function WithCounts() {
  return (
    <div style={{ maxWidth: 520 }}>
      <Tabs
        tabs={[
          { id: 'upcoming', label: 'Upcoming', count: 3 },
          { id: 'pending', label: 'Pending', count: 1 },
          { id: 'past', label: 'Past', count: 24 },
        ]}
        activeTab="pending"
        onChange={() => {}}
      />
    </div>
  );
}

export function WithPanel() {
  return (
    <div style={{ maxWidth: 520, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <Tabs
        tabs={[
          { id: 'registered', label: 'Registered', count: 12 },
          { id: 'waitlist', label: 'Waitlist', count: 4 },
        ]}
        activeTab="registered"
        onChange={() => {}}
      />
      <Card>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, fontSize: 14 }}>
          {[
            ['Matthew Cheng', 'Comp Singles'],
            ['Alex Tran', 'Open Doubles'],
            ['Priya Sharma', 'Open Singles'],
          ].map(([name, event]) => (
            <div key={name} style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{name}</span>
              <span style={{ color: 'var(--text-muted)' }}>{event}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
