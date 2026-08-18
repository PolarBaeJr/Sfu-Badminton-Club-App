import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import { getCheckinSettings } from '@/lib/checkin-settings';
import {
  CLUB_TIMEZONE,
  formatDate,
  formatTime,
  getCheckinWindow,
  isCheckinOpen,
  getAccountStanding,
  unwrap,
  type AttendanceStatus,
  type SessionIntent,
  selectAllInChunks,
} from '@badminton/shared';
import { attendeeCountsBySession } from '@/lib/session-attendee-counts';
import { onVisibleTracks } from '@/lib/session-track-filter';
import { StandingNote } from '@/components/standing-notice';
import { redirect } from 'next/navigation';
import { SubscribeAllButton } from './subscribe-all';
import { Calendar } from 'lucide-react';
import { PageHeader } from '@badminton/ui';
import { SessionCard } from './session-card';
import { DeepLinkScroll } from './deep-link-scroll';
import { MonthCalendar, type CalendarEvent } from './month-calendar';
import {
  CALENDAR_WEEKDAYS,
  buildCalendarMonth,
  calendarMonthKeys,
  clubDateISO,
  describeMyState,
  groupSessionsByDay,
  isStillUpcoming,
  initialMonthIndex,
  tallyBySession,
  type MyState,
} from '@/lib/schedule';

// Past-session outcomes, in the member's own words. 'going'/'declined' never
// reach here (a closed session has no live RSVP worth reporting), so they map
// to nothing rather than to a misleading "Going" on a night already over.
const PAST_STATE_LABEL: Partial<Record<MyState, { text: string; tone: string }>> = {
  checked_in: { text: 'Attended', tone: 'chip chip-success' },
  attended: { text: 'Attended', tone: 'chip chip-success' },
  no_show: { text: 'No-show', tone: 'chip' },
  excused: { text: 'Excused', tone: 'chip' },
};

export default async function SessionsPage() {
  const player = await getCurrentPlayer();
  if (!player) redirect('/login');
  // The schedule stays visible for everyone — knowing when the club plays is
  // not a privilege. RsvpButtons/CheckInButton read the same standing from
  // context and withhold themselves; this is the line that says why.
  const standing = getAccountStanding(player);

  const supabase = await createServerSupabaseClient();

  // Live window tunables, so the Check In button and its "opens at" label agree
  // with session_checkin_open() instead of a hardcoded snapshot of prod.
  const checkinSettings = await getCheckinSettings();

  // Members see the season they are actually playing in. Last term's sessions
  // hanging around under this term's is confusing here in a way it is not in the
  // console: a member reads this page to decide whether to turn up tonight.
  //
  // Sessions with NO season are kept — unassigned is not "another season", and
  // dropping them would leave them on no page at all. If nothing is active the
  // filter is skipped, because an empty schedule caused by an unactivated season
  // looks exactly like a cancelled club.
  //
  // The season's name is selected as well: it is the difference between an
  // empty schedule that reads as a bug and one that names the term it is empty
  // for. Its start/end dates are what the calendar's month nav is bounded to —
  // they say how far the loaded data is trustworthy.
  const { data: activeSeason } = await supabase
    .from('seasons').select('id, name, start_date, end_date').eq('active_flag', true).maybeSingle();
  const inActiveSeason = <T extends { or: (f: string) => T }>(q: T): T =>
    activeSeason ? q.or(`season_id.eq.${activeSeason.id},season_id.is.null`) : q;

  // WHY THE THREE SESSION READS ARE `unwrap`ped AND THE FOUR BELOW ARE NOT.
  //
  // These three ARE the page. If one of them is refused there is no honest way
  // to draw this screen: the empty state says "No sessions yet — nothing has
  // been posted for [season] yet", and a member who reads that when twelve open
  // sessions exist has been told a specific, confident lie and given no reason
  // to report it. That is not a hypothetical — it is what a `pending_approval`
  // member saw for months, because `?? []` renders a refused read and an empty
  // club as the same value.
  //
  // `unwrap` throws, and sessions/error.tsx catches it: "something went wrong,
  // try again" is a worse-looking screen and a truthful one. The four reads
  // that follow keep `?? []` deliberately — an attendance or RSVP read that
  // fails costs a chip and a count, and taking the whole schedule down over a
  // missing "Going" badge would be the wrong trade in the other direction.
  //
  // THE TWO TABLE-WIDE READS ARE GONE FROM THIS BATCH. They used to sit here as
  // `session_attendance.in('status', …)` and `session_rsvp.eq('intent','going')`
  // with NO session, player or season filter — the entire tables, on every
  // member's page load, to tally the counts printed on the cards. Production
  // sets PGRST_DB_MAX_ROWS=1000, so past about 25 sessions PostgREST truncated
  // them with no error and every card under-counted from then on. They now run
  // below, scoped to the sessions this page actually draws and paged, which
  // needs the session ids and therefore a second round trip.
  const [openSessionsRes, closedSessionsRes, calendarSessionsRes, { data: myAttendance }, { data: myRsvp }] = await Promise.all([
    onVisibleTracks(
      inActiveSeason(
        supabase
          .from('sessions')
          .select('*')
          .eq('status', 'open')
      ),
      player.status
    ).order('date', { ascending: true }).order('start_time', { ascending: true, nullsFirst: false }),
    onVisibleTracks(
      inActiveSeason(
        supabase
          .from('sessions')
          .select('*')
          .eq('status', 'closed')
      ),
      player.status
    )
      .order('date', { ascending: false })
      .limit(10),
    // The calendar's own query, and the reason it is not assembled from the two
    // above: `closedSessions` is .limit(10), so a month grid built out of them
    // would print an August with two nights in it when the club played eight —
    // an empty-looking month that is a lie rather than an absence. This selects
    // EVERY session in the loaded scope, so the months the nav can reach are
    // exactly the months whose contents are complete.
    //
    // No status filter: the session_status enum is ('open','closed') and
    // nothing else (00001_schema.sql:88), so "all of them" is those two.
    //
    // season_id is selected for the month nav alone: the query deliberately
    // returns the active season's nights AND every season-less night, and the
    // nav has to tell those two apart — see calendarMonthKeys.
    onVisibleTracks(
      inActiveSeason(
        supabase
          .from('sessions')
          .select('id, name, date, start_time, status, season_id')
      ),
      player.status
    ).order('date', { ascending: true }).order('start_time', { ascending: true, nullsFirst: false }),
    // Both of these are the member's OWN rows, so they are bounded by one
    // person's history rather than the club's — they stay in this batch.
    supabase
      .from('session_attendance')
      .select('session_id, status')
      .eq('player_id', player.id),
    supabase
      .from('session_rsvp')
      .select('session_id, intent')
      .eq('player_id', player.id),
  ]);

  // Refused reads become an exception here, not an empty schedule. `unwrap`
  // throws on res.error; a successful query returns [] and passes through.
  const openSessions = unwrap(openSessionsRes);
  const closedSessions = unwrap(closedSessionsRes);
  const calendarSessions = unwrap(calendarSessionsRes);

  // THE SESSIONS THAT ACTUALLY CARRY A COUNT, and nothing else. The cards under
  // "Upcoming" are drawn from `openSessions` and the turnout line from
  // `closedSessions` (itself .limit(10)); the calendar grid prints no tallies,
  // so its far larger id list is deliberately not asked for.
  //
  // Scoping alone is NOT the fix, which is worth saying plainly because it
  // looks like it should be: 25 sessions of 40 members is exactly the 1,000-row
  // cap, so the narrowed read would start truncating again the moment the club
  // got slightly busier. selectAllInChunks pages within each chunk, so the
  // answer is exact at any size — see ROW_PAGE_SIZE for why "short page means
  // done" is only sound with a page size under the cap.
  const talliedSessionIds = Array.from(new Set([
    ...openSessions.map((s) => s.id as string),
    ...closedSessions.map((s) => s.id as string),
  ]));

  const [checkedInCounts, { data: goingRows }] = await Promise.all([
    // FIX-LIST #12. This used to read the attendance ROWS and count them here.
    // The card only ever needed the number, and the rows carry each member's
    // no-show and excused-absence history — so the number now comes from an
    // aggregate the database computes (get_session_attendee_counts, 00152) and
    // the rows stop being readable at all (00153). Admin-marked no-show and
    // excused rows are excluded there, exactly as the `.in('status', …)` here
    // excluded them.
    //
    // `as never` is the same cast the sibling call below already carries: the
    // generated Database type makes tsc give up on this builder chain with
    // TS2589 (excessively deep), whichever type the parameter is declared as.
    // So the compiler is NOT checking the fallback's chain here. What stands in
    // for it is that the fallback IS the read that was at this call site before
    // ab9a2b1 — same table, same filters, same order/range — running in
    // production today, moved rather than written.
    attendeeCountsBySession(supabase as never, talliedSessionIds),
    selectAllInChunks<{ session_id: string }>(talliedSessionIds, (batch, from, to) =>
      supabase
        .from('session_rsvp')
        .select('session_id')
        .in('session_id', batch)
        .eq('intent', 'going')
        .order('session_id')
        .range(from, to) as never,
    ),
  ]);

  const myStatusBySession = new Map<string, AttendanceStatus>(
    (myAttendance ?? []).map((r) => [r.session_id as string, r.status as AttendanceStatus])
  );
  const myIntentBySession = new Map<string, SessionIntent>(
    (myRsvp ?? []).map((r) => [r.session_id as string, r.intent as SessionIntent])
  );
  const checkedInBySession = checkedInCounts;
  const goingBySession = tallyBySession(goingRows);

  // One clock reading for the whole render. Every "Today"/"Tomorrow" heading
  // and every check-in window on the page is derived from these two values, so
  // the screen cannot contradict itself — and because it is all resolved on the
  // server there is no second, browser-local answer to disagree with.
  const now = new Date();
  const todayISO = clubDateISO(now);

  // STATUS IS NOT ENOUGH ON ITS OWN. Closing a session is a manual admin action
  // with no cron behind it, so a night nobody remembered to close stays 'open'
  // for ever. The query above can only ask for status, which is how a Tuesday
  // two days gone sat at the top of a list headed "Upcoming" above the words
  // "3 sessions accepting check-ins" — when its check-in had shut at 22:00 that
  // night and nothing on the page could be done about it.
  //
  // The clock decides instead: keep a night until its check-in window CLOSES.
  // That keeps every genuinely future session (its window has not closed, and
  // in most cases has not opened either — the card says "Opens at 9:30 AM"),
  // keeps tonight for as long as anyone can still check in, and drops a night
  // the moment it can no longer be acted on. A forgotten `status` can now only
  // make a night linger until its own end time, not indefinitely.
  const upcoming = openSessions.filter((s) =>
    isStillUpcoming(getCheckinWindow(s, checkinSettings).closesAt, now)
  );
  const upcomingCount = upcoming.length;

  const days = groupSessionsByDay(upcoming, todayISO);

  // The accent still guards against a same-day surprise: with the filter above
  // the list can no longer start in the past, but a night still inside its
  // window is 'today' rather than 'next', so this keeps preferring a session
  // dated today or later before falling back.
  const nextSessionId = (upcoming.find((s) => s.date >= todayISO) ?? upcoming[0])?.id as string | undefined;

  // The upcoming nights the member has already committed to. It answers "what
  // have I said yes to?" without opening a card — as the count in the Upcoming
  // sub-line, and as the accent on those nights' cells in the month grid.
  const myUpcoming = upcoming.filter((s) => {
    const state = describeMyState(myStatusBySession.get(s.id), myIntentBySession.get(s.id));
    return state === 'going' || state === 'checked_in' || state === 'attended';
  });
  const myUpcomingCount = myUpcoming.length;

  // Turnout over the closed nights this page already fetched. The figure is
  // scoped to that window and the card says so: `closedSessions` is .limit(10),
  // so "3 of the last 8" is exactly true while "3 sessions this season" would
  // be a capped number pretending to be a total.
  //
  // 'checked_in' and 'present' are the two statuses that mean the member was
  // actually there; 'no_show' and 'excused' are attendance rows too, and
  // counting them would turn "you missed it" into "you turned up".
  const closed = closedSessions;
  const attendedIds = new Set(
    (myAttendance ?? [])
      .filter((r) => r.status === 'checked_in' || r.status === 'present')
      .map((r) => r.session_id as string),
  );
  const attendedRecently = closed.filter((s) => attendedIds.has(s.id as string)).length;

  // ── THE MONTH GRID ────────────────────────────────────────────────────────
  //
  // Bounded, not paged. `calendarSessions` is everything this page loaded —
  // the active season plus any session with no season on it — and the nav is
  // limited to exactly the months that range covers. The alternative was
  // fetching per month on demand, which buys a member the ability to walk into
  // last spring; the cost is a second round trip and a screen that can show a
  // blank month while it waits. Bounding is the honest, cheap answer: an arrow
  // that stops means "there is no more", and that is true here.
  //
  // The term's own months, end to end, PLUS a month of its own for any night
  // that falls outside it. The split matters because this query returns two
  // different things: the active season's nights, which have a term to be
  // contiguous across, and every SEASON-LESS night, which is fetched whatever
  // its date. One leftover season-less row used to drag the whole run back to
  // its month — two dozen empty grids between it and today — and the 600-
  // iteration guard in monthKeysBetween stops a hang, not that. calendarMonthKeys
  // keeps the row (it is a real night, and it has a card) and drops only the
  // empty span behind it.
  const calendar = calendarSessions;
  const seasonDates = activeSeason
    ? calendar.filter((s) => s.season_id === activeSeason.id).map((s) => s.date as string)
    : [];
  const looseDates = calendar
    .filter((s) => !activeSeason || s.season_id !== activeSeason.id)
    .map((s) => s.date as string);
  const monthKeys = calendarMonthKeys(
    activeSeason?.start_date
      ? { startISO: activeSeason.start_date as string, endISO: (activeSeason.end_date as string | null) ?? null }
      : null,
    seasonDates,
    looseDates,
    todayISO,
  );

  // Only the open nights have a card in the rail, so only they are worth a
  // jump link. A closed night's cell stays plain text rather than an anchor
  // that scrolls nowhere.
  const openIds = new Set(upcoming.map((s) => s.id as string));
  const calendarEvents: CalendarEvent[] = calendar.map((s) => {
    const state = describeMyState(
      myStatusBySession.get(s.id as string),
      myIntentBySession.get(s.id as string),
    );
    return {
      id: s.id as string,
      date: s.date as string,
      name: (s.name as string | null) ?? 'Practice Session',
      status: s.status as string,
      timeLabel: s.start_time ? formatTime(s.start_time as string) : null,
      mine: state === 'going' || state === 'checked_in' || state === 'attended',
      linkable: openIds.has(s.id as string),
    };
  });
  const calendarMonths = monthKeys.map((key) => buildCalendarMonth(key, calendarEvents, todayISO));

  return (
    <div data-screen-label="Schedule" className="wide-page">
      <DeepLinkScroll />
      {/* "Capacity fills fast" was dropped from the subtitle: sessions have no
          capacity column and no waitlist, so it promised a scarcity the app
          cannot actually show anyone. What survives is the true half — checking
          in is the act that claims your spot. */}
      <PageHeader
        eyebrow="Play"
        title="Schedule"
        sub="Open practices, drop-ins and ladder nights. RSVP so the exec knows who's coming, then check in when you arrive to claim your spot."
        actions={upcomingCount > 0 ? <SubscribeAllButton /> : undefined}
        className="wide-head"
      />

      {/* A suspended member reaches this page from a notification or a saved
          link even though the nav tab is gone, so the reason has to be on the
          screen itself and above the sessions — not tucked under a card title
          they may never scroll to. */}
      <StandingNote
        standing={standing}
        activity="RSVP and check-in"
        className="alert-danger"
        style={{ marginBottom: 20 }}
      />

      {/* THE SHAPE OF THIS SCREEN, and the one rule that decides it.
          -------------------------------------------------------------------
          The month grid is the main column on a laptop and the upcoming cards
          are the rail beside it. But the DOM order is upcoming → calendar →
          everything else, and NOTHING reorders below 1101px. That is
          deliberate and it is the safety property of the whole layout: on a
          phone, a month grid stacked above the action cards would push Check
          In below the fold, which is the single worst outcome this page has.
          Because the source order already is the phone's order, "check-in
          first at 390px" follows from the markup and needs no media query to
          be true — the ≥1101px block in globals.css is the only place any
          placement is stated, and it is the only place that can break it.

          Three grid children, not two: the rail is split so the calendar can
          sit BETWEEN what's next and what's finished on a phone, while on a
          laptop the two halves stack in the same right-hand column. */}
      <div className="sched-wide">
        <aside className="wide-rail sched-rail-primary reveal reveal-1">
          <section>
          <div className="card-head">
            <div>
              <h2 className="card-title">Upcoming</h2>
              <div className="card-sub">
                {upcomingCount === 0
                  ? 'Nothing on the calendar.'
                  : `${upcomingCount} session${upcomingCount === 1 ? '' : 's'} accepting check-ins${myUpcomingCount > 0 ? ` · you're in for ${myUpcomingCount}` : ''}.`}
              </div>
            </div>
            {upcomingCount > 0 && <span className="tag tag-win">{upcomingCount} OPEN</span>}
          </div>

          {upcomingCount === 0 ? (
            <div className="card-base" style={{ padding: 0 }}>
              <div className="empty">
                <div className="empty-icon"><Calendar size={20} /></div>
                {/* An empty schedule has two very different causes and a member
                    cannot tell them apart from a blank card, so each says which
                    one it is. */}
                <div className="empty-title">{activeSeason ? 'No sessions yet' : 'No season is running'}</div>
                <div className="empty-hint">
                  {activeSeason
                    ? `Nothing has been posted for ${activeSeason.name} yet. New practices show up here as soon as the exec adds them — watch announcements.`
                    : 'Sessions appear here once the exec opens a new term. Watch announcements for the start date.'}
                </div>
              </div>
            </div>
          ) : (
            <div>
              {days.map((day) => (
                <div key={day.dateISO} className={`sched-day${day.isToday ? ' is-today' : ''}`}>
                  <div className="sched-day-rail">
                    <div className="sched-day-label">{day.label}</div>
                    {/* The absolute date is always present next to the relative
                        word: "Today" alone is worthless on a page left open
                        overnight, and it is the only date on the card. */}
                    <div className="sched-day-date">{day.dateLabel}</div>
                  </div>
                  <div className="sched-day-list">
                    {day.sessions.map((session) => {
                      const canCheckIn = isCheckinOpen(session, now, checkinSettings);
                      const { opensAt } = getCheckinWindow(session, checkinSettings);
                      let windowLabel: string | undefined;
                      // Only for nights still ahead. A session left 'open' after
                      // its date has passed would otherwise stamp every stale
                      // card with "CHECK-IN CLOSED" — an answer to a question
                      // nobody is asking about last week.
                      if (!canCheckIn && session.date >= todayISO) {
                        if (opensAt && now < opensAt) {
                          // Club-local HH:MM of the opening instant, rendered
                          // like session times.
                          const opensLocal = opensAt.toLocaleTimeString('en-GB', {
                            timeZone: CLUB_TIMEZONE,
                            hourCycle: 'h23',
                            hour: '2-digit',
                            minute: '2-digit',
                          });
                          windowLabel = `Opens at ${formatTime(opensLocal)}`;
                        } else {
                          windowLabel = 'Check-in closed';
                        }
                      }
                      return (
                        <SessionCard
                          key={session.id}
                          session={session}
                          myStatus={myStatusBySession.get(session.id) ?? null}
                          myIntent={myIntentBySession.get(session.id) ?? null}
                          checkedInCount={checkedInBySession[session.id] ?? 0}
                          goingCount={goingBySession[session.id] ?? 0}
                          canCheckIn={canCheckIn}
                          windowLabel={windowLabel}
                          isNext={session.id === nextSessionId}
                          standingOk={standing.ok}
                        />
                      );
                    })}
                  </div>
                </div>
              ))}
            </div>
          )}
          </section>
        </aside>

        {/* THE MONTH ------------------------------------------------- */}
        {/* The shape of the term, which the day-by-day list beside it cannot
            show: a member asking "are we playing the week after reading
            break?" was previously scrolling a flat list to find out.

            "You're in for" used to live in the rail here and has been folded
            away rather than moved. It existed because the rail had nothing in
            it and the schedule was a column away; now the member's own cards
            ARE the rail, and a list of the same nights directly above them
            would be a second copy of the thing it points at. What it actually
            carried survives in two places that cost no space: the count in the
            Upcoming sub-line ("you're in for 3"), and the accent on those
            nights' cells in the grid. */}
        <section className="sched-cal reveal reveal-2" aria-label="Month calendar">
          <MonthCalendar
            months={calendarMonths}
            initialIndex={initialMonthIndex(monthKeys, todayISO)}
            weekdays={CALENDAR_WEEKDAYS}
          />
        </section>

        {/* Hidden outright on a phone when the only thing that would render in
            it is nothing: every card below except Past sessions is
            desktop-only, so with no closed nights this aside would be an
            invisible grid child paying a 20px gap under the calendar. */}
        <aside
          className={`wide-rail sched-rail-more reveal reveal-3${closed.length === 0 ? ' sched-rail-hidden-phone' : ''}`}
        >
          {/* THE CHECK-IN WINDOW -------------------------------------- */}
          {/* The live platform_settings row this page already fetched, not the
              TypeScript fallback — these are the same two numbers
              session_checkin_open() enforces, so the explanation on screen and
              the gate on the server cannot drift apart. This card is why the
              rail is never empty: the rules of the screen are true on a season
              with no sessions in it at all.

              Desktop only. On a phone each session card already prints its own
              "Opens at 6:30 PM", which is the same fact about the night in
              front of you; this is the general statement of it, and it earns
              its place only in a column that would otherwise be black. */}
          <div className="card-base wide-desktop-only">
            <div className="wide-cap">Checking in</div>
            <p className="wide-note">
              {checkinSettings.opensMinutesBefore == null
                ? 'Check-in is open on any session that has not finished yet — there is no opening time set.'
                : `Check-in opens ${checkinSettings.opensMinutesBefore} minutes before a session starts.`}{' '}
              It closes at the end time, or {checkinSettings.defaultDurationMinutes} minutes after
              the start when a night has no end time on it.
            </p>
            <div className="wide-figures">
              <div className="stat">
                <div className="stat-label">Opens</div>
                <div className="stat-value mono" style={{ fontSize: 22 }}>
                  {checkinSettings.opensMinutesBefore == null
                    ? 'Any time'
                    : `${checkinSettings.opensMinutesBefore}m`}
                </div>
              </div>
              <div className="stat">
                <div className="stat-label">Default length</div>
                <div className="stat-value mono" style={{ fontSize: 22 }}>
                  {checkinSettings.defaultDurationMinutes}m
                </div>
              </div>
            </div>
          </div>

          {/* YOUR TURNOUT --------------------------------------------- */}
          {/* Scoped to the closed nights this page fetched, and labelled with
              that number, because `closedSessions` is .limit(10): "2 of the
              last 6" is exactly true, "6 sessions this season" would be a
              capped figure dressed up as a total. Withheld entirely before the
              first night closes rather than shown as a zero.

              NOT a streak. The feed prints one, from a different set of
              sessions: it counts every past-dated night this member was
              eligible for, closed or not, and closing a session is a manual
              admin action with no cron behind it. So a night the exec forgot
              to close is in the feed's run and cannot be in this one, and two
              screens would confidently print two different numbers for the
              same word. The feed owns "streak"; this card owns the window it
              names. */}
          {closed.length > 0 && (
            <div className="card-base wide-desktop-only">
              <div className="wide-cap">Your turnout</div>
              <div className="wide-figures">
                <div className="stat">
                  <div className="stat-label">
                    Of the last {closed.length} closed {closed.length === 1 ? 'night' : 'nights'}
                  </div>
                  <div className="stat-value mono" style={{ fontSize: 22 }}>
                    {attendedRecently}
                  </div>
                </div>
              </div>
              {attendedRecently === 0 && (
                <p className="wide-note">
                  You have not been marked in at any of them. Check in on the night and it
                  counts here.
                </p>
              )}
            </div>
          )}

          {/* PAST SESSIONS -------------------------------------------- */}
          {closed.length > 0 && (
          <section className="card-base">
            <div className="card-head">
              <div>
                <h2 className="card-title">Past sessions</h2>
                <div className="card-sub">The last {closed.length} nights that have closed.</div>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {closed.map((session) => {
                const outcome = PAST_STATE_LABEL[describeMyState(myStatusBySession.get(session.id), null)];
                const attended = checkedInBySession[session.id] ?? 0;
                return (
                  <div key={session.id} className="list-row">
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <div className="row-title">{session.name ?? 'Practice Session'}</div>
                      <div className="row-sub">
                        {formatDate(session.date).toUpperCase()} · {session.location}
                        {attended > 0 && ` · ${attended} ATTENDED`}
                      </div>
                    </div>
                    {/* Whether the member was there is the only thing worth
                        saying about a night already over; "CLOSED" on every row
                        said nothing they could not see from the heading. */}
                    {outcome ? <span className={outcome.tone}>{outcome.text}</span> : <span className="tag">CLOSED</span>}
                  </div>
                );
              })}
            </div>
          </section>
          )}
        </aside>
      </div>
    </div>
  );
}
