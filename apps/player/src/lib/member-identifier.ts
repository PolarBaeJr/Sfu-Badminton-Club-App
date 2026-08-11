import { formatMemberNumber } from '@badminton/shared';

/**
 * ────────────────────────────────────────────────────────────────────────────
 * SEAM. The member identifier is mid-change and this is the only place on
 * /my-stats that knows its shape.
 * ────────────────────────────────────────────────────────────────────────────
 *
 * Today `players.member_number` is an INTEGER assigned by a sequence at
 * approval (00092) and shown zero-padded as `#0042`. The owner intends it to
 * become a random seven-character code, and that conversion is unfinished on
 * another branch. Neither shape is settled enough to be written into a page.
 *
 * So the page asks this function, not the column. When the column becomes a
 * code, the change is the branch below and nothing else: no display logic on
 * the profile card, no padding assumption, no `#${n}` template to hunt for.
 *
 * `unknown` is the parameter type on purpose. Typing it `number | null` would
 * make the day the column turns into text a compile error in the page rather
 * than a no-op here, which is exactly backwards — the point of a seam is that
 * the far side of it does not move.
 *
 * Returns null when there is nothing to show. A member who is still pending
 * approval has no number yet, and the caller omits the line rather than drawing
 * a bare `MEMBER`.
 */
export function formatMemberIdentifier(value: unknown): string | null {
  if (value === null || value === undefined) return null;

  // The current shape: a sequential integer, zero-padded by the shared
  // formatter so this page and the settings page agree on the padding.
  if (typeof value === 'number' && Number.isFinite(value)) {
    return formatMemberNumber(value);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    // A numeric string is still the integer form — Postgres BIGINT arrives as
    // text through some clients, and padding it differently from the same value
    // arriving as a number would be a visible inconsistency for no reason.
    if (/^\d+$/.test(trimmed)) return formatMemberNumber(Number(trimmed));
    // The future shape: an opaque code. Upper-cased because it is read aloud
    // and typed by hand, never sorted or compared here.
    return `#${trimmed.toUpperCase()}`;
  }

  return null;
}
