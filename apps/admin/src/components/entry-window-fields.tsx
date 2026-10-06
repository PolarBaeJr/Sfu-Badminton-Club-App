'use client';

import { Input } from '@badminton/ui';
import {
  WINDOW_COLUMN_KEYS,
  formatWindowInstant,
  utcToClubWallClock,
  type WindowColumns,
} from '@badminton/shared';

// The registration and check-in windows (00276) as datetime-local inputs, in
// club wall-clock time. Blank is "no bound here".
export type EntryWindowText = Record<keyof WindowColumns, string>;

const LABELS: Record<keyof WindowColumns, string> = {
  registration_opens_at: 'Registration opens',
  registration_closes_at: 'Registration closes',
  checkin_opens_at: 'Check-in opens',
  checkin_closes_at: 'Check-in closes',
};

/** Stored instants as the form's wall-clock strings. */
export function entryWindowText(stored: WindowColumns | null | undefined): EntryWindowText {
  const out = {} as EntryWindowText;
  for (const key of WINDOW_COLUMN_KEYS) {
    const v = stored?.[key];
    out[key] = v ? utcToClubWallClock(v) : '';
  }
  return out;
}

/**
 * The four inputs. With `inherited`, a blank box shows the tournament's value
 * underneath it as text: a datetime-local input ignores `placeholder`.
 */
export function EntryWindowFields({
  value,
  onChange,
  inherited,
}: {
  value: EntryWindowText;
  onChange: (next: EntryWindowText) => void;
  inherited?: WindowColumns | null;
}) {
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      {WINDOW_COLUMN_KEYS.map((key) => {
        const fallback = inherited?.[key];
        return (
          <div key={key}>
            <Input
              label={LABELS[key]}
              type="datetime-local"
              value={value[key]}
              onChange={(e) => onChange({ ...value, [key]: e.target.value })}
            />
            {inherited !== undefined && value[key] === '' && (
              <p className="mt-1 text-xs text-[var(--text-muted)]">
                {fallback ? `Inherited: ${formatWindowInstant(fallback)}` : 'Inherited: none'}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
