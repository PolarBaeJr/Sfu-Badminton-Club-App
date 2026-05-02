'use client';

import { useState, useMemo } from 'react';

type Row = {
  id: string;
  win_flag: boolean | null;
  rating_delta: number | null;
  match_type: string;
  score_summary: string;
  played_at: string | null;
};

type Filter = 'all' | 'singles' | 'doubles';

export function MyMatchesFilter({ rows }: { rows: Row[] }) {
  const [filter, setFilter] = useState<Filter>('all');

  const filtered = useMemo(() => {
    if (filter === 'all') return rows;
    return rows.filter((r) => r.match_type === filter);
  }, [filter, rows]);

  return (
    <>
      <div className="d-matches-toolbar">
        <div className="d-seg-toggle">
          <button
            type="button"
            className={`d-seg-btn${filter === 'all' ? ' d-active' : ''}`}
            onClick={() => setFilter('all')}
          >
            All
          </button>
          <button
            type="button"
            className={`d-seg-btn${filter === 'singles' ? ' d-active' : ''}`}
            onClick={() => setFilter('singles')}
          >
            Singles
          </button>
          <button
            type="button"
            className={`d-seg-btn${filter === 'doubles' ? ' d-active' : ''}`}
            onClick={() => setFilter('doubles')}
          >
            Doubles
          </button>
        </div>
        <div className="d-meta-text">{filtered.length} matches</div>
      </div>

      <div className="d-table-wrap">
        <table className="d-table">
          <thead>
            <tr>
              <th>Date</th>
              <th>Format</th>
              <th>Score</th>
              <th>Result</th>
              <th>ELO Δ</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 ? (
              <tr>
                <td colSpan={5} style={{ textAlign: 'center', padding: '32px 24px', color: 'var(--text-faint)' }}>
                  No matches in this filter.
                </td>
              </tr>
            ) : (
              filtered.map((r) => {
                const date = r.played_at
                  ? new Date(r.played_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
                  : '—';
                return (
                  <tr key={r.id}>
                    <td className="d-td-date">{date}</td>
                    <td className="d-td-date" style={{ textTransform: 'capitalize' }}>
                      {r.match_type}
                    </td>
                    <td className="d-td-elo" style={{ fontSize: 12 }}>
                      {r.score_summary}
                    </td>
                    <td className={r.win_flag ? 'd-td-win' : 'd-td-loss'}>
                      {r.win_flag ? 'WIN' : 'LOSS'}
                    </td>
                    <td className={(r.rating_delta ?? 0) >= 0 ? 'd-delta-pos' : 'd-delta-neg'}>
                      {r.rating_delta != null
                        ? `${r.rating_delta >= 0 ? '+' : ''}${r.rating_delta}`
                        : '—'}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
