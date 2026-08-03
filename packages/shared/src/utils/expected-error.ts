// Not every thrown Error is a fault. This codebase uses exceptions for ordinary
// user-facing rejections too — "Description must be at least 10 characters",
// "Game scores cannot be tied", "Account pending approval" — and runAction
// reported all of them to Sentry. The result was a dashboard where working
// validation drowned out real defects (and burned quota doing it).
//
// ExpectedError marks the rejections that are the system behaving correctly.
// They still reach the user exactly as before — only the Sentry report is
// skipped. Anything unmarked is still treated as a genuine fault, so this fails
// safe: forgetting to mark something means noise, never a swallowed bug.
export class ExpectedError extends Error {
  readonly expected = true as const;

  constructor(message: string) {
    super(message);
    this.name = 'ExpectedError';
  }
}

export function isExpectedError(err: unknown): boolean {
  return (
    err instanceof ExpectedError ||
    (typeof err === 'object' && err !== null && (err as { expected?: unknown }).expected === true)
  );
}

// The RPC guards that fire because of what the *user* did, not because anything
// is wrong: a stale tab whose button no longer applies, a double-click, a retry
// after the state already moved on. Postgres reports these the same way it
// reports a genuine fault — a RAISE EXCEPTION surfaced as a plain error — so the
// call sites cannot tell them apart without a list.
//
// Deliberately an allowlist, not a blanket "any RAISE is expected". Two guards
// in the same functions mean stored data contradicts itself:
// 'winner_side does not match game scores' and 'Games won are tied; cannot
// derive winner' can only happen if a match's games and its recorded winner
// disagree, which is a bug worth a Sentry report every time. Keeping the list
// explicit means a new guard defaults to being reported.
// Every string here was taken from the RAISE EXCEPTION statements in the live
// functions (submit_match_result, apply_match_result, dispute_match_result,
// apply_walkover_result), so a typo here shows up as noise rather than as a
// swallowed fault.
const EXPECTED_DB_GUARDS: readonly string[] = [
  // Submission / confirmation raced against someone else, or the same person
  // clicked twice.
  'A match has already been submitted for this challenge',
  'Match not pending confirmation',
  'Match not found',
  'A dispute is already open for this match',
  'Walkover not found or not pending',
  // The action no longer applies to this challenge's state.
  'Challenge not found',
  'Challenge is not accepted',
  // Score entry the format does not allow.
  'At least one game is required',
  // Permission guards a correct UI never offers, but a stale page can.
  'Not a participant in this challenge',
  'Only a participant can confirm this match',
  'Only a participant can dispute this match',
  'The submitter cannot confirm their own result',
  'Not authenticated',
];

// The same, for guards whose message ends in runtime values (the offending
// score, the current status) and so cannot be matched exactly.
const EXPECTED_DB_GUARD_PREFIXES: readonly string[] = [
  'Not a possible score for this format:',
  'This match cannot be disputed (status:',
];

// 'A best-of-3 needs 2 game(s) to win and stops there — 1 to 0 is not a possible
// result': the leading article varies with the format, so anchor on the middle.
const EXPECTED_DB_GUARD_PATTERNS: readonly RegExp[] = [
  /needs \d+ game\(s\) to win and stops there/,
];

// Wrap a Postgres/PostgREST error for rethrow, marking it expected when its
// message is one of the guards above. Anything unrecognised comes back as a
// plain Error so it still reaches Sentry.
export function dbError(error: { message: string } | null | undefined, fallback = 'Something went wrong'): Error {
  const message = error?.message?.trim() || fallback;
  return isExpectedDbGuard(message) ? new ExpectedError(message) : new Error(message);
}

export function isExpectedDbGuard(message: string): boolean {
  const trimmed = message.trim();
  return (
    EXPECTED_DB_GUARDS.includes(trimmed) ||
    EXPECTED_DB_GUARD_PREFIXES.some((p) => trimmed.startsWith(p)) ||
    EXPECTED_DB_GUARD_PATTERNS.some((p) => p.test(trimmed))
  );
}
