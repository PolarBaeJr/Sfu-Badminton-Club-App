/**
 * The keyboard and placement rules behind the single-value `Select`.
 *
 * Plain .ts, no React, for the reason multi-select.ts gives: packages/ui has no
 * test runner and no DOM, so the behaviour that matters (which row the arrow
 * keys land on, what type-ahead matches, when a change is reported, which way
 * the list opens) has to be reachable without rendering anything. Every
 * function here is pure.
 */

export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
  /** A short pill drawn at the end of the row, such as "Now" on the active season. */
  badge?: string;
  /** Extra words the search box matches on without showing them, such as a season's dates. */
  keywords?: string;
}

type Options = readonly SelectOption[];

/** How long a pause ends a type-ahead run, matching the native control. */
export const TYPEAHEAD_RESET_MS = 500;

/**
 * Above this many options a Select left on searchable="auto" grows a search
 * box. Eight fits on screen without scrolling, so a list that short is quicker
 * to read than to type into.
 */
export const SEARCH_THRESHOLD = 8;

/**
 * The indices, into the ORIGINAL options, of the rows a search query keeps, in
 * their original order. Every whitespace-separated word has to appear somewhere
 * in the label, badge or keywords, so "fall 27" narrows rather than widening
 * the way an OR would. An empty query keeps everything. Disabled rows are kept:
 * hiding them would make a search look like it found nothing when the row is
 * there and merely unavailable.
 */
export function filterOptions(options: Options, query: string): number[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const out: number[] = [];
  options.forEach((o, i) => {
    if (words.length === 0) {
      out.push(i);
      return;
    }
    const hay = `${o.label} ${o.badge ?? ''} ${o.keywords ?? ''}`.toLowerCase();
    if (words.every((w) => hay.includes(w))) out.push(i);
  });
  return out;
}

/**
 * The index of the option holding `value`, or -1. An empty string is NOT a
 * wildcard: when no option has value '', the answer is -1, so the trigger shows
 * the placeholder instead of pretending the first option is chosen.
 */
export function indexOfValue(options: Options, value: string | undefined): number {
  if (value === undefined) return -1;
  return options.findIndex((o) => o.value === value);
}

/**
 * The next option in `step` direction that is not disabled. Without `wrap` it
 * stops at the ends, which is what Up and Down do in a native listbox. A `from`
 * of -1 means "nothing active yet": stepping down gives the first enabled
 * option and stepping up gives the last. -1 when every option is disabled.
 */
export function nextEnabledIndex(options: Options, from: number, step: 1 | -1, wrap = false): number {
  const n = options.length;
  if (n === 0) return -1;
  if (from < 0) return step === 1 ? firstEnabledIndex(options) : lastEnabledIndex(options);
  let i = from;
  for (let k = 0; k < n; k++) {
    i += step;
    if (i >= n || i < 0) {
      if (!wrap) break;
      i = (i + n) % n;
    }
    if (!options[i]!.disabled) return i;
  }
  return options[from] && !options[from]!.disabled ? from : -1;
}

export function firstEnabledIndex(options: Options): number {
  return options.findIndex((o) => !o.disabled);
}

export function lastEnabledIndex(options: Options): number {
  for (let i = options.length - 1; i >= 0; i--) {
    if (!options[i]!.disabled) return i;
  }
  return -1;
}

/** Where the highlight starts when the list opens: the selection if it can be picked, else the first enabled row. */
export function initialActiveIndex(options: Options, value: string | undefined): number {
  const i = indexOfValue(options, value);
  if (i >= 0 && !options[i]!.disabled) return i;
  return firstEnabledIndex(options);
}

/**
 * The option a type-ahead buffer lands on, searching from the row after
 * `fromIndex` and wrapping, case-insensitive, by label prefix. A buffer that is
 * one character repeated ("ww") cycles through the rows starting with that
 * character, as the native control does. -1 when nothing matches.
 */
export function typeaheadMatch(options: Options, buffer: string, fromIndex: number): number {
  const n = options.length;
  if (n === 0 || buffer.length === 0) return -1;
  const lower = buffer.toLowerCase();
  const repeated = lower.length > 1 && [...lower].every((c) => c === lower[0]);
  const needle = repeated ? lower[0]! : lower;
  // A multi-character buffer keeps matching the row it is already on, so
  // typing "ce" after "c" does not skip past "Central" to the next C.
  const start = repeated || lower.length === 1 ? fromIndex + 1 : fromIndex;
  for (let k = 0; k < n; k++) {
    const i = (((start + k) % n) + n) % n;
    const opt = options[i]!;
    if (opt.disabled) continue;
    if (opt.label.trim().toLowerCase().startsWith(needle)) return i;
  }
  return -1;
}

/**
 * Whether picking `next` should be reported. Re-picking the current value is
 * silent, as a native select's change event is: callers such as the session
 * location field clear their free-text box when "Custom" is chosen, so a
 * change on a re-pick would wipe what was typed.
 */
export function shouldEmitChange(current: string | undefined, next: string): boolean {
  return current !== next;
}

export interface SelectPlacement {
  left: number;
  minWidth: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
}

/**
 * Where the fixed-position list goes: below the trigger unless there is too
 * little room there and more above (the MultiSelect rule), at least as wide as
 * the trigger, and pulled back inside the viewport at the right edge.
 */
export function resolvePlacement(
  trigger: { top: number; bottom: number; left: number; width: number },
  viewport: { width: number; height: number },
  opts: { gap: number; maxHeight: number; minHeight: number; margin: number },
): SelectPlacement {
  const below = viewport.height - trigger.bottom - opts.margin;
  const above = trigger.top - opts.margin;
  const openUp = below < 180 && above > below;
  const minWidth = trigger.width;
  const left = Math.max(opts.margin, Math.min(trigger.left, viewport.width - opts.margin - minWidth));
  const maxHeight = Math.min(opts.maxHeight, Math.max(opts.minHeight, openUp ? above : below));
  return openUp
    ? { left, minWidth, maxHeight, bottom: viewport.height - trigger.top + opts.gap }
    : { left, minWidth, maxHeight, top: trigger.bottom + opts.gap };
}
