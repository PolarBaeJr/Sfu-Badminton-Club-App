import type { FormRun as FormRunData } from '@/lib/feed-series';

// Recent form as a run of results rather than a percentage or a pie.
//
// The player-app guidelines call for exactly this ("a compact run of results is
// usually better than a pie chart") and it is the one visualisation that stays
// readable at 360px without a legend: green is a win, red is a loss, left is
// older. --win and --loss are used here because these genuinely are wins and
// losses, which is the only case the guidelines allow them in.

export function FormRun({ run }: { run: FormRunData }) {
  return (
    <div
      className="row"
      style={{ gap: 4, flexWrap: 'wrap' }}
      role="img"
      aria-label={`Last ${run.results.length} results: ${run.wins} wins, ${run.losses} losses`}
    >
      {run.results.map((r, i) => (
        <span
          key={i}
          aria-hidden
          style={{
            width: 24,
            height: 24,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontFamily: 'var(--mono)',
            fontSize: 11,
            fontWeight: 600,
            background: r === 'win' ? 'var(--win-wash)' : 'var(--bg-loss)',
            color: r === 'win' ? 'var(--win)' : 'var(--loss)',
            border: `1px solid ${r === 'win' ? 'var(--win)' : 'var(--loss)'}`,
          }}
        >
          {r === 'win' ? 'W' : 'L'}
        </span>
      ))}
    </div>
  );
}
