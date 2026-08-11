import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import {
  CLUB_TIMEZONE,
  MATCH_FORMAT_LABELS,
  formatRelativeTime,
  formatTime,
  getAccountStanding,
  pickOne,
} from '@badminton/shared';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ChevronRight, QrCode } from 'lucide-react';
import { PageHeader, AvatarChip } from '@badminton/ui';
import { PasskeyNudge } from '@/components/passkey-nudge';
import {
  attendanceStreak,
  clubDayKey,
  describeMatch,
  groupByDay,
  seasonWeek,
  sessionDayLabel,
  type RiverPerson,
} from '@/lib/feed-activity';
import { isAddressedTo, withVisibleAnnouncements } from '@/lib/announcement-visibility';

type PlayerEmbed = { id: string; full_name: string | null; handle: string | null; avatar_url: string | null };
type MatchParticipantRow = {
  team_side: 'a' | 'b';
  win_flag: boolean | null;
  rating_delta: number | null;
  post_rating: number | null;
  player: PlayerEmbed | PlayerEmbed[] | null;
};
type MatchRow = {
  id: string;
  played_at: string | null;
  match_type: string;
  format: string;
  score_summary: string | null;
  match_participants: MatchParticipantRow[] | null;
};
type SessionRow = {
  id: string;
  name: string | null;
  date: string;
  location: string;
  start_time: string | null;
  end_time: string | null;
};
type AnnouncementRow = {
  id: string;
  title: string;
  body: string;
  created_at: string;
  target_audience: 'all' | 'competitive' | 'recreational' | 'eligible_only';
  author: { full_name: string | null } | { full_name: string | null }[] | null;
};

/** A row in the river. Both kinds carry `at`, which is the only field the day
 *  grouping needs to know about. */
type RiverItem =
  | {
      kind: 'match';
      id: string;
      at: string;
      mine: boolean;
      sentence: string;
      meta: string;
      face: RiverPerson;
      delta: number | null;
      rating: number | null;
      href: string;
    }
  | {
      kind: 'challenge';
      id: string;
      at: string;
      mine: true;
      sentence: string;
      meta: string;
      face: RiverPerson;
      href: string;
    };

function toPerson(raw: PlayerEmbed | null): RiverPerson | null {
  if (!raw) return null;
  return {
    id: raw.id,
    name: raw.full_name ?? 'Someone',
    handle: raw.handle ?? null,
    avatarUrl: raw.avatar_url ?? null,
  };
}

/** A name with the handle 00092 gave the member beside it — beside, never
 *  instead of, and nothing at all when they have not chosen one. */
function Handle({ handle }: { handle: string | null }) {
  if (!handle) return null;
  return (
    <span className="mono muted" style={{ fontSize: 11, marginLeft: 6 }}>
      @{handle}
    </span>
  );
}

export default async function FeedPage() {
  const player = await getCurrentPlayer();
  if (!player) redirect('/login');

  const supabase = await createServerSupabaseClient();
  const now = new Date();
  const todayKey = clubDayKey(now.toISOString(), CLUB_TIMEZONE);
  const nowIso = now.toISOString();

  // The active season scopes the header eyebrow, the schedule and the notice,
  // exactly as /sessions and /announcements already scope themselves. Fetched
  // first because three of the queries below need its id.
  const { data: activeSeason } = await supabase
    .from('seasons')
    .select('id, name, start_date')
    .eq('active_flag', true)
    .maybeSingle();

  const inActiveSeason = <T extends { or: (f: string) => T }>(q: T): T =>
    activeSeason ? q.or(`season_id.eq.${activeSeason.id},season_id.is.null`) : q;

  const [
    nextSessionRes,
    pastSessionsRes,
    myAttendanceRes,
    announcementsRes,
    recentMatchesRes,
    pendingChallengesRes,
  ] = await Promise.all([
    // The one session a member turning up tonight needs. Same track filter the
    // schedule uses — a session aimed at the other division is not "next" for
    // this member.
    inActiveSeason(
      supabase
        .from('sessions')
        .select('id, name, date, location, start_time, end_time')
        .eq('status', 'open')
        .in('track', [player.status, 'all'])
        .gte('date', todayKey),
    )
      .order('date', { ascending: true })
      .limit(1),
    // The sessions the streak counts down through: already happened, and ones
    // this member was eligible for. Being ineligible for a session is not the
    // same as not turning up to it, so the track filter is what keeps the
    // streak honest.
    inActiveSeason(
      supabase
        .from('sessions')
        .select('id, date')
        .in('track', [player.status, 'all'])
        .lt('date', todayKey),
    )
      .order('date', { ascending: false })
      .limit(20),
    supabase
      .from('session_attendance')
      .select('session_id, status')
      .eq('player_id', player.id)
      .in('status', ['checked_in', 'present']),
    // Three rather than one, because target_audience cannot be filtered in the
    // query (it is matched against the viewer's own division below) and the
    // newest row might not be for them.
    //
    // withVisibleAnnouncements applies expiry AND the 00085 season shape — the
    // same filter /announcements runs, from the same module, so the home screen
    // and the news screen cannot disagree about whether a notice is retired.
    // NOT inActiveSeason() above: that is the sessions shape (a nullable
    // season_id) and it would match no evergreen announcement at all.
    withVisibleAnnouncements(
      supabase
        .from('announcements')
        // Unhinted embed: `announcements` has exactly one foreign key to
        // `players` (author_id), so PostgREST resolves it without a constraint
        // name — and a constraint name guessed from the schema would only fail
        // at runtime if it were wrong.
        .select('id, title, body, created_at, target_audience, author:players(full_name)')
        .eq('status', 'published'),
      nowIso,
      activeSeason?.id,
    )
      .order('pinned', { ascending: false })
      .order('created_at', { ascending: false })
      .limit(3),
    // The river's own query, run against `matches` rather than against this
    // member's `match_participants`, for two reasons: the feed shows the CLUB's
    // results and not only the member's own, and a top-level query is the only
    // one PostgREST will order by played_at — ordering by an embedded to-one
    // relation is silently a no-op.
    supabase
      .from('matches')
      .select(`
        id, played_at, match_type, format, score_summary,
        match_participants(team_side, win_flag, rating_delta, post_rating,
          player:players(id, full_name, handle, avatar_url))
      `)
      .eq('result_status', 'confirmed')
      .not('played_at', 'is', null)
      .order('played_at', { ascending: false })
      .limit(15),
    supabase
      .from('challenge_participants')
      .select('id, created_at, challenge:challenges(id, type, format, created_at, creator:players!challenges_created_by_fkey(id, full_name, handle, avatar_url))')
      .eq('player_id', player.id)
      .eq('confirmation_status', 'pending')
      .limit(5),
  ]);

  const nextSession = (nextSessionRes.data ?? [])[0] as SessionRow | undefined;
  const pastSessions = (pastSessionsRes.data ?? []) as { id: string }[];
  const attendedIds = new Set((myAttendanceRes.data ?? []).map((r) => r.session_id as string));
  const streak = attendanceStreak(pastSessions, attendedIds);

  // Going is an RSVP, not a check-in: it is what the member is asking when they
  // look at tonight's session, and it is the number /sessions already shows.
  const { count: goingCount } = nextSession
    ? await supabase
        .from('session_rsvp')
        .select('session_id', { count: 'exact', head: true })
        .eq('session_id', nextSession.id)
        .eq('intent', 'going')
    : { count: null };

  // RLS only checks status='published'. Expiry and season are filtered in the
  // query above; audience is the one part that cannot be, because it is matched
  // against a value on the viewer rather than on the row.
  const notice = ((announcementsRes.data ?? []) as unknown as AnnouncementRow[]).find((a) =>
    isAddressedTo(a, player),
  );
  const noticeAuthor = pickOne(notice?.author ?? null);

  const standing = getAccountStanding(player);
  const isApproved = standing.ok;

  // ---- the river -------------------------------------------------------
  const matchItems: RiverItem[] = ((recentMatchesRes.data ?? []) as unknown as MatchRow[])
    .map((m): RiverItem | null => {
      const rows = m.match_participants ?? [];
      const winners = rows.filter((p) => p.win_flag === true);
      const losers = rows.filter((p) => p.win_flag === false);
      const winnerPeople = winners.map((p) => toPerson(pickOne(p.player))).filter((p): p is RiverPerson => !!p);
      const loserPeople = losers.map((p) => toPerson(pickOne(p.player))).filter((p): p is RiverPerson => !!p);

      const sentence = describeMatch({ winners: winnerPeople, losers: loserPeople }, player.id);
      if (!sentence || !m.played_at) return null;

      const mineRow = rows.find((p) => pickOne(p.player)?.id === player.id);
      const mine = !!mineRow;
      const iWon = mineRow?.win_flag === true;

      // The avatar and the handle belong to the OTHER person the sentence
      // names — the opponent on the reader's own rows, the winner on everyone
      // else's. Hanging the reader's own handle off "You beat Marcus Ng" would
      // read as Marcus's handle, and the red spine already says whose row it
      // is, so their own face there would be redundant as well as confusing.
      const face = mine ? (iWon ? loserPeople[0] : winnerPeople[0]) : winnerPeople[0];
      if (!face) return null;

      const formatLabel = MATCH_FORMAT_LABELS[m.format as keyof typeof MATCH_FORMAT_LABELS] || m.format;
      const meta = [
        m.match_type === 'doubles' ? 'Doubles' : 'Singles',
        m.score_summary || formatLabel,
        formatRelativeTime(m.played_at),
      ]
        .filter(Boolean)
        .join(' · ');

      return {
        kind: 'match',
        id: m.id,
        at: m.played_at,
        mine,
        sentence,
        meta,
        face,
        // ONLY the reader's own figures. An absolute rating printed beside
        // another member's name publishes the one number hide_from_leaderboard
        // exists to let them withhold, and this query has no way to honour that
        // flag — get_leaderboard() is where that filtering lives, and it is not
        // reachable from a match row. The mockup's "+14 over 817" is on a row
        // about the reader, so nothing is lost. Everyone else's result is
        // already fully described by the score in the meta line.
        delta: mine ? (mineRow?.rating_delta ?? null) : null,
        rating: mine ? (mineRow?.post_rating ?? null) : null,
        // Another member's row goes to that member's profile; the reader's own
        // goes to their stats. Sending everything to /my-stats meant tapping
        // "Jordan Lee beat Priya Patel" landed you on your own numbers.
        href: mine ? '/my-stats' : `/leaderboard/${face.id}`,
      };
    })
    .filter((i): i is RiverItem => i !== null);

  const challengeItems: RiverItem[] = (pendingChallengesRes.data ?? [])
    .map((pc): RiverItem | null => {
      const c = pickOne(pc.challenge as unknown as Record<string, unknown> | null) as Record<string, unknown> | null;
      if (!c) return null;
      const creator = toPerson(pickOne(c.creator as PlayerEmbed | PlayerEmbed[] | null));
      if (!creator) return null;
      const at = (c.created_at as string) ?? (pc.created_at as string);
      if (!at) return null;
      return {
        kind: 'challenge',
        id: pc.id as string,
        at,
        mine: true,
        sentence: `${creator.name} wants to play you`,
        meta: ['Challenge', MATCH_FORMAT_LABELS[(c.format as string) as keyof typeof MATCH_FORMAT_LABELS] || (c.format as string)]
          .filter(Boolean)
          .join(' · '),
        face: creator,
        href: `/challenges/${c.id as string}`,
      };
    })
    .filter((i): i is RiverItem => i !== null);

  const sections = groupByDay<RiverItem>([...matchItems, ...challengeItems], now, CLUB_TIMEZONE);
  const week = activeSeason?.start_date ? seasonWeek(activeSeason.start_date, now, CLUB_TIMEZONE) : null;
  const eyebrow = [activeSeason?.name, week ? `Week ${week}` : null].filter(Boolean).join(' · ') || 'The club';

  const sessionWhen = nextSession ? sessionDayLabel(nextSession.date, todayKey) : null;
  const sessionHours =
    nextSession?.start_time && nextSession?.end_time
      ? `${formatTime(nextSession.start_time)} – ${formatTime(nextSession.end_time)}`
      : nextSession?.start_time
        ? `From ${formatTime(nextSession.start_time)}`
        : null;

  // The reader's own aggregate record. getCurrentPlayer() already selects
  // `ratings(*)`, so this is free — no extra round trip, and no whole-club
  // get_leaderboard() fetch just to print one member's numbers. It is the
  // member's OWN row, so hide_from_leaderboard does not apply: that flag
  // governs what everyone else sees.
  const rating = (Array.isArray(player.ratings) ? player.ratings[0] : player.ratings) as
    | {
        singles_elo: number | null;
        doubles_elo: number | null;
        singles_wins: number | null;
        singles_losses: number | null;
        doubles_wins: number | null;
        doubles_losses: number | null;
        singles_provisional: boolean | null;
        doubles_provisional: boolean | null;
      }
    | null
    | undefined;
  const played =
    (rating?.singles_wins ?? 0) +
    (rating?.singles_losses ?? 0) +
    (rating?.doubles_wins ?? 0) +
    (rating?.doubles_losses ?? 0);

  return (
    <div data-screen-label="Feed" className="wide-page">
      <PageHeader
        eyebrow={eyebrow.toUpperCase()}
        title="Feed"
        actions={
          <AvatarChip name={player.full_name} id={player.id} src={player.avatar_url} size="md" ring />
        }
        className="feed-header"
      />

      {/* Renders nothing unless this account has no passkey yet and the device
          supports them, so it self-retires once everyone is enrolled. Kept
          although the mockup omits it: it is the only route by which members
          who predate passkeys are ever asked. */}
      <PasskeyNudge />

      {/* Also kept against the mockup. Hiding the gated features without saying
          why leaves a member staring at a half-empty app wondering what they
          did wrong — and it is what stops a suspended account being offered a
          control requirePlayer() is certain to refuse. */}
      {!isApproved && (
        <div className="card-base" style={{ marginBottom: 20, borderLeft: '3px solid var(--gold)' }}>
          <h3 className="card-title" style={{ marginBottom: 6 }}>
            {standing.block === 'pending_approval' ? 'Waiting on approval' : 'Account suspended'}
          </h3>
          <p className="muted" style={{ fontSize: 14, lineHeight: 1.55, margin: 0 }}>
            {standing.detail} You can still read the feed and the leaderboard.
          </p>
        </div>
      )}

      {/* River left, supporting cards right. One column until 1101px, and the
          DOM order is unchanged, so the phone still reads exactly as before:
          river, next session, notice, record, then the sticky check-in bar.

          .wide-grid rather than the old 8/4 .grid-12 because .grid-12 halves to
          six columns at 1100px, so "span 8" quietly meant two thirds of the
          page on a laptop and the whole width on a tablet — two grids
          disagreeing about how many columns the page has. */}
      <div className="wide-grid">
        <div className="feed-col">
          {/* THE RIVER ------------------------------------------------ */}
          {sections.length === 0 ? (
            <div className="card-base">
              <div className="empty">
                <div className="empty-title">Nothing has happened yet</div>
                <div className="empty-hint">
                  Results and challenges land here as the club plays. Issue a challenge to
                  put the first one on the board.
                </div>
                {isApproved && (
                  <Link href="/challenges/new" className="btn btn-ghost">
                    Issue a challenge <ChevronRight size={12} />
                  </Link>
                )}
              </div>
            </div>
          ) : (
            <div>
              {sections.map((section) => (
                <div key={section.key}>
                  <div className="river-day">{section.label}</div>
                  {section.items.map((item) => (
                    <Link
                      key={`${item.kind}-${item.id}`}
                      href={item.href}
                      className={`river-row press${item.mine ? ' mine' : ''}`}
                    >
                      <AvatarChip
                        name={item.face.name}
                        id={item.face.id}
                        src={item.face.avatarUrl}
                        size="sm"
                      />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div className="river-sentence">
                          {item.sentence}
                          <Handle handle={item.face.handle} />
                        </div>
                        <div className="river-meta">{item.meta}</div>
                      </div>
                      {item.kind === 'challenge' ? (
                        <span className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }}>
                          Reply
                        </span>
                      ) : (
                        <div className="river-value">
                          {typeof item.delta === 'number' && (
                            <div
                              className="river-delta"
                              style={{ color: item.delta >= 0 ? 'var(--win)' : 'var(--loss)' }}
                            >
                              {item.delta >= 0 ? '+' : ''}
                              {item.delta}
                            </div>
                          )}
                          {typeof item.rating === 'number' && (
                            <div className="river-rating">{item.rating}</div>
                          )}
                        </div>
                      )}
                    </Link>
                  ))}
                </div>
              ))}
              <div className="river-end">
                {week ? `End of week ${week}` : 'End of the feed'}
              </div>
            </div>
          )}
        </div>

        <aside className="wide-rail">
          {/* NEXT SESSION --------------------------------------------- */}
          <div className="card-base">
            <div className="wide-cap">Next session</div>
            {nextSession ? (
              <>
                <div
                  style={{
                    fontFamily: 'var(--display)',
                    fontSize: 30,
                    fontWeight: 700,
                    letterSpacing: '-.02em',
                    lineHeight: 1.05,
                    margin: '8px 0 6px',
                  }}
                >
                  {sessionWhen} · {nextSession.location}
                </div>
                <div className="mono muted" style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '.06em' }}>
                  {/* The mockup also printed "COURTS 1–6". There is no court
                      column on `sessions`, so it is left out rather than
                      guessed at. The session's own name is shown instead when
                      it has one. */}
                  {[sessionHours, nextSession.name].filter(Boolean).join(' · ') || 'Time to be confirmed'}
                </div>
                <div className="session-stats">
                  {/* "Spots left" is drawn in the mockup and is NOT built:
                      `sessions` has no capacity column and there is no waitlist
                      table, so any number here would be invented. */}
                  <div className="stat">
                    <div className="stat-label">Going</div>
                    <div className="stat-value mono" style={{ fontSize: 24 }}>{goingCount ?? 0}</div>
                  </div>
                  <div className="stat">
                    <div className="stat-label">Your streak</div>
                    <div className="stat-value mono" style={{ fontSize: 24 }}>{streak}</div>
                  </div>
                </div>
              </>
            ) : (
              <div className="muted" style={{ fontSize: 13, marginTop: 8, lineHeight: 1.5 }}>
                Nothing on the schedule yet. The exec posts sessions a week or two ahead —
                check back, or look at what has already been played.
              </div>
            )}
          </div>

          {/* CHECK IN, on a laptop ------------------------------------ */}
          {/* The same control as the sticky bar at the foot of the document,
              rendered a second time so the desktop can have it as a card in the
              rail instead of a red slab floating over the river. Exactly one of
              the two is ever displayed (.wide-desktop-only shows this one at
              >=1101px and hides the bar at the same width), and neither holds
              state, so there is nothing here that can disagree with itself. */}
          {isApproved && nextSession && (
            <div className="card-base wide-desktop-only">
              <div className="wide-cap">Turning up?</div>
              <p className="wide-note" style={{ marginBottom: 14 }}>
                Check in when you arrive to claim your spot. The button opens on
                the schedule, beside the session itself.
              </p>
              <Link
                href={`/sessions#session-${nextSession.id}`}
                className="btn btn-primary btn-lg press"
                style={{ width: '100%', justifyContent: 'center', minHeight: 48 }}
              >
                <QrCode size={16} /> Check in
              </Link>
            </div>
          )}

          {/* CLUB NOTICE ---------------------------------------------- */}
          {notice && (
            <Link href="/announcements" className="card-base press" style={{ display: 'block' }}>
              <div className="wide-cap">Club notice</div>
              <h3 className="card-title" style={{ margin: '8px 0 6px' }}>
                {notice.title}
              </h3>
              <p style={{ fontSize: 15, lineHeight: 1.45, margin: 0 }}>{notice.body}</p>
              <div
                className="mono muted"
                style={{ fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase', marginTop: 12 }}
              >
                {/* The mockup reads "POSTED BY EXEC". The author's own name is
                    both real and more useful, and it is what the notice is
                    signed with everywhere else in the app. */}
                {noticeAuthor?.full_name
                  ? `Posted by ${noticeAuthor.full_name}`
                  : 'Posted by the club'}{' '}
                · {formatRelativeTime(notice.created_at)}
              </div>
            </Link>
          )}

          {/* YOUR RECORD ---------------------------------------------- */}
          {/* Every figure here comes off the `ratings` row getCurrentPlayer()
              already loads. Deliberately NOT on this card:
              - ladder POSITION. Working it out means get_leaderboard(), which
                fetches the whole club on a screen that does not otherwise need
                it, and returns nothing at all for a member who has set
                hide_from_leaderboard.
              - anything scoped to "this week". `ratings` is a running total
                with no history behind it, and the river above is capped at
                fifteen rows, so a weekly count would either be a guess or a
                second query. /my-stats is where the history lives, and this
                card links to it.
              Desktop only, for the same reason as the rail cards on /sessions:
              on a phone this is a lift of the top of /my-stats, one tab away,
              on a screen that is supposed to have one thing to do. */}
          <Link href="/my-stats" className="card-base press wide-desktop-only">
            <div className="wide-cap">Your record</div>
            {played === 0 ? (
              <p className="wide-note">
                No rated matches yet. Your singles and doubles ratings start
                level and move the first time a result is confirmed.
              </p>
            ) : (
              <div className="wide-figures">
                <div className="stat">
                  <div className="stat-label">Singles</div>
                  <div className="stat-value mono" style={{ fontSize: 24 }}>
                    {rating?.singles_elo ?? '—'}
                  </div>
                  {/* "Provisional" leads the sub-line, the way /my-stats and
                      the ladder both write it — a rating still settling means
                      something different from one that has, and the figure
                      above says nothing about which it is. */}
                  <div className="wide-item-sub" style={{ marginTop: 2 }}>
                    {rating?.singles_provisional ? 'Provisional · ' : ''}
                    {rating?.singles_wins ?? 0}W · {rating?.singles_losses ?? 0}L
                  </div>
                </div>
                <div className="stat">
                  <div className="stat-label">Doubles</div>
                  <div className="stat-value mono" style={{ fontSize: 24 }}>
                    {rating?.doubles_elo ?? '—'}
                  </div>
                  <div className="wide-item-sub" style={{ marginTop: 2 }}>
                    {rating?.doubles_provisional ? 'Provisional · ' : ''}
                    {rating?.doubles_wins ?? 0}W · {rating?.doubles_losses ?? 0}L
                  </div>
                </div>
              </div>
            )}
          </Link>
        </aside>
      </div>

      {/* THE one primary action ON A PHONE — the desktop renders it as a card
          in the rail above instead, and .wide-desktop-only makes sure only one
          of the two is ever on screen.
          A direct child of the page root rather than of a grid column, because
          `position: sticky` only pins while its CONTAINING BLOCK is on screen —
          nested in the sidebar it would appear only once you had scrolled past
          the whole river, which is the opposite of the point. That is also why
          the desktop version is a separate element rather than this one moved.
          Hidden outright for an account checkInToSession() would refuse.
          It goes to the schedule, not to a scanner: /checkin/[token] is the
          DESTINATION of a QR scan and the app has no session-scanning screen to
          send anyone to, so "Scan to check in" as drawn has nowhere to go. */}
      {isApproved && nextSession && (
        <div className="feed-checkin-bar">
          <Link
            href={`/sessions#session-${nextSession.id}`}
            className="btn btn-primary btn-lg press"
            style={{ width: '100%', justifyContent: 'center', minHeight: 48 }}
          >
            <QrCode size={16} /> Check in
          </Link>
        </div>
      )}
    </div>
  );
}
