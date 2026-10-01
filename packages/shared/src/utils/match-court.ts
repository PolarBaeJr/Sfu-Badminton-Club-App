// ---------------------------------------------------------------------------
// WHICH COURT A MATCH IS ON, said the same way in both apps.
//
// `tournament_matches.court` is free text an exec types at the desk (00135), so
// what lands in it is "3" from one person and "Court 3" from the next. Both
// readers used to hard-code `Court ${court}`, which turns the second into
// "Court Court 3" — and this is the line a member reads to decide which way to
// walk, so it has to survive both habits.
//
// SHARED RATHER THAN COPIED because the player app and the console print the
// same value at the same event, ten metres apart. The bracket geometry was
// duplicated in exactly this way and drifted card height by card height.
// ---------------------------------------------------------------------------

/** What the player app shows when the desk has not assigned a court yet. */
export const COURT_UNASSIGNED = 'Court TBC';

/**
 * The court as a member should read it.
 *
 * Returns null when nothing is set, so a caller can choose between "say Court
 * TBC" (the player's own next match, where silence reads as a broken app) and
 * "print nothing" (a bracket card at 0.68 scale, where it is noise).
 *
 * A leading "court" in the stored value is absorbed rather than rejected: the
 * desk is typing this one-handed while people wait, and refusing "Court 3"
 * would be correcting an exec for being clear.
 */
export function courtLabel(court: string | null | undefined): string | null {
  const trimmed = (court ?? '').trim();
  if (trimmed === '') return null;
  // Only a WHOLE leading word, so a venue called "Courtyard 2" keeps its name.
  const bare = trimmed.replace(/^courts?\b[\s.:#-]*/i, '').trim();
  return bare === '' ? trimmed : `Court ${bare}`;
}

/** The same thing, with the placeholder folded in — for the member's own row. */
export function courtLabelOrTbc(court: string | null | undefined): string {
  return courtLabel(court) ?? COURT_UNASSIGNED;
}

// ---------------------------------------------------------------------------
// A TOURNAMENT'S OWN COURTS (00273).
//
// A tournament may list its courts. When it does, the desk picks from them, a
// draw's court labels must name them, and the database refuses two live
// matches on one court. When it does not, everything above still applies to
// the free text.
// ---------------------------------------------------------------------------

/** The longest court label a tournament court may have (00273's CHECK). */
export const COURT_LABEL_MAX = 20;

/** The most courts one "Add courts" may create. */
export const COURTS_ADD_MAX = 64;

/**
 * What makes two labels the same court: "Court 3", "court 3" and "3" are one
 * court. The same leading-word rule as courtLabel, so the key agrees with what
 * members are shown.
 */
export function courtKey(court: string | null | undefined): string {
  const trimmed = (court ?? '').trim();
  if (trimmed === '') return '';
  const bare = trimmed.replace(/^courts?\b[\s.:#-]*/i, '').trim();
  return (bare === '' ? trimmed : bare).replace(/\s+/g, ' ').toLowerCase();
}

/** A row of tournament_courts as the console reads it. */
export interface TournamentCourt {
  id: string;
  label: string;
  sort_order: number;
  active: boolean;
  notes?: string | null;
}

/** Courts in the organiser's order, then by label, then by id. */
export function courtsInOrder<C extends TournamentCourt>(courts: readonly C[]): C[] {
  return [...courts].sort((a, b) =>
    a.sort_order - b.sort_order
    || a.label.localeCompare(b.label, undefined, { numeric: true })
    || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

/**
 * What is wrong with a list of new labels, as sentences: an empty one, one too
 * long, two that are the same court, or one the tournament already has.
 * Empty means the list is fine.
 */
export function courtLabelIssues(labels: readonly string[], existing: readonly string[] = []): string[] {
  const issues: string[] = [];
  const taken = new Map(existing.map((l) => [courtKey(l), l]));
  const seen = new Set<string>();
  for (const raw of labels) {
    const label = raw.trim();
    if (label === '') {
      issues.push('A court needs a name.');
      continue;
    }
    if (label.length > COURT_LABEL_MAX) {
      issues.push(`"${label}" is longer than ${COURT_LABEL_MAX} characters.`);
      continue;
    }
    const key = courtKey(label);
    if (taken.has(key)) {
      issues.push(`There is already a court called ${taken.get(key)}.`);
    } else if (seen.has(key)) {
      issues.push(`${courtLabel(label)} is listed twice.`);
    }
    seen.add(key);
  }
  return issues;
}

/**
 * "1-8" or "1, 2, Centre" as a list of labels. A range runs between two whole
 * numbers either way round; anything else is a label as typed. Blank parts are
 * dropped, and a range longer than COURTS_ADD_MAX is returned as typed so the
 * label check refuses it rather than this making a hundred courts.
 */
export function parseCourtList(text: string): string[] {
  const out: string[] = [];
  for (const part of text.split(',')) {
    const item = part.trim();
    if (item === '') continue;
    const range = /^(\d{1,3})\s*-\s*(\d{1,3})$/.exec(item);
    if (range) {
      const from = Number(range[1]);
      const to = Number(range[2]);
      if (Math.abs(to - from) < COURTS_ADD_MAX) {
        const step = from <= to ? 1 : -1;
        for (let n = from; n !== to + step; n += step) out.push(String(n));
        continue;
      }
    }
    out.push(item);
  }
  return out;
}

/**
 * Labels (from a stage's format_config, or typed at the desk) matched to the
 * tournament's ACTIVE courts by courtKey. `unknown` keeps each unmatched label
 * once, in the order given.
 */
export function resolveCourtLabels<C extends TournamentCourt>(
  courts: readonly C[],
  labels: readonly string[],
): { byLabel: Map<string, C>; unknown: string[] } {
  const byKey = new Map<string, C>();
  for (const c of courtsInOrder(courts)) {
    if (c.active && !byKey.has(courtKey(c.label))) byKey.set(courtKey(c.label), c);
  }
  const byLabel = new Map<string, C>();
  const unknown: string[] = [];
  for (const label of labels) {
    const court = byKey.get(courtKey(label));
    if (court) byLabel.set(label, court);
    else if (!unknown.includes(label)) unknown.push(label);
  }
  return { byLabel, unknown };
}

/**
 * The courts a live match is on. A match linked by court_id counts directly;
 * one with only text (set before the courts were listed) counts against the
 * court whose key it matches.
 */
export function busyCourtIds(
  courts: readonly TournamentCourt[],
  liveMatches: ReadonlyArray<{ court_id?: string | null; court: string | null }>,
): Set<string> {
  const byKey = new Map(courts.map((c) => [courtKey(c.label), c.id]));
  const busy = new Set<string>();
  for (const m of liveMatches) {
    if (m.court_id) busy.add(m.court_id);
    else {
      const id = byKey.get(courtKey(m.court));
      if (id) busy.add(id);
    }
  }
  return busy;
}

/**
 * The court to suggest: the preferred one if it is active and free, otherwise
 * the first free active court in order, otherwise null.
 */
export function nextCourtFree<C extends TournamentCourt>(
  courts: readonly C[],
  busy: ReadonlySet<string>,
  preferredId?: string | null,
): C | null {
  const free = courtsInOrder(courts).filter((c) => c.active && !busy.has(c.id));
  return free.find((c) => c.id === preferredId) ?? free[0] ?? null;
}
