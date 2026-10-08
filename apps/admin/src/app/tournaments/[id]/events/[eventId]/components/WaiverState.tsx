'use client';

// THE EVENT-WAIVER STATE, on the roster and on the check-in board.
//
// Deliberately the same idea /legal uses for the four club documents:
// `signed v3 · 02 AUG 2026` on one line, `never signed` when there is nothing —
// small, mono, uppercase, under the name. An exec who has read one of these
// screens can read the other without being taught anything.
//
// The version is a seven-character hash prefix rather than an integer, because
// an event waiver has no version number: the SHA-256 of its text IS its
// identity (00015), which is also why editing the text un-signs everybody. Read
// it the way a git short SHA is read — enough to tell two wordings apart.
//
// The stale case is the one worth getting right. Someone whose signature no
// longer matches did nothing wrong; the club moved the text underneath them.
// It blocks like an unsigned entrant and reads differently, because those are
// different conversations to have at a desk.

import { eventWaiverStateLabel, type EventWaiverStatus } from '@badminton/shared';

/** Same format /legal's own shortDate produces: 02 AUG 2026. */
export function shortDate(iso: string): string {
  return new Date(iso)
    .toLocaleDateString('en-CA', { day: '2-digit', month: 'short', year: 'numeric' })
    .toUpperCase();
}

/**
 * `states` is null when the column should not be drawn at all — no waiver on
 * this tournament, or a viewer without `tournaments.draw.waivers.read`. An
 * empty map would render as "nobody has signed", which is a different claim.
 */
export function WaiverState({
  states,
  playerIds,
}: {
  states: Record<string, EventWaiverStatus> | null;
  /** One id for a singles entrant; both halves for a pair. */
  playerIds: string[];
}) {
  if (!states) return null;

  const resolved = playerIds.map((id) => ({ id, status: states[id] })).filter((r) => r.status);
  if (resolved.length === 0) return null;

  const blocking = resolved.filter((r) => !r.status!.eligible);

  // The common case: everybody on this entry is clear. One line, muted, the
  // same shape /legal uses — and for a pair it is the OLDER of the two dates,
  // because that is when the entry as a whole became eligible.
  if (blocking.length === 0) {
    const oldest = resolved
      .map((r) => r.status!)
      .reduce((a, b) => ((a.signedAt ?? '') <= (b.signedAt ?? '') ? a : b));
    return (
      <span
        className="block font-mono uppercase text-[var(--text-muted)]"
        style={{ fontSize: 10, letterSpacing: '.08em' }}
      >
        {eventWaiverStateLabel(oldest, shortDate)}
      </span>
    );
  }

  // Blocked. Named per person, because on a pair the exec needs to know WHICH
  // half to chase — telling them "this pair cannot play" is the unhelpful
  // version of the same fact.
  return (
    <span
      className="block font-mono uppercase text-[var(--color-warning)]"
      style={{ fontSize: 10, letterSpacing: '.08em' }}
      role="status"
    >
      <span className="sr-only">Event waiver: </span>
      {blocking
        .map((r) =>
          playerIds.length > 1
            ? `${eventWaiverStateLabel(r.status!, shortDate)} — cannot check in`
            : `${eventWaiverStateLabel(r.status!, shortDate)} · cannot check in`,
        )
        .join(' / ')}
    </span>
  );
}

/** Do any of these people block their entry from being checked in? */
export function blocksCheckIn(
  states: Record<string, EventWaiverStatus> | null,
  playerIds: string[],
): boolean {
  if (!states) return false;
  return playerIds.some((id) => states[id] && !states[id]!.eligible);
}
