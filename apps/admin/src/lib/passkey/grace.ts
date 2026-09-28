// The console passkey grace window (00262). A console user with no console
// passkey can use the console for this many days from their first visit, then
// it asks for one. The database stores only the start; the length lives here,
// so the middleware, the server-action check, the banner and Settings all
// agree.
//
// Dependency-free on purpose: the middleware runs in the edge runtime.

export const CONSOLE_PASSKEY_GRACE_DAYS = 14;

const DAY_MS = 86_400_000;

export interface GraceGate {
  hasConsolePasskey: boolean;
  graceStartedAt: string | null;
}

/** The console_passkey_grace_start() answer, or null for any unexpected shape. */
export function parseGraceGate(data: unknown): GraceGate | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const d = data as Record<string, unknown>;
  if (typeof d.has_console_passkey !== 'boolean') return null;
  const started = d.grace_started_at;
  if (started !== null && typeof started !== 'string') return null;
  return { hasConsolePasskey: d.has_console_passkey, graceStartedAt: started };
}

/** Where a window that started at `startedAtIso` stands at `nowMs`. Null for an unparsable date. */
export function consolePasskeyGrace(
  startedAtIso: string,
  nowMs: number,
): { expired: boolean; daysLeft: number; endsAt: Date } | null {
  const start = Date.parse(startedAtIso);
  if (!Number.isFinite(start)) return null;
  const endsAt = new Date(start + CONSOLE_PASSKEY_GRACE_DAYS * DAY_MS);
  const left = endsAt.getTime() - nowMs;
  return {
    expired: nowMs >= endsAt.getTime(),
    daysLeft: Math.max(0, Math.ceil(left / DAY_MS)),
    endsAt,
  };
}

export function graceDaysText(n: number): string {
  return n === 1 ? '1 day' : `${n} days`;
}
