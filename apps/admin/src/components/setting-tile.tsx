import type { ReactNode } from 'react';

// One switch in the Member pages grid. Presentational only: the form owns the
// state and hands in the toggle as `control`, so a switch here batches with the
// rest until the reason is written and Save is pressed.
//
// ON/OFF reads the EDITED value the form passes as `on`, not the saved one, so
// the word always agrees with the toggle beside it; `modified` says it is not
// saved yet.
//
// NOT A <label>. The toggle is a button, and a label around it would forward a
// click anywhere on the tile (the disclosure included) to that button.
export function SettingTile({
  label,
  summary,
  on,
  modified,
  control,
  warning,
  detail,
}: {
  label: string;
  summary?: string;
  on?: boolean;
  modified?: boolean;
  control: ReactNode;
  warning?: string;
  detail?: string;
}) {
  return (
    <div className="setting-tile">
      <div className="flex items-center gap-3.5">
        <div className="flex min-w-0 flex-grow flex-col gap-0.5">
          <span className="text-[15px] font-semibold text-[var(--ink)]">
            {label}
            {modified && <span className="ml-2 text-[12px] font-normal text-[var(--color-accent)]">Modified</span>}
          </span>
          {summary && <span className="text-[13px] text-[var(--mute)]">{summary}</span>}
        </div>
        {on !== undefined && (
          <span
            className={`font-mono text-[11px] tracking-[0.1em] ${
              on ? 'text-[var(--color-success)]' : 'text-[var(--mute)]'
            }`}
          >
            {on ? 'ON' : 'OFF'}
          </span>
        )}
        <div className="flex-shrink-0">{control}</div>
      </div>
      {warning && (
        <p className="mt-3 rounded-[8px] bg-[color-mix(in_srgb,var(--color-warning)_10%,transparent)] px-3 py-2.5 text-[12px] text-[var(--color-warning)]">
          {warning}
        </p>
      )}
      {detail && (
        <details className="mt-2 text-[13px] text-[var(--mute)]">
          <summary className="cursor-pointer select-none text-[12px] text-[var(--ink-2)] hover:text-[var(--ink)]">
            What switching off does
          </summary>
          <p className="mt-2">{detail}</p>
        </details>
      )}
    </div>
  );
}
