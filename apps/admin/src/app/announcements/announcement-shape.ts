// Vocabulary and arithmetic for the announcements screen, kept out of the
// server component so the risky parts (the reach percentage, the byline) are
// plain functions a test can drive.
//
// Every option list here is the DATABASE enum, not a nicer-sounding invention:
// `announcement_type` and `announcement_audience` are declared in
// 00001_schema.sql (595 and 597) and a value outside them is rejected by
// Postgres, so a select offering anything else builds a form that cannot save.

export type AnnouncementType = 'info' | 'warning' | 'urgent' | 'event';
export type AnnouncementStatus = 'draft' | 'published';
export type TargetAudience = 'all' | 'competitive' | 'recreational' | 'eligible_only';

type BadgeVariant = 'default' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';

/** `announcement_type` (00001:595). These four, and there is no fifth. */
export const TYPE_OPTIONS: { value: AnnouncementType; label: string }[] = [
  { value: 'info', label: 'Info' },
  { value: 'warning', label: 'Warning' },
  { value: 'urgent', label: 'Urgent' },
  { value: 'event', label: 'Event' },
];

/** `announcement_audience` (00001:597). */
export const AUDIENCE_OPTIONS: { value: TargetAudience; label: string }[] = [
  { value: 'all', label: 'Every member' },
  { value: 'competitive', label: 'Competitive members' },
  { value: 'recreational', label: 'Recreational members' },
  { value: 'eligible_only', label: 'Eligible members only' },
];

export const STATUS_OPTIONS: { value: AnnouncementStatus; label: string }[] = [
  { value: 'draft', label: 'Draft' },
  { value: 'published', label: 'Published' },
];

const TYPE_BADGES: Record<AnnouncementType, { variant: BadgeVariant; label: string }> = {
  info: { variant: 'neutral', label: 'INFO' },
  warning: { variant: 'warning', label: 'WARNING' },
  urgent: { variant: 'danger', label: 'URGENT' },
  event: { variant: 'success', label: 'EVENT' },
};

/**
 * A category's pill, with a fallback that survives a value this build has never
 * heard of. The map this replaced was a bare `Record<Type, …>` lookup: add a
 * fifth member to the enum in a migration and every row rendered
 * `undefined` into the variant prop, which is a crash rather than a wrong
 * colour. An unknown category is shown as itself, neutral.
 */
export function typeBadge(type: string): { variant: BadgeVariant; label: string } {
  return TYPE_BADGES[type as AnnouncementType] ?? { variant: 'neutral', label: type.toUpperCase() };
}

export function audienceLabel(audience: string): string {
  return AUDIENCE_OPTIONS.find((o) => o.value === audience)?.label ?? audience;
}

/**
 * Opens as a percentage of the people the post was actually SENT to.
 *
 * The denominator is the targeted audience, never the whole membership: a post
 * aimed at `competitive` never reached a recreational member, and dividing its
 * opens by total headcount reports a failure that never happened. The caller
 * resolves the audience with the same three-branch filter the publisher uses
 * (resolveAudiencePlayerIds in lib/actions/announcements.ts).
 *
 * Clamped at 100 because `announcement_reads` is not constrained to the
 * audience — RLS lets any authenticated member read any published post
 * (00005:384), and marking it read inserts a receipt (00005:399). A member
 * outside the target audience who opens the post therefore adds to the
 * numerator and not the denominator, and an uncapped ratio renders `104%`.
 *
 * Returns null when there is nobody to divide by; the caller shows the bare
 * count rather than a percentage of zero.
 */
export function reachPercent(opened: number, audienceSize: number): number | null {
  if (audienceSize <= 0) return null;
  return Math.min(100, Math.round((opened / audienceSize) * 100));
}

/**
 * Read receipts bucketed by post — the arithmetic the screen used to make
 * Postgres do once per published announcement.
 *
 * `announcement_reads` has no aggregate endpoint through PostgREST (no GROUP
 * BY), so the page pages the receipts and counts them here. That trades N round
 * trips, one per post, for ceil(receipts / 1000) — and the post count is the one
 * that only ever grows, since nothing retires an announcement from this screen.
 *
 * COUNTS STAY EXACT. Nothing is sampled, estimated or capped: every receipt the
 * caller read is counted, and a receipt for a post that is not in `publishedIds`
 * is skipped rather than folded into a total.
 *
 * PUBLISHED POSTS ONLY, seeded to zero. A draft was never sent to anybody, so it
 * must come back absent rather than as `0` — "0 opened" on a draft is not a
 * reach figure, it is a category error, and the caller distinguishes the two by
 * whether the map has the key at all.
 */
export function tallyOpens(
  receipts: Array<{ announcement_id: string }>,
  publishedIds: Iterable<string>,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const id of publishedIds) counts.set(id, 0);

  for (const receipt of receipts) {
    const current = counts.get(receipt.announcement_id);
    if (current === undefined) continue;
    counts.set(receipt.announcement_id, current + 1);
  }

  return counts;
}

/**
 * "Alice Mercer" → "A. MERCER". The byline is a mono micro-label at 10px, and
 * a full name at that size in a 480px rail wraps onto the counts beside it.
 *
 * A single-word name keeps its whole self — "A." would name nobody.
 */
export function bylineName(name: string | null | undefined): string | null {
  const trimmed = (name ?? '').trim();
  if (!trimmed) return null;
  const parts = trimmed.split(/\s+/);
  const first = parts[0] ?? '';
  const surname = parts[parts.length - 1] ?? '';
  if (parts.length === 1) return first.toUpperCase();
  return `${first.slice(0, 1).toUpperCase()}. ${surname.toUpperCase()}`;
}

/** Short, unambiguous, and stable regardless of the reader's locale settings. */
export function shortDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d
    .toLocaleDateString('en-CA', { day: '2-digit', month: 'short' })
    .toUpperCase()
    .replace(/\./g, '');
}
