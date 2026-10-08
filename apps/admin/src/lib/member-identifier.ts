import { formatMemberCode } from '@badminton/shared';

// The line of small mono text under a member's name on the roster.
//
// THIS USED TO CARRY ITS OWN FORMATTER, and the reason it did has now gone. The
// column was mid-change from a sequential integer to a seven-character code, so
// shared's formatter was typed `number` and padded to four digits while this
// screen had to keep rendering whichever of the two shapes the database
// currently held. 00092 settles it: there is one shape, shared's formatter
// speaks it, and a second copy here would only be a second thing to keep in
// step. What is left is the CHOICE below, which is genuinely this screen's.

/**
 * What identifies this member under their name, in order of what a person would
 * actually recognise: the handle they chose, else the code the club assigned.
 *
 * The handle is nullable and is null for everyone who has not picked one, which
 * is why the fallback exists at all. Returns null when there is neither — a
 * pending signup, which has no code until it is approved — and the row then
 * shows their name alone.
 */
export function memberIdentifier(player: {
  handle?: string | null;
  member_code?: string | null;
}): string | null {
  const handle = player.handle?.trim();
  if (handle) return `@${handle}`;
  return formatMemberCode(player.member_code);
}
