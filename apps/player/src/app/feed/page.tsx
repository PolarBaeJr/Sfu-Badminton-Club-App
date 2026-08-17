import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import {
  CLUB_TIMEZONE,
  MATCH_FORMAT_LABELS,
  formatRelativeTime,
  formatTime,
  getAccountStanding,
  pickOne,
  scopeToActiveSeason,
} from '@badminton/shared';
import * as Sentry from '@sentry/nextjs';
import { Fragment } from 'react';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { ChevronRight, QrCode } from 'lucide-react';
import { PageHeader, AvatarChip } from '@badminton/ui';
import { PasskeyNudge } from '@/components/passkey-nudge';
import { LiveRating } from '@/components/live-rating';
import { LiveFeed } from '@/components/live-matches';
import { LiveTournament } from '../tournaments/live-tournament';
import { ActiveTournamentCard, type ActiveEntry } from './active-tournament';
import {
  attendanceStreak,
  clubDayKey,
  describeMatch,
  groupByDay,
  seasonWeek,
  sessionDayLabel,
  type RiverPerson,
} from '@/lib/feed-activity';
import { isUnderWay, runningEvents, type FeedTournament } from '@/lib/feed-tournament';
import { countEnteredPlayers, occupiesAPlace } from '@/lib/tournament-index';
import { isAddressedTo, withVisibleAnnouncements } from '@/lib/announcement-visibility';
import { onVisibleTracks } from '@/lib/session-track-filter';

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
    liveTournamentsRes,
  ] = await Promise.all([
    // The one session a member turning up tonight needs. Same track filter the
    // schedule uses — a session aimed at the other division is not "next" for
    // this member.
    onVisibleTracks(
      inActiveSeason(
        supabase
          .from('sessions')
          .select('id, name, date, location, start_time, end_time')
          .eq('status', 'open')
          .gte('date', todayKey),
      ),
      player.status,
    )
      .order('date', { ascending: true })
      .limit(1),
    // The sessions the streak counts down through: already happened, and ones
    // this member was eligible for. Being ineligible for a session is not the
    // same as not turning up to it, so the track filter is what keeps the
    // streak honest.
    onVisibleTracks(
      inActiveSeason(
        supabase
          .from('sessions')
          .select('id, date')
          .lt('date', todayKey),
      ),
      player.status,
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
      // NOT `created_at` on the outer row: challenge_participants has no such
      // column (id, challenge_id, player_id, role, team_side,
      // confirmation_status, responded_at). PostgREST answered 400 to the whole
      // request, supabase-js resolved rather than rejected, and `?? []` turned
      // it into "no pending challenges" for every member. The timestamp this
      // needs is the challenge's own, which is selected below.
      .select('id, challenge:challenges(id, type, format, created_at, creator:players!challenges_created_by_fkey(id, full_name, handle, avatar_url))')
      .eq('player_id', player.id)
      .eq('confirmation_status', 'pending')
      .limit(5),
    // ---- IS THE CLUB PLAYING A TOURNAMENT RIGHT NOW (wave 1 of 2) --------
    //
    // The three cheap conditions are pushed into the query and the expensive one
    // is not:
    //   status = 'active'      — 'draft' is unpublished, 'completed' and
    //                            'archived' are over. Only 'active' can be on.
    //   suspended_at IS NULL   — a suspended tournament refuses registration
    //                            and self check-in server-side, so announcing it
    //                            as running would be an invitation to a refusal.
    //                            Filtered rather than selected; PostgREST
    //                            filters on unselected columns happily and
    //                            `authenticated` may read it either way.
    //   the active season      — same rule as the sessions and announcements
    //                            above, via the same shared helper /tournaments
    //                            uses.
    //
    // The DATE bound is applied in JS instead, in isUnderWay(). It is
    // `(end_date ?? start_date) >= todayKey`, and PostgREST has no COALESCE in a
    // filter, so expressing it here would mean a second `.or()` on a query that
    // already has one from scopeToActiveSeason — two `or` params that get ANDed
    // in a way nobody reading this would predict. The row count this leaves to
    // JS is the active season's 'active' tournaments, which is one on production
    // and will not be many.
    //
    // NAMED COLUMNS, NOT `*`, for the reason the event page gives at length:
    // these tables carry exec-written free text (`suspension_reason` here,
    // `notes` and `pair_name` below) that 00117/00118 moved out but deliberately
    // did not drop. Every column named here was verified readable by the
    // `authenticated` ROLE against the production database on 2026-08-17, with
    // has_column_privilege() and then again by running these selects under
    // `SET LOCAL ROLE authenticated` — not by reading the migrations, which is
    // how the four screens in 00115 were lost. `end_date` is the only one no
    // other player-app query names, and it is the one that was checked hardest.
    scopeToActiveSeason(
      supabase
        .from('tournaments')
        .select('id, name, start_date, end_date, tournament_events(id, event_type, status)')
        .eq('status', 'active')
        .is('suspended_at', null),
      activeSeason?.id,
    ).order('start_date', { ascending: true }),
  ]);

  // THE SAME TREATMENT THE TOURNAMENT READ GETS BELOW, AND FOR THE SAME REASON
  // — see the long note at `liveTournamentsRes`. This is the landing surface, so
  // a refused read must not become an error screen; but a bare `?? []` here is
  // what let a `pending_approval` member be shown a feed with no next session
  // and a broken attendance streak for months, because the track filter sent a
  // `player_status` value into a `session_group` column and PostgREST answered
  // 400. Report it, degrade to no card, and let somebody find out.
  for (const [action, res] of [
    ['feed:nextSession', nextSessionRes],
    ['feed:pastSessions', pastSessionsRes],
  ] as const) {
    if (res.error) {
      Sentry.captureException(new Error(res.error.message), {
        extra: { action, details: res.error.details },
      });
    }
  }
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

  // ---- IS THE CLUB PLAYING A TOURNAMENT RIGHT NOW (wave 2 of 2) ------------
  //
  // *** WHY THIS IS NEITHER `unwrap` NOR A BARE `?? []`. ***
  //
  // The event page wraps its reads in `unwrap`, which RAISES on res.error. That
  // is right there and wrong here: this is the app's LANDING SURFACE, reached by
  // every member on every visit, and a 403 on a tournament column would turn the
  // front door into an error screen over a card that is absent 360 days a year.
  //
  // A bare `?? []` is the other failure and the one this repository keeps
  // paying for: a rejected PostgREST request RESOLVES rather than rejects, so
  // `?? []` renders a 403 as "no tournament is on" — indistinguishable from the
  // truth, silent, and permanent. 00115 is the write-up of that emptying five
  // screens.
  //
  // So: check res.error explicitly, report it to Sentry the way first-signin.ts
  // and reactivate.ts report their soft failures, and degrade to no card. The
  // feed still renders; somebody finds out.
  let liveTournaments: FeedTournament[] = [];
  if (liveTournamentsRes.error) {
    Sentry.captureException(new Error(liveTournamentsRes.error.message), {
      extra: { action: 'feed:activeTournaments', details: liveTournamentsRes.error.details },
    });
  } else {
    liveTournaments = ((liveTournamentsRes.data ?? []) as unknown as FeedTournament[])
      .map((t) => ({ ...t, tournament_events: t.tournament_events ?? [] }))
      .filter((t) => isUnderWay(t, todayKey));
  }

  // Every running event across every running tournament, in ONE pair of round
  // trips rather than a pair per tournament. Same two-wave shape /tournaments
  // uses for `countedEventIds`, and the same two column lists, so both screens
  // are asking the database the same question.
  //
  // BOTH TABLES, ALWAYS, and not as a belt-and-braces gesture. Since 00102 a
  // member enters a DOUBLES event alone and an exec pairs them later, so a
  // doubles entrant may own a `tournament_participants` row and no
  // `tournament_pairs` row at all. Checking only pairs for a doubles event would
  // tell a genuinely entered member they are not in it — the exact bug the event
  // page documents having had ("This was `!doubles` on the grounds that a
  // doubles entrant had no participant row"). Neither table is consulted
  // per-format here; both are read and both are searched.
  const runningEventIds = liveTournaments.flatMap((t) => runningEvents(t).map((e) => e.id));

  let tournamentEntryRows: Array<{ event_id: string; player_id: string; status: string }> = [];
  let tournamentPairRows: Array<{ event_id: string; player1_id: string; player2_id: string; status: string }> = [];
  if (runningEventIds.length > 0) {
    const [pRes, prRes] = await Promise.all([
      supabase
        .from('tournament_participants')
        .select('event_id, player_id, status')
        .in('event_id', runningEventIds),
      supabase
        .from('tournament_pairs')
        .select('event_id, player1_id, player2_id, status')
        .in('event_id', runningEventIds),
    ]);
    // Same explicit-error rule as above, for the same reason — but the DEGRADED
    // STATE IS DIFFERENT, and that is the point of handling the two waves
    // separately. Wave 1 failing means "we do not know whether a tournament is
    // on", so there is no card to draw. Wave 2 failing means "we know one is on
    // but not who is in it", and a card drawn anyway would silently demote every
    // entrant to the not-entered branch — telling a member standing in the gym
    // that they are not entered in the event they are about to play. That is
    // worse than no card, so the card is dropped whole rather than shown wrong.
    if (pRes.error || prRes.error) {
      const failed = pRes.error ?? prRes.error!;
      Sentry.captureException(new Error(failed.message), {
        extra: { action: 'feed:activeTournamentEntries', details: failed.details },
      });
      tournamentEntryRows = [];
      tournamentPairRows = [];
      liveTournaments = [];
    } else {
      tournamentEntryRows = (pRes.data ?? []) as typeof tournamentEntryRows;
      tournamentPairRows = (prRes.data ?? []) as typeof tournamentPairRows;
    }
  }

  /** The viewer's own standing in one running event, or null if they are not in
   *  it. `occupiesAPlace` rather than a fresh status check, so this agrees with
   *  the "You are in" section on /tournaments about the same member: a withdrawn
   *  or disqualified entry is not an entry. */
  const myEntryIn = (eventId: string): ActiveEntry['mine'] => {
    const solo = tournamentEntryRows.find(
      (r) => r.event_id === eventId && r.player_id === player.id && occupiesAPlace(r.status),
    );
    if (solo) return { checkedIn: solo.status === 'checked_in' };
    const pair = tournamentPairRows.find(
      (r) =>
        r.event_id === eventId &&
        (r.player1_id === player.id || r.player2_id === player.id) &&
        occupiesAPlace(r.status),
    );
    if (pair) return { checkedIn: pair.status === 'checked_in' };
    return null;
  };

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
      const at = c.created_at as string;
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
      {/* The "Your record" card below reads the member's own `ratings` row, and
          a confirm entered on somebody else's phone left it stale.

          MOUNTED UNCONDITIONALLY although that card is .wide-desktop-only, so on
          a phone this listens for a card that is not on screen. Deliberate, and
          cheap: it is a filter on ONE row, it fires only when this member's own
          rating moves, and when it does the river above is stale for the same
          reason — a rating only ever moves because a match of theirs was
          confirmed, which is a row the river prints. Gating it on a CSS
          breakpoint would cost a media query in JavaScript to save nothing. */}
      <LiveRating playerId={player.id} />
      {/* The river itself, and the pending-challenges block under it. This is
          the ONE page in the app that revalidatePath never reaches — see
          lib/actions/matches.ts, which revalidates /challenges,
          /challenges/[id], /leaderboard and /my-stats and not this — so
          without this listener the feed is stale for everybody including the
          member who just submitted the result that belongs in it.

          Unfiltered on `matches`, deliberately: a feed of the club's last
          fifteen results is a screen about everybody, and `matches` has no
          player column to filter on in any case. See live-matches.tsx. */}
      <LiveFeed playerId={player.id} />
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
          {/* ── A TOURNAMENT IS ON ────────────────────────────────────
              FIRST IN THE COLUMN, above the river. See ./active-tournament for
              why this is a banner here rather than a RiverItem or a rail card —
              the short version is that `.wide-grid` collapses to one column
              below 1101px, so `.wide-rail` unstacks BELOW this column, and a
              member standing in the gym would have had to scroll past fifteen
              river rows to learn that the tournament they are standing in is
              running.

              ONE CARD PER RUNNING TOURNAMENT, uncapped, with no "and N more"
              line. The bound is already real and narrow — the ACTIVE SEASON's
              tournaments whose status is 'active', which are not suspended, whose
              last day has not passed, and which have an event past registration
              and short of completed. Production has one. Machinery for a case
              that cannot occur is machinery that will be wrong when it does.

              `.feed-col` is `display: flex; flex-direction: column; gap: 20px`,
              so two cards space themselves like every other pair of blocks on
              the page, and `.feed-col > * { min-width: 0 }` (globals.css:1577) is
              what stops a long tournament name from widening the column and
              taking the whole document sideways. That rule is why this card sets
              no width of its own. */}
          {liveTournaments.map((t) => {
            const running = runningEvents(t);
            const eventIds = running.map((e) => e.id);
            return (
              // A FRAGMENT, NOT A WRAPPER DIV. `.feed-col > * { min-width: 0 }`
              // only reaches DIRECT children, and that rule is the one thing
              // standing between a long exec-typed tournament name and a document
              // that scrolls sideways. A wrapper would absorb it and leave the
              // card itself with the flex default of `min-width: auto`.
              // LiveTournament renders null, so the fragment costs no element.
              <Fragment key={t.id}>
                {/* THE SAME MECHANISM THE TOURNAMENT PAGES USE, not a new one:
                    LiveTournament coalesces at 700ms and calls router.refresh(),
                    which re-runs this server component and re-derives the card
                    from the viewer's own credentials.

                    `draw` IS OMITTED (it defaults false). That is the whole
                    argument in ./active-tournament: this card prints nothing off
                    `tournament_matches`, so a match-level filter would wake the
                    busiest screen in the app on every score to redraw an
                    identical card. What the card DOES show is covered without
                    it — an event going live or completing arrives on
                    `tournament_events` (watched tournament-wide, so an event
                    ADDED mid-tournament is caught too), and a check-in arrives
                    on `tournament_participants` / `tournament_pairs`, which are
                    watched per event id. Since 00120 an entry REMOVED arrives as
                    an UPDATE on `tournament_events`, which the same
                    tournament-wide listener already hears.

                    The channel name is unique per surface, which live-tournament
                    requires: `/tournaments/[id]` holds `player-tournament-${id}`
                    and the event page holds `player-tournament-event-${eventId}`,
                    so this one is prefixed `feed-` to match the app's other feed
                    channel (`feed-matches`). Several of these mount on one socket
                    — @supabase/ssr 0.5.2 caches the browser client in a module
                    singleton (`cachedBrowserClient`), so createClient() returns
                    the same instance to every mount. */}
                <LiveTournament
                  channel={`feed-tournament-${t.id}`}
                  tournamentId={t.id}
                  eventIds={eventIds}
                />
                <ActiveTournamentCard
                  tournamentId={t.id}
                  name={t.name}
                  startDate={t.start_date}
                  todayKey={todayKey}
                  events={running.map(
                    (e): ActiveEntry => ({
                      eventId: e.id,
                      eventType: e.event_type,
                      status: e.status,
                      mine: myEntryIn(e.id),
                    }),
                  )}
                  // Distinct PEOPLE, not rows: a member in both the singles and
                  // the doubles is one player, and a pair is two. Counted with
                  // the same helper /tournaments counts its hero's field with, so
                  // the two screens cannot print different numbers for the same
                  // tournament. Scoped to the RUNNING events only — somebody
                  // entered in a sibling event that has already finished is not
                  // playing right now.
                  entered={countEnteredPlayers(
                    tournamentEntryRows.filter((r) => eventIds.includes(r.event_id)),
                    tournamentPairRows.filter((r) => eventIds.includes(r.event_id)),
                  )}
                />
              </Fragment>
            );
          })}

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
