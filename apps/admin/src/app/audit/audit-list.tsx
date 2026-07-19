'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { Badge } from '@badminton/ui';
import { formatDateTime } from '@badminton/shared';
import { User } from 'lucide-react';

export interface AuditLogRow {
  id: string;
  created_at: string;
  action_type: string;
  target_type: string | null;
  target_id: string | null;
  reason: string | null;
  actor: { full_name: string } | null;
}

const actionCategory = (action: string): 'success' | 'danger' | 'warning' | 'info' | 'neutral' => {
  if (action.includes('created') || action.includes('added')) return 'success';
  if (action.includes('voided') || action.includes('removed') || action.includes('rejected')) return 'danger';
  if (action.includes('expired') || action.includes('ended') || action.includes('closed')) return 'warning';
  if (action.includes('updated') || action.includes('changed') || action.includes('converted')) return 'info';
  return 'neutral';
};

// Explicit target_type → filter-bucket mapping. Core buckets always render as
// chips; extras only appear when present in the fetched rows.
const TARGET_BUCKETS: Record<string, string> = {
  player: 'players',
  rating: 'players',
  match: 'matches',
  walkover: 'matches',
  challenge: 'matches',
  dispute: 'disputes',
  session: 'sessions',
  session_attendance: 'sessions',
  platform_setting: 'settings',
  legal_document: 'settings',
  passkey_credential: 'settings',
  season: 'seasons',
  tournament: 'tournaments',
  tournament_fee: 'tournaments',
  tournament_fee_tier: 'tournaments',
  club_fee: 'fees',
  announcement: 'announcements',
};

const CORE_BUCKETS = ['players', 'matches', 'disputes', 'sessions', 'settings'];
const EXTRA_BUCKETS = ['seasons', 'tournaments', 'fees', 'announcements', 'other'];

const bucketOf = (log: AuditLogRow) => TARGET_BUCKETS[log.target_type ?? ''] ?? 'other';

const actorName = (log: AuditLogRow) => log.actor?.full_name ?? 'System';

type SortKey = 'newest' | 'oldest' | 'action' | 'admin';

const SORT_OPTIONS: { value: SortKey; label: string }[] = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'action', label: 'Action A–Z' },
  { value: 'admin', label: 'Admin A–Z' },
];

export function AuditList({ logs }: { logs: AuditLogRow[] }) {
  const router = useRouter();
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState<SortKey>('newest');

  // Auto-refresh: router.refresh() re-runs the server fetch without resetting
  // client filter/sort state. Skipped while the tab is hidden.
  useEffect(() => {
    const id = setInterval(() => {
      if (!document.hidden) router.refresh();
    }, 30_000);
    return () => clearInterval(id);
  }, [router]);

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: logs.length };
    for (const log of logs) {
      const bucket = bucketOf(log);
      c[bucket] = (c[bucket] ?? 0) + 1;
    }
    return c;
  }, [logs]);

  const chips = [
    'all',
    ...CORE_BUCKETS,
    ...EXTRA_BUCKETS.filter((b) => (counts[b] ?? 0) > 0),
  ];

  const rows = useMemo(() => {
    const filtered = filter === 'all' ? logs : logs.filter((log) => bucketOf(log) === filter);
    const sorted = [...filtered];
    switch (sort) {
      case 'oldest':
        sorted.sort((a, b) => a.created_at.localeCompare(b.created_at));
        break;
      case 'action':
        sorted.sort((a, b) => a.action_type.localeCompare(b.action_type));
        break;
      case 'admin':
        sorted.sort((a, b) => actorName(a).localeCompare(actorName(b)));
        break;
      default:
        sorted.sort((a, b) => b.created_at.localeCompare(a.created_at));
    }
    return sorted;
  }, [logs, filter, sort]);

  return (
    <div>
      {/* Filter band — hairline-bounded chips + sort + auto-refresh */}
      <div className="flex flex-wrap items-center gap-2 border-y border-[var(--border)] py-3">
        {chips.map((bucket) => {
          const active = filter === bucket;
          return (
            <button
              key={bucket}
              type="button"
              onClick={() => setFilter(bucket)}
              className={`flex items-center gap-1.5 border px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.12em] transition-colors ${
                active
                  ? 'border-[var(--color-accent)] text-[var(--color-accent)]'
                  : 'border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--border-hover)] hover:text-[var(--text-primary)]'
              }`}
            >
              {bucket}
              <span className={active ? 'opacity-60' : 'text-[var(--text-muted)]'}>
                {counts[bucket] ?? 0}
              </span>
            </button>
          );
        })}
        <div className="ml-auto flex items-center gap-4">
          <select
            aria-label="Sort audit entries"
            value={sort}
            onChange={(e) => setSort(e.target.value as SortKey)}
            className="border border-[var(--border)] bg-[var(--bg-primary)] px-2.5 py-1.5 text-xs text-[var(--text-secondary)] focus:outline-none focus:border-[var(--border-hover)]"
          >
            {SORT_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
          <span className="whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--text-muted)]">
            Auto-refresh · 30s
          </span>
        </div>
      </div>

      {/* Table — hairline dividers, no card chrome */}
      <div className="overflow-x-auto">
        <table className="w-full">
          <thead>
            <tr className="border-b border-[var(--border)]">
              <th className="px-4 py-3 text-left font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--text-muted)]">Time</th>
              <th className="px-4 py-3 text-left font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--text-muted)]">Actor</th>
              <th className="px-4 py-3 text-left font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--text-muted)]">Action</th>
              <th className="px-4 py-3 text-left font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--text-muted)]">Target</th>
              <th className="px-4 py-3 text-left font-mono text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--text-muted)]">Reason</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-[var(--border)]">
            {rows.map((log) => (
              <tr key={log.id} className="hover:bg-white/[0.03] transition-colors">
                <td className="px-4 py-3.5 whitespace-nowrap font-mono text-xs text-[var(--text-muted)]">
                  {formatDateTime(log.created_at)}
                </td>
                <td className="px-4 py-3.5 text-sm text-[var(--text-primary)]">
                  <div className="flex items-center gap-2">
                    <User className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                    {log.actor?.full_name || <span className="text-[var(--text-muted)] italic">System</span>}
                  </div>
                </td>
                <td className="px-4 py-3.5">
                  <Badge variant={actionCategory(log.action_type)}>{log.action_type.replace(/_/g, ' ')}</Badge>
                </td>
                <td className="px-4 py-3.5 text-sm text-[var(--text-secondary)]">
                  <span className="capitalize">{log.target_type}</span>
                  {log.target_id && (
                    <span className="ml-1.5 bg-[var(--border-hover)] px-1.5 py-0.5 font-mono text-xs text-[var(--text-muted)]">
                      {String(log.target_id).slice(0, 8)}
                    </span>
                  )}
                </td>
                <td className="max-w-xs truncate px-4 py-3.5 text-sm text-[var(--text-muted)]">
                  {log.reason || <span className="opacity-40">-</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <p className="border-b border-[var(--border)] py-10 text-center text-sm text-[var(--text-muted)]">
            No audit entries.
          </p>
        )}
      </div>
    </div>
  );
}
