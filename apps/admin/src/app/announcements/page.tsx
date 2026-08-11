export const dynamic = 'force-dynamic';

import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { Card, Badge, PageHeader, ResponsiveTable, TableCard, Atomic, EmptyState } from '@badminton/ui';
import { isPushCategoryEnabled } from '@badminton/shared';
import { accessLevelFor, permissionsOf, permits, type Capability } from '@/lib/permissions';
import { Composer, AnnouncementRowActions, type RowAnnouncement } from './actions';
import {
  audienceLabel,
  bylineName,
  reachPercent,
  shortDate,
  typeBadge,
  type AnnouncementStatus,
  type AnnouncementType,
  type TargetAudience,
} from './announcement-shape';

const MICRO = 'font-mono text-[10px] uppercase tracking-[0.16em]';

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
 * Published posts only. A draft was never sent to anybody, so "0 opened" on
 * one is not a reach figure, it is a category error.
 */
async function openedCounts(
  supabase: ReturnType<typeof createAdminClient>,
  rows: Row[],
): Promise<Map<string, number>> {
  const published = rows.filter((r) => r.status === 'published');
  if (published.length === 0) return new Map();

  const entries = await Promise.all(
    published.map(async (r) => {
      const { count } = await supabase
        .from('announcement_reads')
        .select('id', { count: 'exact', head: true })
        .eq('announcement_id', r.id);
      return [r.id, count ?? 0] as const;
    }),
  );
  return new Map(entries);
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
  const permissions = permissionsOf(viewer);
  const may = (capability: Capability) => permits(level, permissions, capability);

  const canCreate = may('announcements.create.write');
  const canUpdate = may('announcements.update.write');
  const canDelete = may('announcements.delete.write');

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
      'id, title, body, type, author_id, pinned, send_push, target_audience, expires_at, status, created_at',
    )
    .order('pinned', { ascending: false })
    .order('created_at', { ascending: false });

  const rows = (announcements ?? []) as Row[];

  const opened = await openedCounts(supabase, rows);

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
        {/* LEFT — the composer                                              */}
        {/* ---------------------------------------------------------------- */}
        <Card className="p-5">
          {canCreate ? (
            <Composer pushReachable={pushReachable} />
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
                          {byline(row) && (
                            <div className={`mt-1.5 ${MICRO} text-[var(--mute)]`}>{byline(row)}</div>
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
