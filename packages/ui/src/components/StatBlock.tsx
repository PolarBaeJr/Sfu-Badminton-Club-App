import React from 'react';

interface StatBlockProps {
  /** Mono uppercase label (e.g. "SINGLES ELO"). */
  label: string;
  /** Big Space Grotesk number. */
  value: React.ReactNode;
  /** Optional sub-line in mono muted (e.g. "K=24 · 67% win rate"). */
  sub?: React.ReactNode;
  /** Wrap in a card-base card. Default true. */
  card?: boolean;
  /** Use the larger 56px display size. */
  large?: boolean;
}

/** Single stat tile. Light wrapper over the .stat-label / .stat-value
 * primitives — pulled out because we use ~30 of these across feed,
 * my-stats, leaderboard, profile, onboarding. */
export function StatBlock({ label, value, sub, card = true, large }: StatBlockProps) {
  const inner = (
    <>
      <div className="stat-label">{label}</div>
      <div className={'stat-value' + (large ? ' stat-value-lg' : '')}>{value}</div>
      {sub && (
        <div className="mono muted" style={{ fontSize: 11, marginTop: 6 }}>
          {sub}
        </div>
      )}
    </>
  );
  if (!card) return <div className="stat">{inner}</div>;
  return <div className="card-base">{inner}</div>;
}
