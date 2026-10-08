'use client';

import { useState } from 'react';
import { Button } from '@badminton/ui';
import { Plus, Trash2 } from 'lucide-react';
import {
  addPointsBand,
  bandsToByPlace,
  defaultPointsTable,
  isDefaultPointsTable,
  pointsBandLabel,
  pointsBands,
  pointsTableIsKnockout,
  removePointsBand,
  setPointsBandEnd,
  type FormatPoints,
  type FormatStage,
  type PointsBand,
} from '@badminton/shared';

// THE LADDER POINTS AN EVENT PAYS (00275). null is the format's default, and
// that is what is shown until something is changed. Every edit leaves a table
// that can be saved: a box holding something that is not a whole number in
// range shows what was typed and changes nothing until it is.

const card = 'rounded-xl border border-[var(--border)] bg-[var(--bg-elevated)] p-3 space-y-3';
const heading = 'text-xs font-semibold uppercase tracking-[0.08em] text-[var(--text-muted)]';
const iconButton = 'p-2 rounded-lg border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--border-hover)] disabled:opacity-40 disabled:cursor-not-allowed focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none';
const box = 'w-20 px-2 min-h-[40px] text-center bg-[var(--bg-surface)] border border-[var(--border)] rounded-[8px] text-[var(--text-primary)] disabled:opacity-50 focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]';

const MAX_POINTS = 10000;

function NumberBox({
  value,
  min,
  max,
  label,
  disabled,
  onCommit,
}: {
  value: number;
  min: number;
  max: number;
  label: string;
  disabled?: boolean;
  onCommit: (n: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  return (
    <input
      type="number"
      min={min}
      max={max}
      step={1}
      aria-label={label}
      disabled={disabled}
      value={draft ?? String(value)}
      onChange={(e) => {
        const text = e.target.value;
        setDraft(text);
        const n = Number(text);
        if (text.trim() !== '' && Number.isInteger(n) && n >= min && n <= max) onCommit(n);
      }}
      onBlur={() => setDraft(null)}
      className={box}
    />
  );
}

export function PointsTableEditor({
  format,
  lastStageKind,
  value,
  onChange,
  disabled = false,
}: {
  format: string;
  /** A staged event's last stage, which decides its default table. */
  lastStageKind?: FormatStage['kind'] | null;
  value: FormatPoints | null | undefined;
  onChange: (next: FormatPoints | null) => void;
  disabled?: boolean;
}) {
  const fallback = defaultPointsTable(format, lastStageKind);
  const table = value ?? fallback;
  const rest = table.rest ?? 0;
  // The rows as last edited, so two neighbouring places on the same points stay
  // two rows while they are being typed into; read afresh from the table
  // whenever it was changed from outside (a reset, a preset, another format).
  const [local, setLocal] = useState<PointsBand[]>(() => pointsBands(table));
  const localByPlace = bandsToByPlace(local, rest);
  const bands = localByPlace.length === table.byPlace.length && localByPlace.every((v, i) => v === table.byPlace[i])
    ? local
    : pointsBands(table);
  const showPerWin = !pointsTableIsKnockout(format);
  const isDefault = value == null || isDefaultPointsTable(format, value, lastStageKind);

  function emit(next: Partial<FormatPoints>, nextBands: PointsBand[] = bands) {
    const nextRest = next.rest ?? rest;
    setLocal(nextBands);
    onChange({
      byPlace: bandsToByPlace(nextBands, nextRest),
      rest: nextRest,
      participation: next.participation ?? table.participation,
      perWin: showPerWin ? (next.perWin ?? table.perWin) : 0,
    });
  }

  return (
    <div className={card}>
      <div className="flex items-center justify-between gap-2">
        <p className={heading}>Ladder points</p>
        {isDefault && (
          <span className="text-xs font-medium text-[var(--text-muted)] rounded-md border border-[var(--border)] px-2 py-0.5">Default</span>
        )}
      </div>
      <table className="text-sm" aria-label="Ladder points by finishing place">
        <thead>
          <tr>
            <th className="text-left text-xs font-medium text-[var(--text-muted)] px-2 py-1">Place</th>
            <th className="text-xs font-medium text-[var(--text-muted)] px-2 py-1">Up to</th>
            <th className="text-xs font-medium text-[var(--text-muted)] px-2 py-1">Points</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {bands.map((band, i) => (
            <tr key={`${i}-${band.from}`}>
              <th scope="row" className="text-left text-xs font-medium text-[var(--text-secondary)] px-2 py-1">{pointsBandLabel(band)}</th>
              <td className="px-1 py-1">
                <NumberBox
                  value={band.to}
                  min={band.from}
                  max={128}
                  label={`${pointsBandLabel(band)}: last place in this row`}
                  disabled={disabled}
                  onCommit={(to) => emit({}, setPointsBandEnd(bands, i, to))}
                />
              </td>
              <td className="px-1 py-1">
                <NumberBox
                  value={band.points}
                  min={0}
                  max={MAX_POINTS}
                  label={`${pointsBandLabel(band)}: points`}
                  disabled={disabled}
                  onCommit={(points) => emit({}, bands.map((b, j) => (j === i ? { ...b, points } : b)))}
                />
              </td>
              <td className="px-1 py-1">
                <button
                  type="button"
                  className={iconButton}
                  aria-label={`Remove ${pointsBandLabel(band)}`}
                  disabled={disabled}
                  onClick={() => emit({}, removePointsBand(bands, i))}
                >
                  <Trash2 className="w-4 h-4" />
                </button>
              </td>
            </tr>
          ))}
          <tr>
            <th scope="row" className="text-left text-xs font-medium text-[var(--text-secondary)] px-2 py-1">Everyone else</th>
            <td />
            <td className="px-1 py-1">
              <NumberBox value={rest} min={0} max={MAX_POINTS} label="Everyone else: points" disabled={disabled} onCommit={(n) => emit({ rest: n })} />
            </td>
            <td />
          </tr>
          <tr>
            <th scope="row" className="text-left text-xs font-medium text-[var(--text-secondary)] px-2 py-1">Taking part</th>
            <td />
            <td className="px-1 py-1">
              <NumberBox value={table.participation} min={0} max={MAX_POINTS} label="Taking part: points" disabled={disabled} onCommit={(n) => emit({ participation: n })} />
            </td>
            <td />
          </tr>
          {showPerWin && (
            <tr>
              <th scope="row" className="text-left text-xs font-medium text-[var(--text-secondary)] px-2 py-1">Per win</th>
              <td />
              <td className="px-1 py-1">
                <NumberBox value={table.perWin} min={0} max={MAX_POINTS} label="Per win: points" disabled={disabled} onCommit={(n) => emit({ perWin: n })} />
              </td>
              <td />
            </tr>
          )}
        </tbody>
      </table>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled || (bands[bands.length - 1]?.to ?? 0) >= 128}
          onClick={() => emit({}, addPointsBand(bands, rest))}
        >
          <Plus className="w-4 h-4 mr-1" /> Add a place
        </Button>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={disabled || value == null}
          onClick={() => { setLocal(pointsBands(fallback)); onChange(null); }}
        >
          Reset to default
        </Button>
      </div>
      <p className="text-xs text-[var(--text-muted)]">
        Each entrant takes their place&rsquo;s points{showPerWin ? ', the taking-part points and the per-win points for each win' : ' and the taking-part points'}.
        Read when the event is finalised, so it can change up to then.
      </p>
    </div>
  );
}
