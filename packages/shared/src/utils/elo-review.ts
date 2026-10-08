// Reading players.elo_review — the mark merge_players leaves when a merge
// completed but left something a human should look at (00163).
//
// Same contract as privilege-claim.ts, deliberately: the shape is written in
// SQL and read in TSX with no compiler between them, so the parse lives in one
// place and is TOTAL. Any shape that is not recognisable comes back as null
// rather than throwing — a row whose flag cannot be read is a row with nothing
// to review, which is what the console already shows for every row that has
// never been merged. The one thing this must never do is take down the roster.
//
// WHY THIS EXISTS AT ALL. Before 00163 a merge with history refused outright,
// so there was nothing to record. Now the merge completes and the awkward part
// is written down instead of blocking: rows discarded because the survivor was
// already in that scope, and — the reason the word "elo" is in the name —
// matches where both accounts of one person played each other, whose rating
// movement is transferred rather than earned.

/** Row counts that could not move because the survivor already had a row in
 *  that scope, keyed by table name. Counts, not rows: the detail is in the
 *  audit_logs entry for the merge. */
export type EloReviewDiscards = Record<string, number>;

export interface EloReview {
  /** 'elo' = at least one self-play match, so a rating needs a human decision.
   *  'discards' = rows were dropped but no rating is in question. Derived in
   *  SQL so the console can sort and label without unpacking the arrays. */
  state: 'elo' | 'discards';
  /** ISO-8601, UTC, second precision. */
  at: string | null;
  /** The player row that was merged away. Kept so an admin can find the merge
   *  in audit_logs, where the discarded rows are still readable. */
  mergedFrom: string | null;
  /** Display name of the removed account at merge time. */
  mergedFromName: string | null;
  /** matches.id where BOTH accounts appeared — a person recorded as beating
   *  themselves. Left in place on purpose; re-rating one match re-rates every
   *  ladder position set after it. */
  selfPlayMatches: string[];
  /** tournament_matches.id where both sides resolved to the same participant
   *  after the merge. The bracket equivalent of the above. */
  selfPlayTournamentMatches: string[];
  discarded: EloReviewDiscards;
}

function readIdArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  // Filtered rather than cast: this came out of jsonb, and a non-string here
  // would travel into a key prop and a query.
  return value.filter((v): v is string => typeof v === 'string' && v !== '');
}

function readDiscards(value: unknown): EloReviewDiscards {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const out: EloReviewDiscards = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    // Zero and negative counts are dropped, not shown: "session_rsvp: 0" reads
    // as a finding when it is the absence of one.
    if (typeof v === 'number' && Number.isFinite(v) && v > 0) out[k] = v;
  }
  return out;
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

export function parseEloReview(value: unknown): EloReview | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const raw = value as Record<string, unknown>;

  const selfPlayMatches = readIdArray(raw.self_play_matches);
  const selfPlayTournamentMatches = readIdArray(raw.self_play_tournament_matches);
  const discarded = readDiscards(raw.discarded);

  // A flag that survives parsing but describes nothing is not a review. This
  // also means clearing the column is not the only way to clear the badge —
  // writing an empty review works too.
  if (
    selfPlayMatches.length === 0 &&
    selfPlayTournamentMatches.length === 0 &&
    Object.keys(discarded).length === 0
  ) {
    return null;
  }

  // state is re-derived rather than trusted: SQL and TSX must not be able to
  // disagree about whether a rating is in question.
  const state: EloReview['state'] =
    selfPlayMatches.length > 0 || selfPlayTournamentMatches.length > 0 ? 'elo' : 'discards';

  return {
    state,
    at: readString(raw.at),
    mergedFrom: readString(raw.merged_from),
    mergedFromName: readString(raw.merged_from_name),
    selfPlayMatches,
    selfPlayTournamentMatches,
    discarded,
  };
}

/** One-line label for the roster list. */
export function eloReviewLabel(review: EloReview): string {
  if (review.state === 'elo') {
    const n = review.selfPlayMatches.length + review.selfPlayTournamentMatches.length;
    return `Elo review — ${n} self-play ${n === 1 ? 'match' : 'matches'}`;
  }
  const n = Object.values(review.discarded).reduce((a, b) => a + b, 0);
  return `Merge review — ${n} ${n === 1 ? 'row' : 'rows'} discarded`;
}
