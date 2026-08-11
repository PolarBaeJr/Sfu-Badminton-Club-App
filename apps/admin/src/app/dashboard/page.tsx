export const dynamic = 'force-dynamic';
import { createAdminClient, getAuthenticatedConsoleUser } from '@/lib/supabase-server';
import { accessLevelFor, atLeast, canAccess, permissionsOf, permits } from '@/lib/permissions';
import { AvatarChip, Badge, Card, EmptyState, PageHeader, ResponsiveTable, TableCard, Atomic } from '@badminton/ui';
import {
  CLUB_TIMEZONE,
  EVENT_TYPE_LABELS,
  formatRelativeTime,
  getCheckinWindow,
  getMissingLegalDocuments,
  parseCheckinSettings,
  wallClockToUtc,
} from '@badminton/shared';
import Link from 'next/link';
import { PlayerActions } from '../players/player-actions';
import { openableSections } from '@/components/nav-sections';
import { getSeasonFinances } from '@/lib/season-finance';
import { getDashboardFinances } from '@/lib/dashboard-finance';
import { getOutstandingClubFees } from '@/lib/fees-outstanding';
import { clubWeek } from '@/lib/club-week';
import { ActionLink } from './action-link';

/** Money, formatted the way the finance cards on /fees format it. */
const money = (cents: number) => `$${(Math.abs(cents) / 100).toFixed(2)}`;

/** A club-local wall clock reading of an instant — "19:00", never "02:00Z". */
const clubTime = (at: Date) =>
  new Intl.DateTimeFormat('en-GB', {
    timeZone: CLUB_TIMEZONE,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(at);

/** "MON" — the day somebody joined, read in the club's timezone, not the server's. */
const clubWeekday = (iso: string) =>
  new Intl.DateTimeFormat('en-US', { timeZone: CLUB_TIMEZONE, weekday: 'short' })
    .format(new Date(iso))
    .toUpperCase();

/** "3 Aug" — short enough for a micro-line, still club-local. */
const clubDay = (iso: string) =>
  new Intl.DateTimeFormat('en-GB', { timeZone: CLUB_TIMEZONE, day: 'numeric', month: 'short' })
    .format(new Date(iso));

const plural = (n: number, one: string, many = `${one}s`) => (n === 1 ? one : many);

// Section heading inside a card. The console's cards carry a small uppercase
// display label, never an <h1> — PageHeader owns the only one on the page.
const SECTION = 'font-[family-name:var(--display)] text-[13px] font-bold uppercase tracking-[0.12em] text-[var(--ink)]';
const MICRO = 'font-mono text-[10px] uppercase tracking-[0.14em] text-[var(--text-muted)]';
const TH = 'px-4 py-3 text-left font-mono text-[10px] font-medium uppercase tracking-[0.12em] text-[var(--text-muted)]';
const TD = 'px-4 py-3 align-middle';

// Only needed to give the "no matches for you" branch of the fetch below a type
// to agree with — the admin client carries no generated Database type, so the
// real query's rows are untyped.
type MatchParticipant = {
  team_side: string;
  player?: { id: string; full_name: string; avatar_url: string | null } | null;
};
type DashboardMatch = {
  id: string;
  score_summary: string | null;
  result_status: string;
  match_type: string;
  event_type: string;
  created_at: string;
  match_participants?: MatchParticipant[] | null;
};

// Same job for the pending-approvals query: it only needs a type so the
// not-an-approver branch agrees with the real one.
type PendingPlayer = {
  id: string;
  full_name: string;
  email: string;
  avatar_url: string | null;
  created_at: string;
  status: string;
  active_flag: boolean;
  role: string;
  is_exec: boolean;
  is_trainer: boolean;
  fee_exempt: boolean;
};

type Acceptance = { document: string; version: string; accepted_at: string };
type Joiner = {
  id: string;
  full_name: string;
  avatar_url: string | null;
  joined_at: string;
  waiver_reset_at: string | null;
  waiver_acceptances?: Acceptance[] | null;
};

type TonightSession = {
  id: string;
  name: string | null;
  location: string;
  date: string;
  start_time: string | null;
  end_time: string | null;
  status: string;
};

export default async function DashboardPage() {
  const supabase = createAdminClient();

  // ------------------------------------------------------------------------
  // WHO IS LOOKING, AND WHAT THEY MAY SEE
  //
  // THE DASHBOARD IS THE ONE SCREEN THAT AGGREGATES EVERY OTHER AREA, which
  // makes it the easiest place in the console to leak: every panel here is a
  // slice of a section that enforces its own gate, and a figure withheld on
  // /fees is still withheld when it is a stat cell.
  //
  // So every flag below asks for the capability that owns the DATA, not for
  // `isAdmin` and not for one blanket "can see the dashboard" flag, and every
  // flag gates a FETCH rather than a piece of markup. A hidden panel whose
  // query still ran has already shipped its rows into the RSC payload, where
  // anybody with devtools can read them — that is how four live leaks were
  // found across /fees, /sessions and /players, every one of them an
  // unconditional fetch feeding a conditional render.
  // ------------------------------------------------------------------------
  const viewer = await getAuthenticatedConsoleUser();
  const level = accessLevelFor(viewer);
  const permissions = permissionsOf(viewer);

  // Sections. `canAccess` asks the same question the sidebar and the middleware
  // ask, through the same helper, so a panel here can never link somewhere that
  // bounces to /unauthorized. There is no `matches.read`, `sessions.read` or
  // `disputes.read` in the vocabulary — those areas have a page key and nothing
  // finer — so the page key IS the capability that owns their data.
  const showMatches = canAccess(level, permissions, '/matches');
  const showSessions = canAccess(level, permissions, '/sessions');
  const showDisputes = canAccess(level, permissions, '/disputes');
  const showWalkovers = canAccess(level, permissions, '/walkovers');
  const showTournaments = canAccess(level, permissions, '/tournaments');
  const showChallenges = canAccess(level, permissions, '/challenges');

  // NOT canAccess(…, '/players') — a COUNT of the members is roster data, and
  // the roster has its own capability. Reaching /players needs players.page,
  // which somebody may hold in order to add a member without browsing the club;
  // handing them the size of it would be the same leak, one figure at a time.
  const canReadRoster = permits(level, permissions, 'players.read');
  // Deciding a pending signup is exec work, and this gates a FETCH: anybody who
  // kept the panel without it would be handed the pending list and a dialog
  // whose every Save throws.
  const canApprove = permits(level, permissions, 'players.approve.write');

  // NOT canAccess(level, …, '/fees'). Reaching /fees needs `fees.page`, which
  // buys the SECTION and no ledger in it — an exec holds it, and so does
  // anybody handed nothing but the ability to file an expense.
  const showFinances = permits(level, permissions, 'fees.netposition.read');
  // The club-fee ledger, which is what "fees outstanding" is a reading of, and
  // which also decides whether the season's PRICE LIST is selected at all —
  // see the season query below.
  const showClubFees = permits(level, permissions, 'fees.clubfees.read');
  // The ledgers underneath, one capability each, for the narrowed landing at
  // the bottom. Each gates its own fetch inside getDashboardFinances().
  const showExpenses = permits(level, permissions, 'fees.expenses.read');
  const showOtherIncome = permits(level, permissions, 'fees.otherincome.read');
  // An affordance rather than data: it opens /fees, where the form lives and
  // the action re-checks. Nothing is fetched for it.
  const canAddExpense = permits(level, permissions, 'fees.expenses.add.write');

  // DOES ANY PANEL ON THIS PAGE RENDER AT ALL?
  //
  // Somebody narrowed to the Finance role holds fees.page, fees.expenses.read
  // and fees.expenses.add.write, and not one flag above asks for any of them:
  // she signed in, landed here because this is where sign-in lands, and got a
  // header and nothing else. Being narrowed looked identical to the app being
  // broken.
  //
  // EVERYTHING IN THE NARROWED LANDING RENDERS ONLY WHEN THIS IS FALSE,
  // deliberately. An unrestricted exec holds fees.expenses.read — it is in
  // EXEC_BASELINE — so a tile gated on the capability alone would appear for
  // every exec and admin in the club. There is no capability that separates the
  // Finance role from an ordinary exec inside the fees area (ROLE_DEFAULTS
  // .finance IS that subset of the baseline), so the second condition can only
  // be "no panel of the ordinary dashboard is yours". It is a pure function of
  // level and permissions, decided before the first query, and no unrestricted
  // level can reach it.
  //
  // EVERY GATE THAT DRAWS A PANEL BELOW MUST BE IN THIS LIST, in both
  // directions: one missing here and a narrowed person gets the signpost AND a
  // panel; one left here after its panel is deleted and they get hasTiles with
  // nothing to show, which is the blank screen this branch exists to prevent.
  // The hand write-down in lib/__tests__/dashboard-landing.test.ts pins it.
  const hasTiles =
    canReadRoster || canApprove || showDisputes || showWalkovers || showMatches
    || showSessions || showTournaments || showChallenges || showFinances || showClubFees;

  // Where such a person CAN go. Derived from the nav list through the same
  // canAccess() the sidebar and the middleware use, so a section added later
  // signposts itself with no list here to keep.
  const openSections = hasTiles
    ? []
    : openableSections(level, permissions).filter((item) => item.href !== '/dashboard');

  // ------------------------------------------------------------------------
  // THE SEASON, AND THE ONE COLUMN PAIR THAT IS NOT FURNITURE
  //
  // The name is page furniture — it is in the header eyebrow, it is on
  // /sessions for anybody who reaches that section, and the player app prints
  // it publicly. The two fee columns are NOT: they are the club's price list,
  // and a sibling agent found /fees shipping them to anybody who could read the
  // expense ledger. So the column list itself is chosen by the gate, and a
  // viewer without fees.clubfees.read never has the prices in their payload at
  // all — not hidden, absent.
  // ------------------------------------------------------------------------
  const { data: season } = await supabase
    .from('seasons')
    .select(showClubFees ? 'id, name, competitive_fee_cents, recreational_fee_cents' : 'id, name')
    .eq('active_flag', true)
    .maybeSingle<{
      id: string;
      name: string;
      competitive_fee_cents?: number;
      recreational_fee_cents?: number;
    }>();

  const week = clubWeek();
  // The club-local midnight that opens this week, as the UTC instant a
  // TIMESTAMPTZ comparison needs. `joined_at` is an instant, `week.start` is a
  // club calendar day, and wallClockToUtc is the repo's existing bridge between
  // the two (it is what the check-in window is built from). Doing this with
  // `new Date(week.start)` would parse the string as UTC midnight and count
  // Sunday evening's joiners into the wrong week for eight months of the year.
  const [wy, wm, wd] = week.start.split('-').map(Number) as [number, number, number];
  const weekStartInstant = wallClockToUtc(wy, wm, wd, 0, 0).toISOString();

  // Gate the FETCHES, not just the panels.
  const noCount = Promise.resolve({ count: null as number | null });
  const noRows = <T,>() => Promise.resolve({ data: null as T[] | null });

  const [
    { count: totalMembers },
    { count: activeMembers },
    { count: pendingPlayers },
    { count: openDisputes },
    { count: pendingWalkovers },
    { count: sessionsThisWeek },
    { count: matchesLogged },
    { count: activeTournaments },
    { count: activeChallenges },
    { data: pendingPlayersList },
    { data: unconfirmedMatches },
    { data: joiners },
    { data: legalDocs },
  ] = await Promise.all([
    // ---- players.read ----------------------------------------------------
    canReadRoster
      ? supabase.from('players').select('id', { count: 'exact', head: true }).neq('status', 'pending_approval')
      : noCount,
    canReadRoster
      ? supabase.from('players').select('id', { count: 'exact', head: true }).neq('status', 'pending_approval').eq('active_flag', true)
      : noCount,

    // ---- players.approve.write -------------------------------------------
    // Approving is exec work, so the COUNT of people waiting on a decision is
    // exec work too. It used to ride on the roster flag, which is trainer
    // level, so a trainer saw how many decisions they cannot make.
    canApprove
      ? supabase.from('players').select('id', { count: 'exact', head: true }).eq('status', 'pending_approval')
      : noCount,

    // ---- disputes.page / walkovers.page ----------------------------------
    showDisputes
      ? supabase.from('disputes').select('id', { count: 'exact', head: true }).eq('status', 'open')
      : noCount,
    showWalkovers
      ? supabase.from('walkovers').select('id', { count: 'exact', head: true }).eq('status', 'pending')
      : noCount,

    // ---- sessions.page ---------------------------------------------------
    // Between two club-local calendar days, compared as strings against a DATE
    // column, so no timezone enters the query. See lib/club-week.ts.
    showSessions
      ? supabase.from('sessions').select('id', { count: 'exact', head: true }).gte('date', week.start).lte('date', week.end)
      : noCount,

    // ---- matches.page ----------------------------------------------------
    // Scoped to the active season when there is one: the page is framed as a
    // term ("CONSOLE · SPRING 2026") and a lifetime total under a term heading
    // is a figure that answers a question nobody asked.
    showMatches
      ? (season
          ? supabase.from('matches').select('id', { count: 'exact', head: true }).eq('result_status', 'confirmed').eq('season_id', season.id)
          : supabase.from('matches').select('id', { count: 'exact', head: true }).eq('result_status', 'confirmed'))
      : noCount,

    // ---- tournaments.page / challenges.page ------------------------------
    showTournaments
      ? supabase.from('tournaments').select('id', { count: 'exact', head: true }).eq('status', 'active')
      : noCount,
    showChallenges
      ? supabase.from('challenges').select('id', { count: 'exact', head: true }).in('status', ['proposed', 'partially_confirmed', 'accepted'])
      : noCount,

    // ---- the pending-signup rows -----------------------------------------
    canApprove
      ? supabase
          .from('players')
          // The flag columns are here for the Edit dialog, which reads them to
          // seed its controls — it would otherwise open showing "None" for an
          // exec's console access and offer to take it away.
          .select('id, full_name, email, avatar_url, created_at, status, active_flag, role, is_exec, is_trainer, fee_exempt')
          .eq('status', 'pending_approval')
          .order('created_at', { ascending: false })
          .limit(6)
      : noRows<PendingPlayer>(),

    // ---- the unconfirmed-match rows --------------------------------------
    // Participant names and avatars come with the match because they ARE the
    // match — /matches shows the same names under the same capability. This is
    // not a roster read: it is bounded by the rows on screen and reaches no
    // member who is not in one of them.
    showMatches
      ? supabase
          .from('matches')
          .select('id, score_summary, result_status, match_type, event_type, created_at, match_participants(team_side, player:players(id, full_name, avatar_url))')
          .in('result_status', ['pending_confirmation', 'disputed'])
          .order('created_at', { ascending: false })
          .limit(6)
      : noRows<DashboardMatch>(),

    // ---- this week's joiners ---------------------------------------------
    canReadRoster
      ? supabase
          .from('players')
          .select('id, full_name, avatar_url, joined_at, waiver_reset_at, waiver_acceptances(document, version, accepted_at)')
          .neq('status', 'pending_approval')
          .gte('joined_at', weekStartInstant)
          .order('joined_at', { ascending: false })
          .limit(6)
      : noRows<Joiner>(),

    // The current document versions the waiver badges are measured against.
    // Nothing outside those badges reads them, so there is no round trip when
    // there is no joiner list.
    canReadRoster
      ? supabase.from('legal_documents').select('document, version, reacceptance_required_since')
      : noRows<{ document: string; version: string; reacceptance_required_since: string | null }>(),
  ]);

  // ------------------------------------------------------------------------
  // TONIGHT — one query, two answers
  //
  // The next session on or after today. When its date IS today it is tonight's
  // session; when it is not, there is no session tonight and this is the next
  // one, which is the thing an officer wanted to know instead. Asking twice
  // would be two round trips for one line of text.
  // ------------------------------------------------------------------------
  const { data: nextSession } = showSessions
    ? await supabase
        .from('sessions')
        .select('id, name, location, date, start_time, end_time, status')
        .gte('date', week.today)
        .order('date', { ascending: true })
        .order('start_time', { ascending: true, nullsFirst: false })
        .limit(1)
        .maybeSingle<TonightSession>()
    : { data: null };

  const isTonight = Boolean(nextSession && nextSession.date === week.today);

  // session_checkin_open() reads these two tunables out of platform_settings on
  // every call and is the enforcement source of truth; getCheckinWindow mirrors
  // it. Fetched rather than taken from the TypeScript fallback so the DOORS
  // line agrees with the gate the player app will actually hit — the fallback
  // is a guess, and platform_settings is admin-editable.
  const [{ data: checkinSetting }, { count: checkedIn }] = await Promise.all([
    isTonight
      ? supabase.from('platform_settings').select('value').eq('key', 'session_attendance').maybeSingle()
      : Promise.resolve({ data: null as { value: unknown } | null }),
    // 'checked_in' and 'present' are both in the room; 'no_show' and 'excused'
    // are not. A bare row count would print the no-shows as attendance.
    isTonight && nextSession
      ? supabase
          .from('session_attendance')
          .select('id', { count: 'exact', head: true })
          .eq('session_id', nextSession.id)
          .in('status', ['checked_in', 'present'])
      : noCount,
  ]);

  const doorsAt =
    isTonight && nextSession
      ? getCheckinWindow(nextSession, parseCheckinSettings(checkinSetting?.value ?? null)).opensAt
      : null;

  // ------------------------------------------------------------------------
  // Fees outstanding — an AMOUNT, and the only figure on this page assembled
  // from two tables. The arithmetic lives in lib/fees-outstanding.ts with a
  // test on it rather than here; see the note in that file.
  // ------------------------------------------------------------------------
  const outstandingCents =
    showClubFees && season && season.competitive_fee_cents != null && season.recreational_fee_cents != null
      ? await getOutstandingClubFees(supabase, {
          id: season.id,
          competitive_fee_cents: season.competitive_fee_cents,
          recreational_fee_cents: season.recreational_fee_cents,
        })
      : null;

  // Finance snapshot for the active season: money in, money out, and the net.
  // The net is the headline because it is the question the club owner actually
  // asks; income alone reads like good news no matter what has been spent.
  let seasonIncomeCents = 0;
  let seasonExpenseCents = 0;
  let seasonNetCents = 0;
  if (showFinances && season) {
    // Every ledger, via the shared helper. Income used to be summed inline from
    // club_fees only, so recorded reinstatement and tournament money read as
    // $0.00 — and it was wrong here AND on /fees because each page did its own
    // arithmetic. Net is computed in exactly one place for the same reason.
    const finances = await getSeasonFinances(supabase, { id: season.id, name: season.name });
    seasonIncomeCents = finances.income.totalCents;
    seasonExpenseCents = finances.expenseCents;
    seasonNetCents = finances.netCents;
  }

  // The narrowed landing's own figures: one query per ledger this person may
  // read and none at all for the ledgers they may not, decided inside
  // getDashboardFinances. Nothing is fetched when the ordinary dashboard
  // rendered.
  const ledgers = hasTiles
    ? null
    : await getDashboardFinances(supabase, {
        expenses: showExpenses,
        clubFees: showClubFees,
        otherIncome: showOtherIncome,
      });

  // ------------------------------------------------------------------------
  // SHAPING
  // ------------------------------------------------------------------------
  const joinerRows = (joiners ?? []).map((player) => {
    const acceptances = (player.waiver_acceptances ?? []) as Acceptance[];
    // The same predicate the roster uses, through the same shared helper, so a
    // member cannot read "No waiver" here and "Good standing" on /players.
    const waiverCurrent =
      (legalDocs?.length ?? 0) > 0 &&
      getMissingLegalDocuments(legalDocs ?? [], acceptances, new Date(), player.waiver_reset_at).length === 0;
    // The version and the date they signed it. Both were already fetched for
    // the badge above and were unreachable anywhere in the console — an officer
    // asked "which waiver did they sign, and when" and had nowhere to look.
    // Free here, so it is shown here.
    const waiver = acceptances
      .filter((a) => a.document === 'waiver')
      .sort((a, b) => b.accepted_at.localeCompare(a.accepted_at))[0];
    return { player, waiverCurrent, waiver };
  });

  const joinersWithoutWaiver = joinerRows.filter((r) => !r.waiverCurrent).length;

  // ------------------------------------------------------------------------
  // THE ALERT BAND
  //
  // Every clause is omitted individually at zero, and every clause is gated on
  // the capability that owns the figure in it — an ungated clause would leak
  // the counts the panels hide, one sentence at a time. The band itself is not
  // rendered when there is nothing in it: a "0 pending · 0 open" band is a
  // warning nobody can act on, and the guidelines forbid it outright.
  //
  // The waiver clause is scoped to THIS WEEK'S JOINERS and says so. A club-wide
  // unsigned count would be a full roster scan with nested acceptances for one
  // sentence, and that scan is not worth a line of text.
  // ------------------------------------------------------------------------
  const alertTerms = [
    canApprove && (pendingPlayers ?? 0) > 0
      ? `${pendingPlayers} pending ${plural(pendingPlayers!, 'approval')}`
      : null,
    showDisputes && (openDisputes ?? 0) > 0
      ? `${openDisputes} open ${plural(openDisputes!, 'dispute')}`
      : null,
    showWalkovers && (pendingWalkovers ?? 0) > 0
      ? `${pendingWalkovers} pending ${plural(pendingWalkovers!, 'walkover')}`
      : null,
    canReadRoster && joinersWithoutWaiver > 0
      ? `${joinersWithoutWaiver} new ${plural(joinersWithoutWaiver, 'member')} without a waiver`
      : null,
  ].filter(Boolean) as string[];

  // Where Review goes. Always a door this person can open, in the order the
  // clauses are written, so the button never lands on /unauthorized.
  const reviewHref = canApprove && (pendingPlayers ?? 0) > 0
    ? '/players?tab=attention'
    : showDisputes && (openDisputes ?? 0) > 0
      ? '/disputes'
      : showWalkovers && (pendingWalkovers ?? 0) > 0
        ? '/walkovers'
        : '/players';

  // ONE PRIMARY ACTION, and only if this person can actually perform it. A red
  // button is the loudest thing on the screen; pointing it at a section that
  // will refuse the viewer is worse than having no button. Each destination is
  // the section that owns the control, and each capability implies that
  // section's page key (the resolver prunes anything whose area page is
  // missing), so none of these can 404 into /unauthorized.
  //
  // fees.expenses.add.write is deliberately NOT in this list: the narrowed
  // landing below already offers that exact affordance with the explanation
  // beside it, and two red buttons for one action is one of them being wrong.
  const primaryAction = permits(level, permissions, 'matches.create.write')
    ? { href: '/matches', label: 'Log a match' }
    : permits(level, permissions, 'sessions.create.write')
      ? { href: '/sessions', label: 'New session' }
      : permits(level, permissions, 'players.create.write')
        ? { href: '/players', label: 'Add a member' }
        : null;

  const eyebrow = season ? `Console · ${season.name}` : 'Console';

  // Panels, decided before the grid so an empty column collapses rather than
  // leaving a 2fr gap beside a lone card.
  const hasLeft = canApprove || showMatches;
  const hasRight = showSessions || canReadRoster || showTournaments || showChallenges || showFinances;

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={eyebrow}
        title="Dashboard"
        sub="Everything waiting on an officer today."
        watermark="D"
        actions={
          primaryAction ? (
            <ActionLink href={primaryAction.href}>{primaryAction.label}</ActionLink>
          ) : undefined
        }
      />

      {/* THE ALERT BAND. One bordered row, warning tones over a 6% wash —
          color-mix rather than a `/6` opacity modifier, because Tailwind v3
          silently drops `/opacity` on a var() arbitrary colour and compiles the
          wash to nothing at all. */}
      {alertTerms.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border border-[color-mix(in_oklab,var(--color-warning)_35%,transparent)] bg-[color-mix(in_oklab,var(--color-warning)_6%,transparent)] px-4 py-3">
          <span className="font-mono text-[11px] font-bold uppercase tracking-[0.14em] text-[var(--color-warning)]">
            Needs you
          </span>
          <p className="min-w-[12rem] flex-1 text-sm text-[var(--color-warning)]">
            {alertTerms.join(' · ')}
          </p>
          <ActionLink href={reviewHref} variant="ghost">Review</ActionLink>
        </div>
      )}

      {/* THE STAT STRIP. Bare number/label pairs, hairline above, below and
          between — `.stat-strip` in globals.css, the same strip /fees and
          /players use. Every cell links to the section it counts, and a cell
          the viewer may not see is OMITTED rather than zeroed: a hollow figure
          that bounces to /unauthorized is worse than no figure. The strip is
          grid-auto-flow:column, so the survivors simply widen. */}
      {(canReadRoster || showSessions || showClubFees || showMatches) && (
        <div className="stat-strip">
          {canReadRoster && (
            <Link href="/players" className="hover:bg-[var(--surface)] transition-colors">
              <p className="stat-label">Members</p>
              <p className="stat-value">{totalMembers ?? 0}</p>
            </Link>
          )}
          {/* NOT "active this term". `active_flag` is the club's own active
              marker on the roster row; nothing in the schema records activity
              against a TERM, and a count derived from this season's attendance
              would be sessions-area data behind a roster capability. The label
              says what the column means. */}
          {canReadRoster && (
            <Link href="/players" className="hover:bg-[var(--surface)] transition-colors">
              <p className="stat-label">Active roster</p>
              <p className="stat-value">{activeMembers ?? 0}</p>
            </Link>
          )}
          {showSessions && (
            <Link href="/sessions" className="hover:bg-[var(--surface)] transition-colors">
              <p className="stat-label">Sessions this week</p>
              <p className="stat-value">{sessionsThisWeek ?? 0}</p>
            </Link>
          )}
          {showClubFees && outstandingCents !== null && (
            <Link href="/fees" className="hover:bg-[var(--surface)] transition-colors">
              <p className="stat-label">Fees outstanding</p>
              <p className={`stat-value is-money ${outstandingCents > 0 ? 'text-[var(--color-warning)]' : ''}`}>
                <Atomic>{money(outstandingCents)}</Atomic>
              </p>
            </Link>
          )}
          {showMatches && (
            <Link href="/matches" className="hover:bg-[var(--surface)] transition-colors">
              <p className="stat-label">Matches logged</p>
              <p className="stat-value">{matchesLogged ?? 0}</p>
            </Link>
          )}
        </div>
      )}

      {(hasLeft || hasRight) && (
        <div
          className={`grid grid-cols-1 items-start gap-5 ${
            hasLeft && hasRight ? 'lg:grid-cols-[2fr_1fr]' : ''
          }`}
        >
          {/* ---------------------------------------------------------------
              LEFT — the work queue
              --------------------------------------------------------------- */}
          {hasLeft && (
            <div className="space-y-5">
              {/* PENDING APPROVALS — the signups an officer decides. Rendered
                  even when the list is empty, with an EmptyState rather than
                  nothing: "there is nobody waiting" and "this is not yours to
                  see" are different states, and a panel that vanishes on a
                  quiet day makes the second unreadable. */}
              {canApprove && (
                <Card padding={false}>
                  <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
                    <h2 className={SECTION}>Pending approvals</h2>
                    <span className={MICRO}>
                      {pendingPlayersList?.length ?? 0} waiting
                    </span>
                  </div>
                  {pendingPlayersList && pendingPlayersList.length > 0 ? (
                    <ResponsiveTable
                      cards={pendingPlayersList.map((player) => (
                        <TableCard
                          key={player.id}
                          title={
                            <Link href={`/players/${player.id}`} className="flex items-center gap-2 hover:text-[var(--color-accent)]">
                              <AvatarChip src={player.avatar_url} name={player.full_name} size="sm" id={player.id} />
                              {player.full_name}
                            </Link>
                          }
                          fields={[
                            { label: 'Email', value: player.email, wide: true },
                            { label: 'Submitted', value: formatRelativeTime(player.created_at) },
                          ]}
                          actions={
                            <PlayerActions
                              mode="edit"
                              playerId={player.id}
                              playerName={player.full_name}
                              playerData={player}
                              isAdmin={atLeast(level, 'admin')}
                              canApprove={canApprove}
                            />
                          }
                        />
                      ))}
                    >
                      <table className="w-full">
                        <thead>
                          <tr className="border-b border-[var(--border)]">
                            <th className={TH}>Member</th>
                            <th className={TH}>Submitted</th>
                            <th className={`${TH} text-right`}>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {pendingPlayersList.map((player) => (
                            <tr key={player.id} className="border-t border-[var(--border)] first:border-t-0">
                              <td className={TD}>
                                {/* A SIBLING of the Edit button, never wrapped
                                    around it: a <button> inside an <a> is
                                    unreachable by keyboard and is read as one
                                    control by a screen reader. */}
                                <Link href={`/players/${player.id}`} className="flex min-w-0 items-center gap-3 hover:text-[var(--color-accent)]">
                                  <AvatarChip src={player.avatar_url} name={player.full_name} size="sm" id={player.id} />
                                  <span className="min-w-0">
                                    <span className="block truncate text-sm text-[var(--text-primary)]">{player.full_name}</span>
                                    <span className={`block truncate ${MICRO}`}>{player.email}</span>
                                  </span>
                                </Link>
                              </td>
                              <td className={`${TD} font-mono text-xs text-[var(--text-muted)]`}>
                                {formatRelativeTime(player.created_at)}
                              </td>
                              {/* 44px floor on the row-action slot — officers
                                  tap these holding a phone and a clipboard. */}
                              <td className={`${TD} text-right [&_button]:min-h-[44px] [&_button]:min-w-[44px]`}>
                                <div className="flex justify-end">
                                  <PlayerActions
                                    mode="edit"
                                    playerId={player.id}
                                    playerName={player.full_name}
                                    playerData={player}
                                    isAdmin={atLeast(level, 'admin')}
                                    canApprove={canApprove}
                                  />
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </ResponsiveTable>
                  ) : (
                    <div className="px-4 py-6">
                      <EmptyState title="Nobody is waiting" description="Every signup has been decided." />
                    </div>
                  )}
                </Card>
              )}

              {/* AWAITING CONFIRMATION — results the club has not agreed on
                  yet. NOT called "approvals": there is no admin action that
                  confirms a match. Confirmation is the opponent's, in the
                  player app, and lib/actions/matches.ts has void and convert
                  and nothing that says yes. So the row offers Open and no
                  Approve button — a control whose action does not exist is
                  worse than an omitted one. */}
              {showMatches && (
                <Card padding={false}>
                  <div className="flex items-center justify-between gap-3 border-b border-[var(--border)] px-4 py-3">
                    <h2 className={SECTION}>Awaiting confirmation</h2>
                    <span className={MICRO}>{unconfirmedMatches?.length ?? 0} waiting</span>
                  </div>
                  {unconfirmedMatches && unconfirmedMatches.length > 0 ? (
                    <ResponsiveTable
                      cards={unconfirmedMatches.map((match) => {
                        const m = describeMatch(match);
                        return (
                          <TableCard
                            key={match.id}
                            title={
                              <span className="flex items-center gap-2">
                                {m.lead && (
                                  <AvatarChip src={m.lead.avatar_url} name={m.lead.full_name} size="sm" id={m.lead.id} />
                                )}
                                {m.title}
                              </span>
                            }
                            value={<Atomic separator=",">{match.score_summary ?? '—'}</Atomic>}
                            badges={match.result_status === 'disputed' ? <Badge variant="danger">Dispute</Badge> : undefined}
                            fields={[
                              { label: 'Kind', value: m.kind },
                              { label: 'Submitted', value: formatRelativeTime(match.created_at) },
                            ]}
                            actions={
                              <ActionLink href={match.result_status === 'disputed' && showDisputes ? '/disputes' : '/matches'} variant="ghost">
                                Open
                              </ActionLink>
                            }
                          />
                        );
                      })}
                    >
                      <table className="w-full">
                        <thead>
                          <tr className="border-b border-[var(--border)]">
                            <th className={TH}>Match</th>
                            <th className={TH}>Score</th>
                            <th className={TH}>Submitted</th>
                            <th className={`${TH} text-right`}>Action</th>
                          </tr>
                        </thead>
                        <tbody>
                          {unconfirmedMatches.map((match) => {
                            const m = describeMatch(match);
                            return (
                              <tr key={match.id} className="border-t border-[var(--border)] first:border-t-0">
                                <td className={TD}>
                                  <div className="flex min-w-0 items-center gap-3">
                                    {m.lead && (
                                      <AvatarChip src={m.lead.avatar_url} name={m.lead.full_name} size="sm" id={m.lead.id} />
                                    )}
                                    <div className="min-w-0">
                                      <p className="truncate text-sm text-[var(--text-primary)]">{m.title}</p>
                                      <p className={`truncate ${MICRO}`}>{m.kind}</p>
                                    </div>
                                  </div>
                                </td>
                                <td className={`${TD} font-mono text-sm text-[var(--text-primary)]`}>
                                  <Atomic separator=",">{match.score_summary ?? '—'}</Atomic>
                                </td>
                                <td className={`${TD} font-mono text-xs text-[var(--text-muted)]`}>
                                  {formatRelativeTime(match.created_at)}
                                </td>
                                <td className={`${TD} text-right`}>
                                  <div className="flex items-center justify-end gap-2">
                                    {match.result_status === 'disputed' && <Badge variant="danger">Dispute</Badge>}
                                    <ActionLink href={match.result_status === 'disputed' && showDisputes ? '/disputes' : '/matches'} variant="ghost">
                                      Open
                                    </ActionLink>
                                  </div>
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </ResponsiveTable>
                  ) : (
                    <div className="px-4 py-6">
                      <EmptyState title="Every result is settled" description="No match is waiting on a confirmation." />
                    </div>
                  )}
                </Card>
              )}
            </div>
          )}

          {/* ---------------------------------------------------------------
              RIGHT — tonight, and the term at a glance
              --------------------------------------------------------------- */}
          {hasRight && (
            <div className="space-y-5">
              {/* TONIGHT.
                  NO DENOMINATOR, NO METER, NO "SPOTS LEFT". The mockup showed
                  "CHECKED IN OF 36", a twelve-block capacity meter and
                  "6 SPOTS LEFT". `sessions` has no capacity column, no waitlist
                  table and no court column — the only `court` in the schema is
                  on tournament_matches, and `session_caps` in platform_settings
                  is the cap on RATED MATCHES PER PLAYER per session, not a door
                  capacity. There is nothing to divide by, and a denominator
                  computed from RSVPs or from the roster would be the same
                  invention with more steps. The bare count is the true figure,
                  so the bare count is what is shown. */}
              {showSessions && (
                <Card padding={false}>
                  <div className="border-b border-[var(--border)] px-4 py-3">
                    <h2 className={SECTION}>
                      {isTonight && nextSession
                        ? `Tonight · ${nextSession.location}`
                        : 'Next session'}
                    </h2>
                  </div>
                  <div className="px-4 py-4">
                    {isTonight && nextSession ? (
                      <>
                        <div className="flex items-end gap-3">
                          <span className="font-mono text-[40px] font-bold leading-none tracking-tight text-[var(--text-primary)]">
                            {checkedIn ?? 0}
                          </span>
                          <span className={`${MICRO} mb-1`}>Checked in</span>
                        </div>
                        <p className={`mt-4 ${MICRO}`}>
                          {[
                            doorsAt ? `Doors ${clubTime(doorsAt)}` : null,
                            nextSession.status === 'open' ? 'Check-in open' : 'Session closed',
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </p>
                      </>
                    ) : nextSession ? (
                      <div className="space-y-1">
                        <p className="text-sm text-[var(--text-primary)]">No session tonight.</p>
                        <p className={MICRO}>
                          Next · {clubWeekday(`${nextSession.date}T12:00:00Z`)} {clubDay(`${nextSession.date}T12:00:00Z`)} · {nextSession.location}
                        </p>
                      </div>
                    ) : (
                      <EmptyState title="Nothing scheduled" description="No session is on the calendar." />
                    )}
                  </div>
                </Card>
              )}

              {/* NEW THIS WEEK. The waiver VERSION and the date it was signed
                  sit under the badge: both were already fetched to compute the
                  badge, and a sibling found they had become unreachable
                  anywhere in the console. */}
              {canReadRoster && (
                <Card padding={false}>
                  <div className="border-b border-[var(--border)] px-4 py-3">
                    <h2 className={SECTION}>New this week</h2>
                  </div>
                  {joinerRows.length > 0 ? (
                    <div className="divide-y divide-[var(--border)]">
                      {joinerRows.map(({ player, waiverCurrent, waiver }) => (
                        <div key={player.id} className="flex items-center justify-between gap-3 px-4 py-3">
                          <Link href={`/players/${player.id}`} className="flex min-w-0 items-center gap-3 hover:text-[var(--color-accent)]">
                            <AvatarChip src={player.avatar_url} name={player.full_name} size="sm" id={player.id} />
                            <span className="min-w-0">
                              <span className="block truncate text-sm text-[var(--text-primary)]">{player.full_name}</span>
                              <span className={`block truncate ${MICRO}`}>
                                Joined {clubWeekday(player.joined_at)}
                                {waiverCurrent && waiver ? ` · ${waiver.version} · ${clubDay(waiver.accepted_at)}` : ''}
                              </span>
                            </span>
                          </Link>
                          <Badge variant={waiverCurrent ? 'success' : 'warning'}>
                            {waiverCurrent ? 'Waiver ok' : 'No waiver'}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="px-4 py-6">
                      <EmptyState title="Nobody new" description="No member has joined this week." />
                    </div>
                  )}
                </Card>
              )}

              {/* IN PLAY. Two counts that each belong to their own section, so
                  each row is gated separately and the card is omitted when
                  neither is the viewer's. */}
              {(showTournaments || showChallenges) && (
                <Card padding={false}>
                  <div className="border-b border-[var(--border)] px-4 py-3">
                    <h2 className={SECTION}>In play</h2>
                  </div>
                  <div className="divide-y divide-[var(--border)]">
                    {showTournaments && (
                      <Link href="/tournaments" className="flex items-baseline justify-between px-4 py-3 hover:bg-[var(--surface-2)] transition-colors">
                        <span className={MICRO}>Tournaments</span>
                        <span className="font-mono text-2xl font-bold leading-none text-[var(--text-primary)]">
                          {activeTournaments ?? 0}
                        </span>
                      </Link>
                    )}
                    {showChallenges && (
                      <Link href="/challenges" className="flex items-baseline justify-between px-4 py-3 hover:bg-[var(--surface-2)] transition-colors">
                        <span className={MICRO}>Challenges</span>
                        <span className="font-mono text-2xl font-bold leading-none text-[var(--text-primary)]">
                          {activeChallenges ?? 0}
                        </span>
                      </Link>
                    )}
                  </div>
                </Card>
              )}

              {/* NET POSITION. In, out, and whether the club is in the
                  positives — the question the club owner actually asks. */}
              {showFinances && season && (
                <Card padding={false}>
                  <div className="border-b border-[var(--border)] px-4 py-3">
                    <h2 className={SECTION}>{season.name} · Net position</h2>
                  </div>
                  <Link href="/fees" className="block px-4 py-4 hover:bg-[var(--surface-2)] transition-colors">
                    <p
                      className={`font-mono text-[32px] font-bold leading-none tracking-tight ${
                        seasonNetCents < 0 ? 'text-[var(--color-danger)]' : 'text-[var(--color-success)]'
                      }`}
                    >
                      <Atomic>{`${seasonNetCents < 0 ? '-' : ''}${money(seasonNetCents)}`}</Atomic>
                    </p>
                    <p className={`mt-3 ${MICRO}`}>
                      <Atomic>{money(seasonIncomeCents)}</Atomic> in · <Atomic>{money(seasonExpenseCents)}</Atomic> out
                    </p>
                  </Link>
                </Card>
              )}
            </div>
          )}
        </div>
      )}

      {/* THE NARROWED LANDING. Every panel above belongs to a capability this
          person does not hold, so rather than a header over an empty page they
          get the money they may see, the one thing they may file, and a list of
          the doors that will actually open. */}
      {!hasTiles && (
        <div className="space-y-5">
          {/* Each figure is present only because its own read was held and its
              own query ran; a null here means nothing was fetched, not that a
              card was hidden. */}
          {ledgers && (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
              {ledgers.expenseCents !== null && (
                <Card>
                  <p className={MICRO}>{ledgers.season.name} · Expenses</p>
                  <p className="font-mono text-2xl font-bold text-[var(--color-danger)]">
                    <Atomic>{`-${money(ledgers.expenseCents)}`}</Atomic>
                  </p>
                  <p className="mt-1 text-xs text-[var(--text-muted)]">Money the club has spent this season</p>
                </Card>
              )}
              {ledgers.clubFeeCents !== null && (
                <Card>
                  <p className={MICRO}>{ledgers.season.name} · Club fees</p>
                  <p className="font-mono text-2xl font-bold text-[var(--color-success)]">
                    <Atomic>{money(ledgers.clubFeeCents)}</Atomic>
                  </p>
                  <p className="mt-1 text-xs text-[var(--text-muted)]">Season dues collected</p>
                </Card>
              )}
              {ledgers.otherIncomeCents !== null && (
                <Card>
                  <p className={MICRO}>{ledgers.season.name} · Other income</p>
                  <p className="font-mono text-2xl font-bold text-[var(--color-success)]">
                    <Atomic>{money(ledgers.otherIncomeCents)}</Atomic>
                  </p>
                  <p className="mt-1 text-xs text-[var(--text-muted)]">Donations, grants and socials</p>
                </Card>
              )}
            </div>
          )}

          {/* Offered on the write alone, with no season and no ledger behind
              it: somebody may be able to file an expense and to see none, which
              is the state /fees was reshaped to support. */}
          {canAddExpense && (
            <Card className="flex flex-wrap items-center justify-between gap-4">
              <div>
                <p className="text-sm font-medium text-[var(--text-primary)]">Paid for something out of pocket?</p>
                <p className="mt-0.5 text-xs text-[var(--text-muted)]">
                  File it against the season so the club has a record of the spend and can pay you back.
                </p>
              </div>
              <ActionLink href="/fees?tab=expenses">Add an expense</ActionLink>
            </Card>
          )}

          {openSections.length > 0 && (
            <Card>
              <EmptyState
                title="Nothing here needs you"
                description="Your console access covers part of the club's work. These are the sections you can open."
                action={
                  <div className="flex flex-wrap justify-center gap-2">
                    {openSections.map(({ href, label, icon: Icon }) => (
                      <Link
                        key={href}
                        href={href}
                        className="inline-flex min-h-[44px] items-center gap-2 border border-[var(--border)] bg-[var(--bg-elevated)] px-3 text-sm text-[var(--text-secondary)] transition-colors hover:border-[var(--border-hover)] hover:text-[var(--text-primary)]"
                      >
                        <Icon className="h-4 w-4" />
                        {label}
                      </Link>
                    ))}
                  </div>
                }
              />
            </Card>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * "Marcus Ng vs Kiera Watanabe" over "SINGLES · RATED CHALLENGE", plus the
 * member whose avatar leads the row.
 *
 * supabase-js types an embedded one-to-one as either an object or an array
 * depending on how it inferred the relationship, so the player is normalised
 * here rather than at four call sites.
 */
function describeMatch(match: DashboardMatch) {
  const participants = match.match_participants ?? [];
  const playerOf = (p: MatchParticipant) => (Array.isArray(p.player) ? p.player[0] : p.player) ?? null;
  const names = (side: string) =>
    participants
      .filter((p) => p.team_side === side)
      .map((p) => playerOf(p)?.full_name)
      .filter(Boolean)
      .join(' & ');

  const a = names('a');
  const b = names('b');
  const lead = participants.filter((p) => p.team_side === 'a').map(playerOf).find(Boolean) ?? null;

  const kindWords = [
    match.match_type,
    EVENT_TYPE_LABELS[match.event_type as keyof typeof EVENT_TYPE_LABELS] ?? match.event_type,
  ];

  return {
    title: a && b ? `${a} vs ${b}` : a || b || 'Unnamed match',
    kind: kindWords.join(' · '),
    lead,
  };
}
