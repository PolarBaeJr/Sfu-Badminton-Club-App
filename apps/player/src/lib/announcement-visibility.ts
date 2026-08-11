// WHICH ANNOUNCEMENTS A MEMBER CAN ACTUALLY SEE — in one place, because three
// screens ask the question and they were not all giving the same answer.
//
// The rule has three parts and no screen may implement fewer:
//
//   status      published only. RLS enforces this one, so it is the only part
//               that is safe to leave to the database.
//   expiry      expires_at is null, or still in the future.
//   season      00085 gave every row exactly one of two shapes — evergreen
//               (all_seasons, no season_id) or scoped to exactly one season —
//               so "this term's, plus the evergreen ones" has no ambiguous NULL
//               in it. WITH NO ACTIVE SEASON THERE IS NO SEASON FILTER, on
//               purpose: between terms a feed that has gone blank reads to a
//               member as a broken app, and showing everything is the gentler
//               failure. /sessions and the tournament list already do this.
//   audience    target_audience against the viewer's own division. This one
//               cannot go in the query — it is matched against a value that
//               lives on the viewer, not on the row — so it is a predicate the
//               caller applies to what came back.
//
// The season part is what /feed was missing: it filtered on status and expiry
// and nothing else, so a notice retired with last term's season still surfaced
// as the one notice on the home screen while /announcements — which does filter
// on it — no longer listed it. Two screens, two answers, one row.
//
// The season filter is a DIFFERENT SHAPE from the one /feed uses for sessions
// (`season_id.eq.X,season_id.is.null`). Sessions have a nullable season_id;
// announcements have the two-column 00085 shape. Reusing the sessions helper
// here would silently match nothing evergreen.
//
// Lives in apps/player rather than packages/shared: every caller is in this
// app, and shared is imported by the admin console too.

/** The columns any caller needs to select to answer the audience question. */
export const ANNOUNCEMENT_VISIBILITY_COLUMNS = 'id, target_audience';

/** Enough of a member to decide whether a post was addressed to them. */
export interface AnnouncementViewer {
  /** The member's division — 'competitive' | 'recreational' | … (00001:18). */
  status: string | null | undefined;
  eligibility_flag: boolean | null | undefined;
}

/** Enough of a row to decide the same. */
export interface AnnouncementAudienceRow {
  target_audience: string | null | undefined;
}

/**
 * PostgREST `.or()` argument keeping unexpired rows.
 *
 * `expires_at.is.null` first because most rows have no expiry at all.
 */
export function announcementExpiryFilter(nowIso: string): string {
  return `expires_at.is.null,expires_at.gt.${nowIso}`;
}

/**
 * PostgREST `.or()` argument for the season shape, or null when there is no
 * active season and the filter must be dropped entirely (see the note above —
 * dropping it is the designed behaviour, not a fallback).
 */
export function announcementSeasonFilter(activeSeasonId: string | null | undefined): string | null {
  return activeSeasonId ? `all_seasons.eq.true,season_id.eq.${activeSeasonId}` : null;
}

/** The minimum a query builder has to expose for the helper below. */
interface OrFilterable<T> {
  or: (filter: string) => T;
}

/**
 * Applies both query-side parts of the rule to a builder.
 *
 * Two separate `.or()` calls rather than one, because PostgREST ANDs successive
 * `.or()`s — expiry AND season — while folding them into a single call would OR
 * them and let an expired evergreen notice back through.
 */
export function withVisibleAnnouncements<T extends OrFilterable<T>>(
  query: T,
  nowIso: string,
  activeSeasonId: string | null | undefined,
): T {
  const scoped = query.or(announcementExpiryFilter(nowIso));
  const season = announcementSeasonFilter(activeSeasonId);
  return season ? scoped.or(season) : scoped;
}

/**
 * The audience part, applied in JS to rows the query returned.
 *
 * An unrecognised target_audience is NOT shown. The column is an enum in
 * Postgres, so a value this does not know is a value added by a migration that
 * has not reached this code — and showing a post to a division it was not
 * addressed to is the worse of the two failures.
 */
export function isAddressedTo(row: AnnouncementAudienceRow, viewer: AnnouncementViewer): boolean {
  const target = row.target_audience;
  if (target === 'all') return true;
  if (target === 'eligible_only') return Boolean(viewer.eligibility_flag);
  return Boolean(target) && target === viewer.status;
}

/** `isAddressedTo` over a list. */
export function addressedTo<T extends AnnouncementAudienceRow>(rows: T[], viewer: AnnouncementViewer): T[] {
  return rows.filter((row) => isAddressedTo(row, viewer));
}

/**
 * How many of the visible announcements this member has not opened yet.
 *
 * A SET DIFFERENCE, not a subtraction of two counts. The badge used to be
 * `count(all published) − count(my reads)`, which is wrong in both directions
 * at once: a published post the member can never see (expired, another
 * division, last term's season) inflates it forever, and a read row for a post
 * that has since retired deflates it. After a season rollover the badge sat at
 * one or more with nothing behind it to click, and the redesign that dropped
 * the per-row NEW tag made that badge the only unread signal there is.
 *
 * `visibleIds` must already have had the whole rule applied to it.
 */
export function unreadAnnouncementCount(visibleIds: string[], readIds: Iterable<string>): number {
  const read = new Set(readIds);
  return new Set(visibleIds.filter((id) => !read.has(id))).size;
}
