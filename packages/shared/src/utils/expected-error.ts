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

// THE STRUCTURAL `expected === true` ARM IS LOAD-BEARING, not belt-and-braces.
// instrumentation.ts and the Sentry init files deep-import this module
// (@badminton/shared/src/utils/expected-error) while app code imports it through
// the barrel, because the barrel drags node 'crypto' into an edge bundle. Same
// resolved path, so webpack dedupes today and `instanceof` happens to hold — but
// the moment anything gives those two entry points separate module instances,
// instanceof-only would stop recognising a refusal and every one of them would
// go back to being filed as a fault. Do not "tidy" this to instanceof.
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
//
// 'Challenge not found' / 'Match not found' are deliberately absent even though
// they look like the stalest of stale-page errors. Under RLS a row the caller
// cannot SEE is not an error at all — PostgREST returns zero rows and the code
// above reports "not found" — so an RLS row-visibility regression is
// indistinguishable from a genuinely deleted challenge. That is the shape of the
// 00032 fallout ("submitting a result failed with Challenge not found"), and it
// has to stay loud. A missing column grant still surfaces as 42501 and reports
// either way; it is the row-level case that would go dark.
// Every string here was taken from the RAISE EXCEPTION statements in the live
// functions (submit_match_result, apply_match_result, dispute_match_result,
// apply_walkover_result), so a typo here shows up as noise rather than as a
// swallowed fault.
const EXPECTED_DB_GUARDS: readonly string[] = [
  // Submission / confirmation raced against someone else, or the same person
  // clicked twice.
  'A match has already been submitted for this challenge',
  'Match not pending confirmation',
  'A dispute is already open for this match',
  'Walkover not found or not pending',
  // The action no longer applies to this challenge's state.
  'Challenge is not accepted',
  // Score entry the format does not allow.
  'At least one game is required',
  // Permission guards a correct UI never offers, but a stale page can.
  'Not a participant in this challenge',
  'Only a participant can confirm this match',
  'Only a participant can dispute this match',
  'The submitter cannot confirm their own result',
  'Not authenticated',
  // 00050's last-admin guard, verbatim from its two RAISE EXCEPTION statements.
  // An admin being told they are about to make the console unreachable is the
  // invariant working, not a fault — and /permissions now offers taking console
  // access away as an ordinary control, so this is a refusal somebody can meet
  // by accident rather than a corner of the settings page.
  'This is the only admin with a passkey. Give another admin a passkey before demoting this one.',
  'This is the only admin with a passkey. Give another admin a passkey before deleting this account.',
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

// What runAction should actually ask before reporting a fault.
//
// isExpectedError alone only catches rejections someone remembered to construct
// as an ExpectedError. A guard message that reaches a call site as a plain Error
// — because it came back from PostgREST without going through dbError(), or was
// rethrown somewhere along the way — was still filed as a Sentry fault even
// though its text is on the allowlist. "Not a possible score for this format:"
// is on that list and reported 8 times in one minute from a single member
// mistyping a score.
//
// Checking the message as well closes that gap wherever the error came from,
// and keeps the fail-safe direction: an unrecognised message is still a fault.
export function isExpectedFailure(err: unknown): boolean {
  if (isExpectedError(err)) return true;
  const message = (err as { message?: unknown } | null)?.message;
  return typeof message === 'string' && isExpectedDbGuard(message);
}

export function isExpectedDbGuard(message: string): boolean {
  const trimmed = message.trim();
  return (
    EXPECTED_DB_GUARDS.includes(trimmed) ||
    EXPECTED_DB_GUARD_PREFIXES.some((p) => trimmed.startsWith(p)) ||
    EXPECTED_DB_GUARD_PATTERNS.some((p) => p.test(trimmed))
  );
}

// runAction is not the only way a refusal reaches Sentry, and it was never the
// noisy one. An action that throws instead of returning — createSeason,
// recordMatchResult, the check-in actions — never reaches runAction's catch at
// all: the throw escapes the action, Next.js hands it to the `onRequestError`
// instrumentation hook, and @sentry/nextjs's captureRequestError files it as an
// unhandled fault. That is where "ExpectedError: year: Number must be greater
// than or equal to 2000" came from, mechanism auto.function.nextjs
// .on_request_error, handled: no. No captureException call site is involved, so
// auditing call sites could never have found it.
//
// This wraps that hook so a refusal is dropped before it becomes an issue.
//
// MARKER ONLY — deliberately isExpectedError and NOT isExpectedFailure, which
// is the difference between this and runAction. runAction's allowlist sees the
// errors of one action body; this hook sees every error from every route, page,
// RSC render and route handler in the app. A genuine fault that happens to be
// rethrown carrying guard text would be dropped here and never reported, and
// this file already argues that case (see why 'Challenge not found' is off the
// allowlist: an RLS regression is indistinguishable from a real deletion). So a
// refusal has to opt in positively, by being constructed as an ExpectedError or
// carrying `expected === true`. Anything else is still a fault and still
// reported — which keeps the failure mode "noise", never "silence".
//
// Generic over the hook's own parameters rather than restating them, so a
// signature change in @sentry/nextjs is a type error at the binding rather than
// a silently wrong wrapper.
export function skipExpectedRequestErrors<Args extends [unknown, ...unknown[]], R>(
  capture: (...args: Args) => R
): (...args: Args) => R | undefined {
  return (...args: Args) => {
    if (isExpectedError(args[0])) return undefined;
    return capture(...args);
  };
}

// The same decision for Sentry's `beforeSend`, as a backstop under the hook
// above: any OTHER automatic server-side capture path (the SDK's own server
// action / route handler wrappers) still funnels through beforeSend, and this
// drops a refusal there too. Reads hint.originalException because by beforeSend
// the event is already serialized — the `expected` marker only survives on the
// original throwable, not on the exception values in the event payload.
//
// Returning the event unchanged is the only other outcome: this never mutates,
// tags or reshapes anything, so adding it to an init cannot change what a
// genuine fault looks like in the dashboard.
export function dropExpectedEvent<E>(event: E, hint?: { originalException?: unknown }): E | null {
  return isExpectedError(hint?.originalException) ? null : event;
}
