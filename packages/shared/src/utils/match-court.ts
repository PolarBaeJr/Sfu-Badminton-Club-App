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
