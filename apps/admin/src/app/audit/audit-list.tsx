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
// options; extras only appear when present in the fetched rows.
const TARGET_BUCKETS: Record<string, string> = {
  player: 'players',
  rating: 'players',
  varsity_note: 'players',
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

type SortMode = 'newest' | 'oldest' | 'operator_asc' | 'operator_desc';

const SORT_OPTIONS: { value: SortMode; label: string }[] = [
  { value: 'newest', label: 'Newest first' },
  { value: 'oldest', label: 'Oldest first' },
  { value: 'operator_asc', label: 'Operator A–Z' },
  { value: 'operator_desc', label: 'Operator Z–A' },
];

export function AuditList({ logs }: { logs: AuditLogRow[] }) {
  const router = useRouter();
  const [filter, setFilter] = useState('all');
  const [sort, setSort] = useState<SortMode>('newest');

  // Auto-refresh: router.refresh() re-runs the server fetch without resetting
  // client filter state. Skipped while the tab is hidden.
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

  const buckets = [
    'all',
    ...CORE_BUCKETS,
    ...EXTRA_BUCKETS.filter((b) => (counts[b] ?? 0) > 0),
  ];

  const rows = useMemo(() => {
    const filtered = filter === 'all' ? logs : logs.filter((log) => bucketOf(log) === filter);
    return [...filtered].sort((a, b) => {
      if (sort === 'operator_asc' || sort === 'operator_desc') {
        const an = a.actor?.full_name ?? null;
        const bn = b.actor?.full_name ?? null;
        // Null actors ("System") always sort last, regardless of direction.
        if (an === null && bn === null) return b.created_at.localeCompare(a.created_at);
        if (an === null) return 1;
        if (bn === null) return -1;
        const cmp = an.localeCompare(bn, undefined, { sensitivity: 'base' });
        if (cmp !== 0) return sort === 'operator_asc' ? cmp : -cmp;
        return b.created_at.localeCompare(a.created_at);
      }
      return sort === 'oldest'
        ? a.created_at.localeCompare(b.created_at)
        : b.created_at.localeCompare(a.created_at);
    });
  }, [logs, filter, sort]);

  return (
    <div>
      {/* Filter band — hairline-bounded category select + auto-refresh */}
      <div className="flex flex-wrap items-center gap-2 border-y border-[var(--border)] py-3">
        <select
          aria-label="Filter audit entries by category"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          className="settings-input font-mono text-[11px] uppercase tracking-[0.12em]"
        >
          {buckets.map((bucket) => (
            <option key={bucket} value={bucket}>
              {bucket.toUpperCase()} ({counts[bucket] ?? 0})
            </option>
          ))}
        </select>
        <select
          aria-label="Sort audit entries"
          value={sort}
          onChange={(e) => setSort(e.target.value as SortMode)}
          className="settings-input ml-auto font-mono text-[11px] uppercase tracking-[0.12em]"
        >
          {SORT_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
        <span className="whitespace-nowrap font-mono text-[10px] uppercase tracking-[0.1em] text-[var(--text-muted)]">
          Auto-refresh · 30s
        </span>
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
