import { createServerSupabaseClient, getCurrentPlayer, getExecutives } from '@/lib/supabase-server';
import { redirect } from 'next/navigation';
import Link from 'next/link';
import { Megaphone } from 'lucide-react';
import { CLUB_TIMEZONE, pickOne, splitFullName } from '@badminton/shared';
import { AnnouncementRow, PinnedNotice, type NewsPost } from './announcement-item';

interface AuthorRow {
  id: string;
  full_name: string | null;
  avatar_url: string | null;
}

interface Announcement {
  id: string;
  title: string;
  body: string;
  type: 'info' | 'warning' | 'urgent' | 'event';
  pinned: boolean;
  target_audience: 'all' | 'competitive' | 'recreational' | 'eligible_only';
  created_at: string;
  author: AuthorRow | AuthorRow[] | null;
}

interface AnnouncementRead {
  announcement_id: string;
}

/** The four values `announcement_type` actually has (00001_schema.sql:595),
 *  each mapped to a Badge tone. The lookup is total by construction, and
 *  CATEGORY_TONE falls back to neutral anyway: a type this list has not heard
 *  of is a category we cannot colour, not a post to hide, and the old screen
 *  indexed a Record directly and rendered a class of `undefined` for anything
 *  unexpected. */
const CATEGORY_TONE: Record<string, NewsPost['tone']> = {
  info: 'neutral',
  event: 'neutral',
  warning: 'warning',
  urgent: 'danger',
};

/** '18 JAN'. Formatted here, on the server, in the club's timezone — a post
 *  published at 9pm Pacific must not read as the next day to a member who
 *  opened the app on a phone still set to Toronto. */
function dayStamp(iso: string) {
  return new Intl.DateTimeFormat('en-GB', {
    day: '2-digit',
    month: 'short',
    timeZone: CLUB_TIMEZONE,
  })
    .format(new Date(iso))
    .toUpperCase();
}

/** 'JANUARY', or 'JANUARY 2024' when the month is not in the current club
 *  year. Evergreen posts (all_seasons, 00085) never retire, so a two-year-old
 *  notice can sit under the same month name as this term's and two bare
 *  'JANUARY' headers would be indistinguishable. */
function monthLabel(iso: string, currentYear: string) {
  const parts = new Intl.DateTimeFormat('en-GB', {
    month: 'long',
    year: 'numeric',
    timeZone: CLUB_TIMEZONE,
  }).formatToParts(new Date(iso));
  const month = parts.find((p) => p.type === 'month')?.value ?? '';
  const year = parts.find((p) => p.type === 'year')?.value ?? '';
  return (year === currentYear ? month : `${month} ${year}`).toUpperCase();
}

function clubYear(now: Date) {
  return new Intl.DateTimeFormat('en-GB', { year: 'numeric', timeZone: CLUB_TIMEZONE }).format(now);
}

/** '2 DAYS AGO'. Only the pinned notice uses this: a pinned post is on screen
 *  because it is still current, so how long it has been current is the useful
 *  fact. Everything else is dated.
 *
 *  Every unit pluralises through the same helper rather than each branch
 *  deciding for itself. The branches this reaches are not all common — an
 *  evergreen (all_seasons, 00085) pinned notice never retires, so the year
 *  branch really does render — and a "1 YEARS AGO" hiding in the one branch
 *  nobody exercises is exactly the kind of thing that ships. */
function ago(count: number, unit: string) {
  return `${count} ${unit}${count === 1 ? '' : 'S'} AGO`;
}

function relativeAge(iso: string, now: Date) {
  const minutes = Math.max(0, Math.round((now.getTime() - new Date(iso).getTime()) / 60000));
  if (minutes < 60) return 'JUST NOW';
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return ago(hours, 'HOUR');
  const days = Math.floor(hours / 24);
  if (days < 7) return ago(days, 'DAY');
  if (days < 60) return ago(Math.floor(days / 7), 'WEEK');
  const months = Math.floor(days / 30);
  if (months < 24) return ago(months, 'MONTH');
  return ago(Math.floor(days / 365), 'YEAR');
}

/** 'Priya Raman' → 'P. RAMAN'. A byline under a row is a signature, not an
 *  introduction — the avatar beside it is what members actually recognise. A
 *  mononym keeps its whole self ('CHER'), because 'C.' signs nothing. */
function abbreviateName(full: string) {
  const { first_name, last_name } = splitFullName(full);
  if (!last_name) return first_name.toUpperCase();
  return `${first_name.charAt(0).toUpperCase()}. ${last_name.toUpperCase()}`;
}

export default async function AnnouncementsPage() {
  const player = await getCurrentPlayer();
  if (!player) redirect('/login');

  const supabase = await createServerSupabaseClient();

  // This term's announcements, plus the evergreen ones.
  //
  // Without the season filter the feed was cumulative forever: after a rollover
  // last term's "courts closed for reading week" still sat pinned above this
  // term's, and the only way to retire it was to delete it — which throws away
  // the record of having said it. 00085 gives every row exactly one of two
  // shapes, so this filter has no ambiguous NULL to worry about.
  //
  // No active season means no season filter, deliberately. Between terms, a
  // feed that has gone blank reads to a member as a broken app; showing
  // everything is the gentler failure, and it is the same rule the schedule and
  // the tournament list already follow.
  const { data: activeSeason } = await supabase
    .from('seasons').select('id').eq('active_flag', true).maybeSingle();

  const now = new Date();
  const nowIso = now.toISOString();
  let query = supabase
    .from('announcements')
    // Unhinted embed: `announcements` has exactly one foreign key to `players`
    // (author_id), so PostgREST resolves it without a constraint name — the
    // same embed /feed uses for its one notice. Only the three columns 00032
    // grants `authenticated` are named; exec_title is not one of them and comes
    // from get_executives() below instead.
    .select('id, title, body, type, pinned, target_audience, created_at, author:players(id, full_name, avatar_url)')
    .eq('status', 'published')
    .or(`expires_at.is.null,expires_at.gt.${nowIso}`);

  if (activeSeason?.id) {
    query = query.or(`all_seasons.eq.true,season_id.eq.${activeSeason.id}`);
  }

  const [{ data: announcements }, { data: reads }, executives] = await Promise.all([
    query
      .order('pinned', { ascending: false })
      .order('created_at', { ascending: false })
      .returns<Announcement[]>(),
    supabase
      .from('announcement_reads')
      .select('announcement_id')
      .eq('player_id', player.id)
      .returns<AnnouncementRead[]>(),
    // The byline's role. exec_title is withheld from `authenticated` by 00032's
    // column grants, so it cannot be read off the embed above; get_executives()
    // is the definer-rights function that already publishes exactly this field
    // to the /exec page, and it is granted to anon and authenticated. Escaping
    // to the service role for a decorative label would be the wrong trade.
    //
    // An author who is not on the exec (an admin, or an exec who has since
    // stepped down) simply has no row here and their byline is the name alone.
    getExecutives(),
  ]);

  const readSet = new Set((reads ?? []).map((r) => r.announcement_id));
  const titleById = new Map(
    (executives ?? []).map((e) => [e.id, e.exec_title?.trim() ? e.exec_title.trim().toUpperCase() : null]),
  );

  // RLS only checks status='published'; expiry + audience must be filtered here.
  // Expiry is applied in the query above; audience is matched to the viewer's
  // division / eligibility (player_status carries the division — 00001:18).
  const visible = (announcements ?? []).filter(
    (a) =>
      a.target_audience === 'all' ||
      a.target_audience === player.status ||
      (a.target_audience === 'eligible_only' && player.eligibility_flag)
  );

  function toPost(a: Announcement, stamp: string): NewsPost {
    const author = pickOne(a.author);
    const name = author?.full_name?.trim() || '';
    return {
      id: a.id,
      title: a.title,
      body: a.body,
      category: (a.type ?? '').toUpperCase() || 'NEWS',
      tone: CATEGORY_TONE[a.type] ?? 'neutral',
      stamp,
      author:
        author && name
          ? {
              id: author.id,
              name,
              shortName: abbreviateName(name),
              role: titleById.get(author.id) ?? null,
              avatarUrl: author.avatar_url,
            }
          : null,
    };
  }

  const pinned = visible.filter((a) => a.pinned).map((a) => toPost(a, relativeAge(a.created_at, now)));

  // Grouped by month, in the order the query already sorted them (newest
  // first), so the groups need no second sort of their own.
  const year = clubYear(now);
  const months: { label: string; posts: NewsPost[] }[] = [];
  for (const a of visible.filter((x) => !x.pinned)) {
    const label = monthLabel(a.created_at, year);
    let group = months[months.length - 1];
    if (!group || group.label !== label) {
      group = { label, posts: [] };
      months.push(group);
    }
    group.posts.push(toPost(a, dayStamp(a.created_at)));
  }

  return (
    <div data-screen-label="News" className="news">
      <header className="news-head">
        <Link href="/feed" className="news-back">← FEED</Link>
        <h1 className="news-title">News<span className="dot">.</span></h1>
        {/* "this term" only while a term is actually filtering the list. With
            no active season the query above deliberately drops the season
            filter, and what is on screen is then every notice the club has
            published — a different promise. */}
        <p className="news-sub">
          {activeSeason?.id
            ? 'Everything the exec has posted this term.'
            : 'Everything the exec has posted.'}
        </p>
      </header>

      {visible.length === 0 ? (
        <div className="card-base" style={{ marginTop: 20 }}>
          <div className="empty">
            <Megaphone size={40} className="text-[var(--mute)]" style={{ display: 'block', margin: '0 auto 12px' }} />
            No announcements yet. Check back soon.
          </div>
        </div>
      ) : (
        <>
          {pinned.map((post) => (
            <PinnedNotice key={post.id} post={post} isRead={readSet.has(post.id)} />
          ))}

          {months.map((group) => (
            <section key={group.label}>
              <h2 className="news-month">{group.label}</h2>
              {group.posts.map((post) => (
                <AnnouncementRow key={post.id} post={post} isRead={readSet.has(post.id)} />
              ))}
            </section>
          ))}
        </>
      )}
    </div>
  );
}
