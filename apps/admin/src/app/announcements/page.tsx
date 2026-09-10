export const dynamic = 'force-dynamic';

import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { Card, Badge, PageHeader, ResponsiveTable, TableCard, Atomic, EmptyState } from '@badminton/ui';
import { isPushCategoryEnabled } from '@badminton/shared';
import { accessLevelFor, permissionsOf, permits, type Capability } from '@/lib/permissions';
import {
  AnnouncementRowActions,
  type DiscordContext,
  type RowAnnouncement,
} from './actions';
import { DiscordRecent, type OutboxRow } from './discord-send';
import { ComposerSwitch } from './composer-switch';
import {
  audienceLabel,
  bylineName,
  composerModes,
  reachPercent,
  relayChip,
  shortDate,
  tallyOpens,
  typeBadge,
  type PostedMapping,
  type AnnouncementStatus,
  type AnnouncementType,
  type TargetAudience,
} from './announcement-shape';

const MICRO = 'font-mono text-[10px] uppercase tracking-[0.16em]';

/** See the note where it is used. Matches MAX_MAPPED in the relay route. */
const MAX_MAPPING_LOOKUP = 150;

interface Row {
  id: string;
  title: string;
  body: string;
  type: AnnouncementType;
  author_id: string | null;
  pinned: boolean;
  send_push: boolean;
  target_audience: TargetAudience;
  expires_at: string | null;
  status: AnnouncementStatus;
  created_at: string;
  /**
   * The relay's freshness column, not created_at. A notice drafted in August
   * and published today reads as today's to the relay, and the Discord chip has
   * to answer the same way or it will call a live post stale.
   */
  updated_at: string | null;
}

/**
 * How many members each audience actually contains.
 *
 * The three branches are `resolveAudiencePlayerIds`
 * (lib/actions/announcements.ts:16) — the function the PUBLISHER uses to decide
 * who a post goes to — so the denominator on this screen is the same set the
 * post was sent to. Counting against total membership instead would report a
 * competitive-only post as having missed every recreational member, which is a
 * different lie from the one the reach card exists to avoid.
 *
 * head + exact: a COUNT on the server, no rows over the wire, and no 1000-row
 * cap to undercount past. Nothing about the roster enters the RSC payload.
 */
async function audienceSizes(
  supabase: ReturnType<typeof createAdminClient>,
): Promise<Record<TargetAudience, number>> {
  const [all, competitive, recreational, eligible] = await Promise.all([
    supabase.from('players').select('id', { count: 'exact', head: true }),
    supabase.from('players').select('id', { count: 'exact', head: true }).eq('status', 'competitive'),
    supabase.from('players').select('id', { count: 'exact', head: true }).eq('status', 'recreational'),
    supabase.from('players').select('id', { count: 'exact', head: true }).eq('eligibility_flag', true),
  ]);

  return {
    all: all.count ?? 0,
    competitive: competitive.count ?? 0,
    recreational: recreational.count ?? 0,
    eligible_only: eligible.count ?? 0,
  };
}

/**
 * Members a push would actually buzz: an ACTIVE subscription (the exact filter
 * sendPushToPlayers uses, packages/shared/src/push/send.ts:31) and the
 * announcements category switched on in their preferences (00058 made push
 * opt-in, and filterPushRecipients fails closed on it).
 *
 * Both reads are paged for the same reason the seasons page pages: PostgREST
 * caps a response at 1000 rows, and a silent undercount in a mono number is
 * worse than no number. Advancing by what came back rather than by the window
 * is correct under any server-side cap.
 */
async function pushReachableCount(
  supabase: ReturnType<typeof createAdminClient>,
): Promise<number> {
  const PAGE = 1000;

  const subscribed = new Set<string>();
  for (let from = 0, guard = 0; guard < 100; guard++) {
    const { data, error } = await supabase
      .from('push_subscriptions')
      .select('player_id')
      .eq('active', true)
      .order('id')
      .range(from, from + PAGE - 1);
    if (error || !data || data.length === 0) break;
    for (const row of data) subscribed.add(row.player_id);
    from += data.length;
  }
  if (subscribed.size === 0) return 0;

  let reachable = 0;
  for (let from = 0, guard = 0; guard < 100; guard++) {
    const { data, error } = await supabase
      .from('players')
      .select('id, notification_preferences')
      .order('id')
      .range(from, from + PAGE - 1);
    if (error || !data || data.length === 0) break;
    for (const player of data) {
      if (!subscribed.has(player.id)) continue;
      if (isPushCategoryEnabled(player.notification_preferences, 'announcements')) reachable++;
    }
    from += data.length;
  }
  return reachable;
}

/**
 * Read receipts per post.
 *
 * `announcement_reads` is a real table with a real unique constraint
 * (00001:614) and the player app inserts a row when a member opens a post
 * (apps/player/src/lib/actions/notifications.ts:54), so this count is the
 * genuine article rather than an estimate.
 *
 * ONE READ FOR THE WHOLE SCREEN, not one per post. This was a `head: true`
 * count per published announcement, which is a query count that rises with the
 * post count on a `force-dynamic` page with no list limit — and unlike the
 * seasons page it copied, nothing ever retires an announcement from this list.
 * PostgREST has no GROUP BY, so the receipts are paged in and bucketed by
 * tallyOpens(): ceil(receipts / 1000) round trips instead of N, and the figures
 * stay exact because every receipt is counted rather than sampled.
 *
 * PAGED, AND NOT FILTERED TO THE POSTS ON SCREEN. An `.in(publishedIds)` would
 * put every announcement id in a query string, which is a URL that grows without
 * bound on exactly the table that grows without bound. It buys nothing either:
 * `announcement_reads.announcement_id` is ON DELETE CASCADE (00001:616), so
 * there are no receipts for posts that no longer exist, and tallyOpens ignores
 * any row whose post is not on this screen.
 *
 * Advancing by what came back rather than by the window is correct under any
 * server-side cap — the same loop shape as pushReachableCount above.
 *
 * Published posts only, which tallyOpens enforces by seeding the map with those
 * ids. A draft was never sent to anybody, so "0 opened" on one is not a reach
 * figure, it is a category error.
 */
async function openedCounts(
  supabase: ReturnType<typeof createAdminClient>,
  rows: Row[],
): Promise<Map<string, number>> {
  const published = rows.filter((r) => r.status === 'published');
  if (published.length === 0) return new Map();

  const PAGE = 1000;
  // A HIGHER CEILING THAN THE TWO LOOPS ABOVE, on purpose. Those page `players`
  // and `push_subscriptions`, which are bounded by the club's membership, so 100
  // windows is a runaway guard there and nothing else. This table is posts ×
  // members — the one that grows without bound, which is the whole reason this
  // function was rewritten — and stopping at 100 windows would silently
  // undercount past 100k receipts. That is the same bounded-list assumption,
  // carried into the unbounded case, that the per-post count queries made.
  const MAX_WINDOWS = 1000;
  const receipts: Array<{ announcement_id: string }> = [];
  for (let from = 0, guard = 0; guard < MAX_WINDOWS; guard++) {
    const { data, error } = await supabase
      .from('announcement_reads')
      .select('announcement_id')
      .order('id')
      .range(from, from + PAGE - 1);
    if (error || !data || data.length === 0) break;
    for (const row of data) receipts.push({ announcement_id: row.announcement_id as string });
    from += data.length;
  }

  return tallyOpens(receipts, published.map((r) => r.id));
}

export default async function AnnouncementsPage() {
  // The door, and the only capability the announcement data itself answers to.
  //
  // Every announcements read below is gated by THIS and nothing narrower, which
  // is a statement about the vocabulary rather than an omission: `announcements`
  // has one page key and three writes — there is no `announcements.read` to
  // gate a query on, and inventing one would move an answer in the
  // capability-equivalence table. The seasons page says the same thing about
  // `seasons.*` for the same reason (app/seasons/page.tsx, ~line 90).
  const viewer = await requireCapability('announcements.page');
  const level = accessLevelFor(viewer);
  const permissions = permissionsOf(accessLevelFor(viewer), viewer);
  const may = (capability: Capability) => permits(level, permissions, capability);

  const canCreate = may('announcements.create.write');
  const canUpdate = may('announcements.update.write');
  const canDelete = may('announcements.delete.write');

  // A SEPARATE KEY FROM THE THREE ABOVE, and not a fourth way to write an
  // announcement. This one reaches the club's Discord channel — a different
  // audience by a different route, and nothing on this page can take a posted
  // Discord message back the way unpublishing takes an announcement down.
  const canSendDiscord = may('announcements.discord.write');

  // Which composers the left card offers, decided in one place so a test can
  // drive all four capability combinations.
  const modes = composerModes({ canCreate, canSendDiscord });

  // THE ROSTER IS A DIFFERENT AREA, and every number on this screen drawn from
  // `players` is behind its key. This gate is around the AWAIT, not around the
  // JSX: a fetch that runs and is then conditionally rendered still ships its
  // rows in the RSC payload, which is a leak with a tidy-looking page on top.
  const mayReadPlayers = may('players.read');

  const supabase = createAdminClient();

  const { data: announcements } = await supabase
    .from('announcements')
    // Explicit, so the payload carries the columns this screen draws and not
    // whatever the table gains next.
    .select(
      'id, title, body, type, author_id, pinned, send_push, target_audience, expires_at, status, created_at, updated_at',
    )
    .order('pinned', { ascending: false })
    .order('created_at', { ascending: false });

  const rows = (announcements ?? []) as Row[];

  const opened = await openedCounts(supabase, rows);

  // WHAT DISCORD ALREADY HAS, AND WHETHER IT IS LISTENING AT ALL.
  //
  // Two cheap reads that turn the relay from invisible into something a person
  // can see before they publish. Neither is gated separately: both are
  // announcements data, and this page has exactly one key (see the note on the
  // gate above). Failures are not named — a preview that cannot say what
  // Discord holds is a missing panel, not a broken page, and degrading to
  // "nothing is configured" is the honest reading of "we could not find out".
  //
  // The id list is CAPPED for the reason the relay route caps its own (see
  // MAX_MAPPED there): it is spelled out in the query string, and an unbounded
  // list eventually meets a request-line limit in front of PostgREST. Rows past
  // the cap are the oldest, and they get NO chip rather than a wrong one —
  // "we did not ask" and "it is not in Discord" must not render the same.
  const asked = new Set(rows.slice(0, MAX_MAPPING_LOOKUP).map((r) => r.id));

  const [settingsResult, postsResult] = await Promise.all([
    supabase.from('discord_settings').select('key, value').eq('key', 'announcement_channel_id'),
    asked.size
      ? supabase
          .from('discord_announcement_posts')
          .select('announcement_id, synced_title, synced_body, synced_type')
          .in('announcement_id', [...asked])
      : Promise.resolve({ data: [], error: null }),
  ]);

  const channelConfigured = Boolean(
    ((settingsResult.data ?? []) as { key: string; value: string }[])[0]?.value?.trim(),
  );

  // Keyed by announcement, not by guild. The club runs one server; if it ever
  // ran two, "already in Discord somewhere" is still the true answer to the
  // only question this map is asked.
  const postedByAnnouncement = new Map<string, PostedMapping>(
    (
      (postsResult.data ?? []) as {
        announcement_id: string;
        synced_title: string;
        synced_body: string;
        synced_type: string;
      }[]
    ).map((m) => [
      m.announcement_id,
      { syncedTitle: m.synced_title, syncedBody: m.synced_body, syncedType: m.synced_type },
    ]),
  );

  // The link the relay puts on the embed title, built the same way the route
  // builds it so the preview's title is a link exactly when the real one is.
  const appUrl = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, '') ?? null;
  const discord: DiscordContext = {
    channelConfigured,
    announcementsUrl: appUrl ? `${appUrl}/announcements` : null,
  };

  const now = Date.now();

  // THE GATE IS AROUND THE AWAIT, not around the JSX — the same rule the roster
  // reads follow above. A query that runs and is then conditionally rendered
  // still ships its rows in the RSC payload, and these rows quote what the club
  // said in its own channel.
  const outboxRows: OutboxRow[] = canSendDiscord
    ? await supabase
        .from('discord_outbox')
        .select(
          'id, created_at, channel_id, content, embed_title, ping, sent_at, failed_at, last_error',
        )
        .order('created_at', { ascending: false })
        .limit(5)
        .then(({ data }) =>
          (
            (data ?? []) as {
              id: string;
              created_at: string;
              channel_id: string;
              content: string | null;
              embed_title: string | null;
              ping: boolean;
              sent_at: string | null;
              failed_at: string | null;
              last_error: string | null;
            }[]
          ).map((r) => ({
            id: r.id,
            createdAt: r.created_at,
            channelId: r.channel_id,
            // One line, whichever shape it was. The full text is in the audit
            // log; this list exists to answer "did it go out", not to re-read
            // the message.
            preview: (r.content ?? r.embed_title ?? '').slice(0, 140),
            ping: r.ping,
            state: r.sent_at ? 'sent' : r.failed_at ? 'failed' : 'queued',
            error: r.last_error,
          })),
        )
    : [];

  // Three roster-derived reads, all behind `players.read`, all skipped
  // outright when it is not held.
  const authorIds = [...new Set(rows.map((r) => r.author_id).filter((id): id is string => !!id))];

  const [sizes, pushReachable, authors] = mayReadPlayers
    ? await Promise.all([
        audienceSizes(supabase),
        pushReachableCount(supabase),
        authorIds.length
          ? supabase
              .from('players')
              .select('id, full_name, display_name')
              .in('id', authorIds)
              .then(({ data }) =>
                new Map(
                  (data ?? []).map((p) => [
                    p.id as string,
                    bylineName((p.display_name as string | null) ?? (p.full_name as string | null)),
                  ]),
                ),
              )
          : Promise.resolve(new Map<string, string | null>()),
      ])
    : [null, null, new Map<string, string | null>()];

  const memberCount = sizes?.all ?? null;

  // The reach card answers for the most recent PUBLISHED post. A draft has no
  // reach, and the newest row may well be one.
  const lastPost = rows.find((r) => r.status === 'published') ?? null;
  const lastOpened = lastPost ? (opened.get(lastPost.id) ?? 0) : 0;
  const lastAudience = lastPost && sizes ? sizes[lastPost.target_audience] : null;
  const lastPercent =
    lastPost && lastAudience !== null ? reachPercent(lastOpened, lastAudience) : null;

  const byline = (row: Row) => {
    const parts: string[] = [];
    const author = row.author_id ? authors.get(row.author_id) : null;
    if (author) parts.push(author);
    if (row.status === 'published') {
      const count = opened.get(row.id) ?? 0;
      parts.push(`${count} opened`);
    }
    if (row.send_push) parts.push('pushed');
    return parts.length ? parts.join(' · ') : null;
  };

  /**
   * Two words per row about the Discord relay, or nothing.
   *
   * Nothing in three cases, all of them "we cannot say": the row is past the
   * mapping lookup cap, no channel is configured, or it is a draft — where the
   * DRAFT badge beside it already says the same thing in different words.
   */
  const discordChip = (row: Row) =>
    asked.has(row.id)
      ? relayChip(row, {
          now,
          channelConfigured,
          posted: postedByAnnouncement.get(row.id) ?? null,
        })
      : null;

  const rowActions = (row: Row) => (
    <AnnouncementRowActions
      announcement={
        {
          id: row.id,
          title: row.title,
          body: row.body,
          type: row.type,
          target_audience: row.target_audience,
          pinned: row.pinned,
          send_push: row.send_push,
          status: row.status,
          expires_at: row.expires_at,
        } satisfies RowAnnouncement
      }
      canUpdate={canUpdate}
      canDelete={canDelete}
      pushReachable={pushReachable}
      discord={discord}
      posted={postedByAnnouncement.get(row.id) ?? null}
    />
  );

  return (
    <div className="flex flex-col gap-6 p-6">
      <PageHeader
        eyebrow={memberCount === null ? 'Comms' : `Comms · ${memberCount} members`}
        title="Announcements"
        sub="One post, straight to every phone in the club."
        watermark="N"
      />

      <div className="grid grid-cols-1 lg:grid-cols-[1.4fr_1fr] gap-5 items-start">
        {/* ---------------------------------------------------------------- */}
        {/* LEFT — the composer, and what Discord already has                */}
        {/* ---------------------------------------------------------------- */}
        <div className="flex flex-col gap-5">
          <Card className="p-5">
            {/* `modes.length > 0`, NOT `canCreate` — and that is a deliberate
                behaviour change. Until now a viewer holding
                `announcements.discord.write` but not
                `announcements.create.write` was told writing was not part of
                their access in this column, while a working Discord composer
                sat in the other one. The refusal below now means "neither
                composer", not "not the website composer". */}
            {modes.length > 0 ? (
              <ComposerSwitch
                modes={modes}
                pushReachable={pushReachable}
                discord={discord}
                channelConfigured={channelConfigured}
              />
            ) : (
              // Withheld, not empty. A blank left column on the widest half of
              // the screen reads as a page that failed to load.
              <div className="flex flex-col gap-2">
                <span className={`${MICRO} text-[var(--mute)]`}>New post</span>
                <p className="text-sm text-[var(--text-secondary)]">
                  Writing announcements is not part of your access. You can read what the club has
                  posted below.
                </p>
              </div>
            )}
          </Card>

          {/* Its own card, below whichever composer is showing, so a queued or
              failed row stays visible in both modes. */}
          {canSendDiscord && outboxRows.length > 0 && (
            <Card className="p-5">
              <DiscordRecent recent={outboxRows} />
            </Card>
          )}
        </div>

        {/* ---------------------------------------------------------------- */}
        {/* RIGHT — reach, then the posted list                              */}
        {/* ---------------------------------------------------------------- */}
        <div className="flex flex-col gap-5">
          {lastPost && (
            <Card className="p-5">
              <div className="flex items-center justify-between">
                <span className={`${MICRO} text-[var(--mute)]`}>Reach · last post</span>
              </div>

              {lastPercent === null ? (
                // The numerator is announcements data and the viewer holds the
                // key for it; the denominator is the roster and they do not.
                // Half an answer, said as half an answer.
                <>
                  <div className="mt-3 flex items-baseline gap-3">
                    <span className="font-mono text-[36px] leading-none text-[var(--text-primary)]">
                      {lastOpened}
                    </span>
                    <span className={`${MICRO} text-[var(--mute)]`}>opened</span>
                  </div>
                  <p className="mt-3 text-xs text-[var(--text-muted)]">
                    The share of the audience is not shown to you — it needs roster access.
                  </p>
                </>
              ) : (
                <>
                  <div className="mt-3 flex items-baseline gap-3">
                    <span className="font-mono text-[36px] leading-none text-[var(--text-primary)]">
                      {lastPercent}%
                    </span>
                    <span className={`${MICRO} text-[var(--mute)]`}>
                      <Atomic>{`${lastOpened} of ${lastAudience} opened`}</Atomic>
                    </span>
                  </div>

                  <div
                    className="mt-4 flex h-[10px] w-full overflow-hidden bg-[var(--surface-2)]"
                    role="img"
                    aria-label={`${lastOpened} of ${lastAudience} members opened this post`}
                  >
                    <div className="bg-[var(--red)]" style={{ width: `${lastPercent}%` }} />
                  </div>

                  <div className="mt-2 flex items-center justify-between">
                    <span className={`${MICRO} text-[var(--mute)]`}>Opened</span>
                    <span className={`${MICRO} text-[var(--mute)]`}>Not yet</span>
                  </div>
                </>
              )}

              <p className="mt-4 text-xs text-[var(--text-muted)] leading-relaxed">
                {lastPost.title} · {audienceLabel(lastPost.target_audience)}
              </p>
            </Card>
          )}

          <Card padding={false}>
            <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--line)]">
              <span className={`${MICRO} text-[var(--mute)]`}>Posted</span>
              {/* The mockup said THIS TERM. This list is deliberately NOT
                  term-scoped — an admin has to be able to reach a retired
                  season's posts to edit or remove them, and 00085 retires them
                  from the MEMBER feed, not from here. So the slot says what the
                  list actually is. */}
              <span className={`${MICRO} text-[var(--mute)]`}>
                {rows.length} {rows.length === 1 ? 'post' : 'posts'}
              </span>
            </div>

            {rows.length === 0 ? (
              <div className="p-5">
                <EmptyState
                  title="Nothing posted yet"
                  description="The first announcement you write will land here and on every member's phone."
                />
              </div>
            ) : (
              <ResponsiveTable
                cards={rows.map((row) => (
                  <TableCard
                    key={row.id}
                    // A pinned post carries the same 2px red edge on both
                    // renderings, so the phone and the laptop agree about which
                    // notice is sitting at the top of the feed.
                    className={row.pinned ? 'border-l-2 border-l-[var(--red)]' : undefined}
                    title={row.title}
                    badges={
                      <>
                        <Badge variant={typeBadge(row.type).variant}>
                          {typeBadge(row.type).label}
                        </Badge>
                        {row.status === 'draft' && <Badge variant="warning">DRAFT</Badge>}
                        {row.pinned && <Badge variant="default">PINNED</Badge>}
                      </>
                    }
                    fields={[
                      { label: 'Posted', value: <Atomic>{shortDate(row.created_at)}</Atomic> },
                      { label: 'Audience', value: audienceLabel(row.target_audience) },
                      ...(discordChip(row) ? [{ label: 'Discord', value: discordChip(row) as string }] : []),
                      ...(byline(row)
                        ? [{ label: 'Detail', wide: true, value: byline(row) as string }]
                        : []),
                    ]}
                    actions={rowActions(row)}
                  />
                ))}
              >
                <table className="w-full">
                  <thead>
                    <tr>
                      <th className="px-5 pb-2 pt-4 text-left font-mono text-[9px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">
                        Post
                      </th>
                      <th className="px-5 pb-2 pt-4 text-right font-mono text-[9px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">
                        Posted
                      </th>
                      <th className="px-5 pb-2 pt-4 text-right font-mono text-[9px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((row) => (
                      <tr
                        key={row.id}
                        className={`border-t border-[var(--line)] align-top ${
                          row.pinned ? 'border-l-2 border-l-[var(--red)]' : ''
                        }`}
                      >
                        <td className="px-5 py-4">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <Badge variant={typeBadge(row.type).variant}>
                              {typeBadge(row.type).label}
                            </Badge>
                            {row.status === 'draft' && <Badge variant="warning">DRAFT</Badge>}
                            {row.pinned && <Badge variant="default">PINNED</Badge>}
                          </div>
                          <div className="mt-2 text-[15px] leading-snug text-[var(--text-primary)]">
                            {row.title}
                          </div>
                          {(byline(row) || discordChip(row)) && (
                            <div className={`mt-1.5 ${MICRO} text-[var(--mute)]`}>
                              {[byline(row), discordChip(row) && `Discord: ${discordChip(row)}`]
                                .filter(Boolean)
                                .join(' · ')}
                            </div>
                          )}
                        </td>
                        <td className="px-5 py-4 text-right">
                          <span className={`${MICRO} text-[var(--mute)]`}>
                            <Atomic>{shortDate(row.created_at)}</Atomic>
                          </span>
                        </td>
                        <td className="px-5 py-4 text-right">
                          <div className="flex justify-end [&_button]:min-h-[44px] [&_button]:min-w-[44px]">
                            {rowActions(row)}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </ResponsiveTable>
            )}
          </Card>
        </div>
      </div>
    </div>
  );
}
