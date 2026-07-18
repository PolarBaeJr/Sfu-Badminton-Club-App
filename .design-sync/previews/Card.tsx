import React from 'react';
import { Badge, Button, Card } from '@badminton/ui';

export function ScheduleCard() {
  return (
    <div style={{ maxWidth: 420 }}>
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <h3 style={{ fontWeight: 600, color: 'var(--text-primary)' }}>This week at Lorne Davies</h3>
          <Badge variant="success">Open</Badge>
        </div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          {[
            ['Tue Jul 21', '7:00–10:00 PM', 'Drop-in'],
            ['Thu Jul 23', '7:00–10:00 PM', 'Comp night'],
            ['Sun Jul 26', '2:00–5:00 PM', 'Drop-in'],
          ].map(([day, time, kind]) => (
            <div
              key={day}
              style={{ display: 'flex', justifyContent: 'space-between', gap: 12, fontSize: 14 }}
            >
              <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{day}</span>
              <span style={{ color: 'var(--text-muted)' }}>{time}</span>
              <span style={{ color: 'var(--text-muted)' }}>{kind}</span>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

export function ActionCard() {
  return (
    <div style={{ maxWidth: 420 }}>
      <Card>
        <h3 style={{ fontWeight: 600, color: 'var(--text-primary)', marginBottom: 4 }}>
          Fall term fees due
        </h3>
        <p style={{ fontSize: 14, color: 'var(--text-muted)', marginBottom: 16 }}>
          $40 comp membership covers all Thursday sessions through December.
        </p>
        <div style={{ display: 'flex', gap: 10 }}>
          <Button size="sm">Mark paid</Button>
          <Button size="sm" variant="ghost">
            Remind later
          </Button>
        </div>
      </Card>
    </div>
  );
}

export function FlushMedia() {
  return (
    <div style={{ maxWidth: 420 }}>
      <Card padding={false}>
        <div
          style={{
            padding: '14px 20px',
            borderBottom: '1px solid var(--border)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <span style={{ fontWeight: 600, color: 'var(--text-primary)' }}>Court assignments</span>
          <Badge variant="info">Live</Badge>
        </div>
        {[
          ['Court 1', 'M. Cheng / A. Tran'],
          ['Court 2', 'J. Park / S. Liu'],
          ['Court 3', 'Warm-up'],
        ].map(([court, who], i) => (
          <div
            key={court}
            style={{
              display: 'flex',
              justifyContent: 'space-between',
              padding: '12px 20px',
              fontSize: 14,
              borderTop: i === 0 ? 'none' : '1px solid var(--border)',
            }}
          >
            <span style={{ color: 'var(--text-primary)', fontWeight: 500 }}>{court}</span>
            <span style={{ color: 'var(--text-muted)' }}>{who}</span>
          </div>
        ))}
      </Card>
    </div>
  );
}
