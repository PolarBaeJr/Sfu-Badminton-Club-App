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
