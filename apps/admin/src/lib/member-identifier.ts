// The line of small mono text under a member's name on the roster.
//
// WHY THIS IS NOT @badminton/shared's formatMemberNumber. That function is
// typed `number` and pads to four digits, which is the right answer for the
// column AS IT IS STORED TODAY (00092: a sequential integer). The column is
// mid-change to a seven-character code, and on the day it lands every caller
// typed to `number` is a compile error and every caller that pads is printing
// `#00AB12X`. Routing the roster through one local function means the shape
// change is one edit here rather than a hunt through JSX — and it means the
// roster keeps rendering whichever of the two shapes the database currently
// holds, which is the state a migration actually passes through.
//
// It lives in apps/admin rather than in packages/shared because the brief for
// this screen forbids touching the shared packages; shared's version is left
// exactly as its own callers found it.

/**
 * `#0042` for the integer the column holds today, `#ABC1234` for the code it is
 * becoming. Padding is applied ONLY to a purely numeric value — a code is not a
 * number and zero-padding one would invent characters that are not in it.
 *
 * Returns null for a member who has none: a pending signup is not assigned one
 * until they are approved, and the caller drops the line rather than drawing a
 * bare `#`.
 */
export function formatMemberIdentifier(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  const raw = String(value).trim();
  if (raw === '') return null;
  if (/^\d+$/.test(raw)) return `#${raw.padStart(4, '0')}`;
  return `#${raw.toUpperCase()}`;
}

/**
 * What identifies this member under their name, in order of what a person would
 * actually recognise: the handle they chose, else the number the club assigned.
 *
 * The handle is nullable and is null for everyone who has not picked one, which
 * is why the fallback exists at all. Returns null when there is neither — a
 * pending signup with no handle yet — and the row then shows their name alone.
 */
export function memberIdentifier(player: {
  handle?: string | null;
  member_number?: string | number | null;
}): string | null {
  const handle = player.handle?.trim();
  if (handle) return `@${handle}`;
  return formatMemberIdentifier(player.member_number);
}
