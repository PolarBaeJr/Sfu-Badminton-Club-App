'use client';

import { useState, useMemo } from 'react';

export interface AuditEntry {
  id: string;
  action_type: string;
  target_type: string;
  target_id: string | null;
  reason: string | null;
  created_at: string;
  actor_name: string;
  actor_role: string;
}

type Filter = 'all' | 'players' | 'matches' | 'disputes' | 'sessions' | 'settings';

const FILTER_TARGET: Record<Filter, string[]> = {
  all: [],
  players: ['player'],
  matches: ['match'],
  disputes: ['dispute'],
  sessions: ['session'],
  settings: ['platform_setting', 'setting'],
};

interface ClientProps {
  entries: AuditEntry[];
  counts: Record<Filter, number>;
}

export function AuditLogClient({ entries, counts }: ClientProps) {
  const [filter, setFilter] = useState<Filter>('all');

  const filtered = useMemo(() => {
    if (filter === 'all') return entries;
    const targets = FILTER_TARGET[filter];
    return entries.filter((e) => targets.includes(e.target_type));
  }, [entries, filter]);

  const chips: { id: Filter; label: string }[] = [
    { id: 'all', label: 'All' },
    { id: 'players', label: 'Players' },
    { id: 'matches', label: 'Matches' },
    { id: 'disputes', label: 'Disputes' },
    { id: 'sessions', label: 'Sessions' },
    { id: 'settings', label: 'Settings' },
  ];

  return (
    <>
      <div
        style={{
          display: 'flex',
          gap: 8,
          padding: '18px 48px',
          borderBottom: '1px solid var(--hairline)',
          alignItems: 'center',
          flexWrap: 'wrap',
        }}
      >
        {chips.map((c) => {
          const active = filter === c.id;
          return (
            <button
              key={c.id}
              type="button"
              onClick={() => setFilter(c.id)}
              style={{
                fontSize: 10,
                letterSpacing: '0.16em',
                textTransform: 'uppercase',
                fontWeight: 600,
                padding: '7px 12px',
                border: `1px solid ${active ? 'var(--red)' : 'var(--hairline)'}`,
                color: active ? 'var(--ink)' : 'var(--muted)',
                background: active ? 'rgba(204,0,0,0.06)' : 'transparent',
                cursor: 'pointer',
                fontFamily: 'inherit',
                transition: 'all 150ms ease-out',
              }}
            >
              {c.label}{' '}
              <span
                style={{
                  color: active ? 'var(--red)' : 'var(--faint)',
                  marginLeft: 6,
                }}
              >
                {counts[c.id]}
              </span>
            </button>
          );
        })}
        <span style={{ flex: 1 }} />
        <span
          style={{
            fontSize: 10,
            letterSpacing: '0.14em',
            textTransform: 'uppercase',
            color: 'var(--faint)',
            fontWeight: 600,
          }}
        >
          Auto-refresh · 30s
        </span>
      </div>

      <div style={{ background: 'var(--surface1)' }}>
        {filtered.length === 0 ? (
          <div
            style={{
              padding: '64px 48px',
              textAlign: 'center',
              color: 'var(--muted)',
              fontSize: 13,
            }}
          >
            No audit entries.
          </div>
        ) : (
          filtered.map((e) => {
            const action = inferAction(e.action_type);
            const desc = describeEntry(e);
            const { time, date } = formatTimestamp(e.created_at);
            return (
              <div
                key={e.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '140px 100px 1fr 160px',
                  gap: 24,
                  padding: '16px 48px',
                  borderBottom: '1px solid var(--hairline-soft)',
                  alignItems: 'center',
                }}
              >
                <div
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontWeight: 600,
                    color: 'var(--ink)',
                    fontVariantNumeric: 'tabular-nums',
                    fontSize: 13,
                  }}
                >
                  {time}
                  <span
                    style={{
                      display: 'block',
                      fontSize: 10,
                      color: 'var(--faint)',
                      fontWeight: 500,
                      letterSpacing: '0.06em',
                      marginTop: 2,
                    }}
                  >
                    {date}
                  </span>
                </div>
                <div>
                  <span style={actionStyle(action.tone)}>{action.label}</span>
                </div>
                <div style={{ fontSize: 13, color: 'var(--text)' }}>
                  {desc}
                </div>
                <div
                  style={{
                    fontSize: 12,
                    color: 'var(--muted)',
                    textAlign: 'right',
                  }}
                >
                  <span style={{ display: 'block', color: 'var(--ink)', fontWeight: 500 }}>
                    {e.actor_name}
                  </span>
                  {humanizeRole(e.actor_role)}
                </div>
              </div>
            );
          })
        )}
      </div>
    </>
  );
}

type ActionInfo = { label: string; tone: 'create' | 'update' | 'delete' | 'suspend' | 'resolve' };

function inferAction(actionType: string): ActionInfo {
  const t = (actionType ?? '').toLowerCase();
  if (t.includes('resolve')) return { label: 'Resolve', tone: 'resolve' };
  if (t.includes('suspend')) return { label: 'Suspend', tone: 'suspend' };
  if (t.includes('delete') || t.includes('remove') || t.includes('reject')) {
    return { label: 'Delete', tone: 'delete' };
  }
  if (t.includes('update') || t.includes('change') || t.includes('edit')) {
    return { label: 'Update', tone: 'update' };
  }
  return { label: 'Create', tone: 'create' };
}

function actionStyle(
  tone: 'create' | 'update' | 'delete' | 'suspend' | 'resolve'
): React.CSSProperties {
  const palette: Record<typeof tone, { c: string; bd: string }> = {
    create: { c: '#4ade80', bd: 'rgba(74,222,128,0.25)' },
    update: { c: '#eab308', bd: 'rgba(234,179,8,0.25)' },
    delete: { c: '#CC0000', bd: 'rgba(204,0,0,0.30)' },
    suspend: { c: '#CC0000', bd: 'rgba(204,0,0,0.30)' },
    resolve: { c: 'var(--ink)', bd: 'var(--hairline)' },
  };
  const p = palette[tone];
  return {
    fontSize: 10,
    letterSpacing: '0.16em',
    textTransform: 'uppercase',
    fontWeight: 700,
    padding: '4px 8px',
    border: `1px solid ${p.bd}`,
    color: p.c,
    display: 'inline-block',
  };
}

function describeEntry(e: AuditEntry): React.ReactNode {
  const target =
    e.target_type
      ? `${e.target_type.replace(/_/g, ' ')}${e.target_id ? ` ${shortId(e.target_id)}` : ''}`
      : 'event';
  return (
    <>
      <span style={{ color: 'var(--text)' }}>{capitalize(e.action_type.replace(/_/g, ' '))} </span>
      <span style={{ color: 'var(--ink)', fontWeight: 500 }}>{target}</span>
      {e.reason && <> — {e.reason}</>}
    </>
  );
}

function shortId(id: string): string {
  return `#${id.replace(/-/g, '').slice(-4).toUpperCase()}`;
}

function capitalize(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function humanizeRole(role: string): string {
  if (!role) return '';
  if (role === 'super_admin') return 'Owner';
  if (role === 'admin') return 'Admin';
  if (role === 'moderator') return 'Moderator';
  return capitalize(role);
}

function formatTimestamp(iso: string): { time: string; date: string } {
  try {
    const d = new Date(iso);
    const time = d.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const date = d.toLocaleDateString('en-US', { month: 'short', day: '2-digit', year: 'numeric' });
    return { time, date };
  } catch {
    return { time: iso, date: '' };
  }
}
