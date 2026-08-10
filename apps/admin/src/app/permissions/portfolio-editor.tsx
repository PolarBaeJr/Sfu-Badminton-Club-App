'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Select } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import { setPlayerPortfolio } from '@/lib/actions';
import { PORTFOLIOS, PORTFOLIO_LABELS, type Portfolio } from '@/lib/permissions';

export interface ExecRow {
  id: string;
  full_name: string | null;
  email: string | null;
  exec_title: string | null;
  portfolio: string | null;
}

// "No portfolio" is the FIRST option and the default, because it is what every
// exec already holds and what the whole design treats as the safe value: an
// unnarrowed exec, i.e. today's behaviour. An empty string carries it through
// the <select>, which has no way to hold null.
const NONE = '';

const OPTIONS = [
  { value: NONE, label: 'No portfolio — full exec access' },
  ...PORTFOLIOS.map((p) => ({ value: p, label: PORTFOLIO_LABELS[p] })),
];

// What each portfolio actually opens, so an admin is choosing between jobs
// rather than between four words. Must agree with SECTION_PORTFOLIO in
// lib/permissions.ts — that map is the boundary, this is the caption.
const OPENS: Record<Portfolio, string> = {
  finance: 'Finances',
  tournaments: 'Tournaments, Matches, Sessions',
  internal: 'Players, Seasons',
  external: 'Legal, Announcements',
};

export function PortfolioEditor({ execs }: { execs: ExecRow[] }) {
  // Saved values are re-read from the server after each change; this only holds
  // the row currently in flight so its select can be disabled.
  const [saving, setSaving] = useState<string | null>(null);
  const [, startTransition] = useTransition();
  const { toast } = useToast();
  const router = useRouter();

  function handleChange(exec: ExecRow, value: string) {
    const next = value === NONE ? null : (value as Portfolio);
    setSaving(exec.id);
    startTransition(async () => {
      try {
        const res = await setPlayerPortfolio(exec.id, next);
        if (!res.ok) { toast(res.error, 'error'); return; }
        toast(
          next === null
            ? `${exec.full_name ?? 'That exec'} now has full exec access`
            : `${exec.full_name ?? 'That exec'} now holds ${PORTFOLIO_LABELS[next]}`,
          'success',
        );
        router.refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to change the portfolio', 'error');
      } finally {
        setSaving(null);
      }
    });
  }

  return (
    <div>
      <p className="settings-section-desc">
        A portfolio narrows an exec to their own job. Leave it at &ldquo;No portfolio&rdquo; and
        they keep the access every exec has always had. Admins are unaffected. Every change is
        recorded in the audit log.
      </p>

      {execs.map((exec) => {
        const current = exec.portfolio ?? NONE;
        return (
          <div key={exec.id} className="settings-row">
            <div>
              <div className="settings-row-label">{exec.full_name ?? exec.email ?? 'Unnamed'}</div>
              <div className="settings-row-hint">
                {exec.exec_title ? `${exec.exec_title} · ` : ''}
                {current === NONE
                  ? 'Every section an exec may open'
                  : `Opens: ${OPENS[current as Portfolio] ?? 'nothing — unrecognised portfolio'}`}
              </div>
            </div>
            <div className="settings-row-control">
              <Select
                aria-label={`Portfolio for ${exec.full_name ?? exec.email ?? 'this exec'}`}
                options={OPTIONS}
                value={current}
                disabled={saving === exec.id}
                onChange={(e) => handleChange(exec, e.target.value)}
                className="w-64"
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
