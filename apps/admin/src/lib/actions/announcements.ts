'use server';

import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { notifyPlayers } from '../notify';
import { revalidatePath } from 'next/cache';
import { parseOrThrow, announcementSchema, ExpectedError, requireActiveSeasonId } from '@badminton/shared';
import { requireCapability } from './_shared';

type Audience = 'all' | 'competitive' | 'recreational' | 'eligible_only';

// Resolve which players an announcement's audience targets — mirrors the
// viewer-side filter in the player app's announcements page (all / status
// match / eligibility_flag). Excludes the publishing admin so they don't
// notify themselves.
async function resolveAudiencePlayerIds(
  adminClient: ReturnType<typeof createAdminClient>,
  audience: Audience,
  excludePlayerId: string,
): Promise<string[]> {
  // 00132: NEVER an unfinished signup, on any audience. Since the `players` row
  // is written at first sign-in, `all` — which has no status filter, by design,
  // so it matches the player-side view — would otherwise resolve to include
  // people who signed up, never gave a name and never came back. They would get
  // a bell row and, when the admin ticks "send push", a web push about a club
  // they have not joined. On an announcement channel that reaches real inboxes
  // and real lock screens that is the wrong first-week surprise, and it is the
  // one query where a stub could reach the outside world.
  //
  // Applied to every audience rather than only to `all`: a stub carries
  // status='pending_approval' and eligibility_flag=false, so it matches none of
  // the other three today — the filter is here so that stays true if any of
  // those predicates ever widen.
  let query = adminClient
    .from('players')
    .select('id')
    .or('onboarding_completed.is.true,user_id.is.null');
  if (audience === 'competitive') query = query.eq('status', 'competitive');
  else if (audience === 'recreational') query = query.eq('status', 'recreational');
  else if (audience === 'eligible_only') query = query.eq('eligibility_flag', true);
  // 'all' → no status filter (every player, matching the player-side view).

  const { data, error } = await query;
  if (error) throw new Error(error.message);
  return (data ?? []).map((r) => r.id).filter((id) => id !== excludePlayerId);
}

// Notify targeted players that a published announcement is live: an in-app
// bell row for everyone in the audience, plus a web push when the admin ticked
// "send push". Best-effort — never allowed to fail the publish itself.
async function dispatchAnnouncementNotifications(
  adminClient: ReturnType<typeof createAdminClient>,
  announcement: { id: string; title: string; body: string; target_audience: Audience; send_push: boolean },
  authorId: string,
): Promise<void> {
  const playerIds = await resolveAudiencePlayerIds(adminClient, announcement.target_audience, authorId);
  const preview = announcement.body.length > 140 ? `${announcement.body.slice(0, 139)}…` : announcement.body;
  await notifyPlayers(
    adminClient,
    playerIds,
    {
      type: 'general',
      title: announcement.title,
      body: preview,
      metadata: { announcement_id: announcement.id, kind: 'announcement' },
    },
    announcement.send_push ? { title: announcement.title, body: preview, url: '/announcements' } : undefined,
    'announcements',
  );
}

export async function createAnnouncement(data: {
  title: string;
  body: string;
  type: 'info' | 'warning' | 'urgent' | 'event';
  target_audience: 'all' | 'competitive' | 'recreational' | 'eligible_only';
  pinned: boolean;
  send_push: boolean;
  status: 'draft' | 'published';
  expires_at?: string;
  /** Evergreen — club rules, the door code — rather than tied to this term. */
  all_seasons?: boolean;
}) {
  parseOrThrow(announcementSchema, data);
  const admin = await requireCapability('announcements.create.write');
  const adminClient = createAdminClient();

  // A term-specific announcement belongs to the season being played, and
  // retires with it. Evergreen ones carry no season at all — the CHECK in 00085
  // allows exactly those two shapes, so this cannot produce an ambiguous NULL.
  //
  // Refusing when nothing is active matches every other season-stamped write
  // (requireActiveSeasonId): an announcement filed against no season would show
  // in every future term forever, which is the behaviour being fixed.
  let seasonId: string | null = null;
  if (!data.all_seasons) {
    const { data: activeSeason } = await adminClient
      .from('seasons').select('id').eq('active_flag', true).maybeSingle();
    seasonId = requireActiveSeasonId(activeSeason?.id, 'announcement');
  }

  const { data: announcement, error } = await adminClient.from('announcements').insert({
    season_id: seasonId,
    all_seasons: data.all_seasons ?? false,
    title: data.title,
    body: data.body,
    type: data.type,
    target_audience: data.target_audience,
    pinned: data.pinned,
    send_push: data.send_push,
    status: data.status,
    expires_at: data.expires_at || null,
    author_id: admin.id,
  }).select().single();

  if (error) throw new Error(error.message);

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'announcement_created',
    target_type: 'announcement',
    target_id: announcement.id,
    new_value: data,
  });

  // Only a published announcement reaches members; drafts stay silent until
  // they're published (handled by the draft→published path in updateAnnouncement).
  if (data.status === 'published') {
    await dispatchAnnouncementNotifications(adminClient, {
      id: announcement.id,
      title: data.title,
      body: data.body,
      target_audience: data.target_audience,
      send_push: data.send_push,
    }, admin.id);
  }

  revalidatePath('/announcements');
  return announcement;
}

/**
 * Editing a LIVE post is audited, so it takes a typed reason.
 *
 * Members have already read a published announcement; changing what it says
 * changes the club's record of what was said, and `announcement_updated` was
 * being written with a before and an after and no explanation of why the words
 * moved. Anyone reading the log back could see that a court closure became a
 * different court closure and not whether that was a correction or a new
 * decision.
 *
 * A DRAFT is exempt. Nothing has been said to anybody yet, so demanding prose
 * to fix a typo before posting is friction with no record to protect. The test
 * is the STORED status, not the status the client sends — a caller cannot
 * excuse itself from the reason by claiming the row is a draft.
 */
export async function updateAnnouncement(announcementId: string, data: {
  title: string;
  body: string;
  type: 'info' | 'warning' | 'urgent' | 'event';
  target_audience: 'all' | 'competitive' | 'recreational' | 'eligible_only';
  pinned: boolean;
  send_push: boolean;
  status: 'draft' | 'published';
  expires_at?: string;
}, reason?: string) {
  parseOrThrow(announcementSchema, data);
  const admin = await requireCapability('announcements.update.write');
  const adminClient = createAdminClient();

  const { data: old } = await adminClient.from('announcements').select('*').eq('id', announcementId).single();

  const trimmedReason = (reason ?? '').trim();
  if (old?.status === 'published' && !trimmedReason) {
    throw new ExpectedError(
      'This post is live and members have already read it — say why it is changing.',
    );
  }

  const { error, count } = await adminClient.from('announcements').update({
    title: data.title,
    body: data.body,
    type: data.type,
    target_audience: data.target_audience,
    pinned: data.pinned,
    send_push: data.send_push,
    status: data.status,
    expires_at: data.expires_at || null,
  }, { count: 'exact' }).eq('id', announcementId);

  if (error) throw new Error(error.message);
  // PostgREST reports "matched no rows" as success, so without the count an
  // edit to an announcement somebody else had already deleted returned cleanly
  // and the page said "Announcement updated" — for a row that does not exist.
  // Found on staging by deleting the row while the edit dialog was open.
  if (count === 0) {
    throw new ExpectedError(
      'That announcement no longer exists — it was deleted while you were editing it. Nothing was saved.',
    );
  }

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'announcement_updated',
    target_type: 'announcement',
    target_id: announcementId,
    old_value: old,
    new_value: data,
    // Absent for a draft edit, which is deliberate — see the note above.
    ...(trimmedReason ? { reason: trimmedReason } : {}),
  }, { announcementId });

  // Notify only on the draft→published transition — editing an already-published
  // announcement must not re-blast everyone on every save.
  if (data.status === 'published' && old?.status !== 'published') {
    await dispatchAnnouncementNotifications(adminClient, {
      id: announcementId,
      title: data.title,
      body: data.body,
      target_audience: data.target_audience,
      send_push: data.send_push,
    }, admin.id);
  }

  revalidatePath('/announcements');
}

/**
 * Deleting a post is audited, so it takes a typed reason.
 *
 * A published announcement is the club's record of having said something, and
 * `announcement_deleted` was being written with no explanation at all — the
 * audit row named the actor and the row, and nobody reading it back could tell
 * whether the post was wrong, superseded or posted to the wrong audience. The
 * dialog keeps its confirm disabled until this has content; checked again here
 * because the dialog is not the boundary.
 */
export async function deleteAnnouncement(announcementId: string, reason: string) {
  const trimmedReason = (reason ?? '').trim();
  if (!trimmedReason) {
    throw new ExpectedError('Deleting an announcement needs a reason — say why it is going.');
  }

  const admin = await requireCapability('announcements.delete.write');
  const adminClient = createAdminClient();

  const { data: old } = await adminClient.from('announcements').select('*').eq('id', announcementId).single();

  // THE BELL ROWS GO WITH THE POST.
  //
  // `announcement_reads` needs nothing here — its FK is ON DELETE CASCADE
  // (00001_schema.sql:616), so the delete below takes the receipts with it. The
  // explicit sweep that used to sit on this line was a round trip that deleted
  // rows Postgres was about to delete anyway.
  //
  // `notifications` is the one that does NOT cascade. It carries no FK at all:
  // the only link to the post is `metadata.announcement_id`, written by
  // dispatchAnnouncementNotifications above, so nothing in the schema cleans it
  // up and every published post left a bell row per member behind it.
  //
  // Deleted rather than left with a destination, and the destination is why.
  // notificationAction() (player app, lib/notification-rows.ts:179) routes a
  // `general` row with an announcement_id to `/announcements` — a list, so the
  // tap is not a 404. But the row's headline is the FIRST 140 CHARACTERS OF THE
  // POST ITSELF, and this delete is audited with a typed reason: the club is
  // retracting what it said. Keeping the row keeps the retracted words on every
  // member's notification screen, under a Read button leading to a list that no
  // longer contains them. There is nothing graceful left to point at.
  //
  // Ahead of the announcement delete on purpose. If this fails the action fails
  // with nothing removed and no audit row written, and the admin can retry;
  // doing it afterwards would leave the post gone, the rows behind and the log
  // claiming a clean delete.
  const { error: notificationError } = await adminClient
    .from('notifications')
    .delete()
    .eq('metadata->>announcement_id', announcementId);
  if (notificationError) throw new Error(notificationError.message);

  const { error, count } = await adminClient
    .from('announcements')
    .delete({ count: 'exact' })
    .eq('id', announcementId);
  if (error) throw new Error(error.message);
  // Same trap as the update above: a delete that matched nothing is reported as
  // success, so deleting an announcement somebody else had already removed said
  // "Announcement deleted" and wrote an audit row for it.
  if (count === 0) {
    throw new ExpectedError('That announcement no longer exists — somebody else has already deleted it.');
  }

  await logAdminAudit(adminClient, {
    actor_id: admin.id,
    action_type: 'announcement_deleted',
    target_type: 'announcement',
    target_id: announcementId,
    old_value: old,
    reason: trimmedReason,
  }, { announcementId });

  revalidatePath('/announcements');
}
