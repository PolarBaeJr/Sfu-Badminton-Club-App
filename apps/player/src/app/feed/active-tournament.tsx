import Link from 'next/link';
import { TOURNAMENT_EVENT_TYPE_LABELS } from '@badminton/shared';
import { dayLabel } from '@/lib/feed-activity';
import { underWayEyebrow, type FeedEvent } from '@/lib/feed-tournament';

/**
 * THE TOURNAMENT IS ON, SAID ON THE SCREEN THE MEMBER ALREADY OPENED.
 *
 * =====================================================================
 * WHY THIS IS A BANNER AND NOT A RIVER ITEM OR A RAIL CARD
 * =====================================================================
 * NOT A RIVER ITEM. `RiverItem` is a discriminated union over `{ at: string }`
 * and every consumer of it goes through groupByDay(), which buckets by the club
 * day of `at` and sorts newest-first. A tournament is not a thing that happened
 * at an instant — it is a STATE that is true for a day or three — so there is no
 * honest value for `at`. Whatever was invented for it would then decide where
 * the row landed: `created_at` would file "the tournament is on" under the
 * Tuesday an exec drafted it, and `now` would make it jitter to the top of TODAY
 * on every re-render while still sitting BELOW the day heading, under whatever
 * matches had been played since. A state does not belong in a log of events.
 *
 * NOT A RAIL CARD, and this is the one that would have quietly wasted the whole
 * feature. `.wide-grid` is a single column below 1101px (globals.css), so on a
 * phone `.wide-rail` unstacks UNDERNEATH `.feed-col` — beneath up to fifteen
 * river rows and their day headings. A member standing in the gym would have had
 * to scroll past the entire club's recent results to find out that the
 * tournament they are standing in is running. That is the "navigate to
 * Tournaments and find it" problem with extra steps.
 *
 * SO: the first child of `.feed-col`. On a phone that is immediately under the
 * header (and under PasskeyNudge / the standing notice when those render), above
 * the river. On a laptop it is the top of the left column, so it does not become
 * a slab spanning both columns the way a child of `.wide-page` would.
 *
 * =====================================================================
 * WHAT IS DELIBERATELY *NOT* ON THIS CARD
 * =====================================================================
 * No opponent, no court, no YOU'RE READY toggle. All three live in "Your
 * Matches" at the top of the event page, and this card links there rather than
 * reprinting them. Three reasons, in ascending order of how much they matter:
 *
 *   1. A COURT IS AN INSTRUCTION WITH A CONTROL ATTACHED. On the event page the
 *      court number and the ready toggle sit in one block, because the pair of
 *      them is a conversation with the desk: here is where you go, tell us you
 *      are there. Printing the court here and leaving the toggle two taps away
 *      splits the instruction from the reply — a member reads "Court 3", walks
 *      off, and the desk never hears from them.
 *
 *   2. IT WOULD PUT A MATCH-LEVEL SOCKET ON THE BUSIEST SCREEN IN THE APP. The
 *      card prints nothing derived from `tournament_matches`, so it does not
 *      need to hear about matches — and it must not, because subscribing /feed
 *      to that table would wake a re-render of the landing page on every score
 *      the club enters, to redraw a card whose content had not changed.
 *      Everything this card DOES show moves on `tournament_events` (an event
 *      going live, or completing) or on the entry tables (a check-in), and those
 *      are exactly what LiveTournament subscribes to without `draw`.
 *
 *   3. `ready_player_ids` DOES NOT EXIST ON PRODUCTION. Verified 2026-08-17
 *      against the prod database: `tournament_matches` has 37 columns, `court`
 *      is one of them (it dates from 00001) and `ready_player_ids` is not —
 *      00135 has been written but not applied. PostgREST fails the WHOLE request
 *      on one unknown column, so a feed that named it would take the app's
 *      landing surface down for every member the moment it deployed. The event
 *      page can name it because 00135 tells the owner to apply it before
 *      deploying and that page is not the front door.
 */

/** One running event of a running tournament, with the viewer's own standing in
 *  it already resolved on the server. */
export type ActiveEntry = {
  eventId: string;
  eventType: FeedEvent['event_type'];
  status: string;
  /** null when the viewer is not in this event at all. */
  mine: null | { checkedIn: boolean };
};

export type ActiveTournamentCardProps = {
  tournamentId: string;
  name: string;
  startDate: string;
  todayKey: string;
  events: ActiveEntry[];
  /** Distinct PEOPLE entered across the running events, via countEnteredPlayers. */
  entered: number;
};

export function ActiveTournamentCard({
  tournamentId,
  name,
  startDate,
  todayKey,
  events,
  entered,
}: ActiveTournamentCardProps) {
  const mine = events.filter((e) => e.mine !== null);
  const eyebrow = underWayEyebrow(events.map((e) => ({ id: e.eventId, event_type: e.eventType, status: e.status })));

  return (
    // NO NEW CSS AND NO TAILWIND UTILITIES. Built from the classes this page
    // already uses (.card-base, .wide-cap, .wide-note, .mono, .muted, .btn,
    // .press) plus inline styles, exactly as the next-session card beside it is.
    // Three sibling agents are working in this tree and globals.css is the one
    // file all of them could plausibly touch, so adding a rule to it would be
    // volunteering for a conflict over a card that needs no new rule.
    //
    // It also sidesteps the radius trap outright: this design system zeroes the
    // whole scale (--r-lg: 0, and tailwind.config.ts flattens borderRadius to
    // '0'), so `rounded-xl` compiles to nothing AND a literal `rounded-[8px]`
    // would be the only rounded corner on the screen. .card-base already carries
    // `border-radius: var(--r-lg)`, which is the house answer.
    //
    // The gold left border is the same device .ptourn-open uses with --red and
    // the standing notice above uses with --gold: one hairline that says "this
    // is the live thing" without spending a second coloured button. --gold
    // rather than --red because /tournaments already owns red for "you can enter
    // this", and this card is the opposite half of the lifecycle.
    <div className="card-base" style={{ borderLeft: '3px solid var(--gold)' }}>
      <div className="wide-cap" style={{ color: 'var(--gold)' }}>
        {eyebrow}
      </div>

      <h2
        style={{
          fontFamily: 'var(--display)',
          fontSize: 26,
          fontWeight: 700,
          letterSpacing: '-.02em',
          lineHeight: 1.05,
          margin: '8px 0 6px',
          // `min-width: 0` on the flex child is necessary and not sufficient: it
          // lets the CARD shrink, and does nothing about a single unbreakable
          // token INSIDE it. A tournament name is exec-typed free text at 26px in
          // the display face, so one long word is all it would take to push the
          // document sideways on a 390px screen. This is the rule that actually
          // prevents that.
          overflowWrap: 'anywhere',
        }}
      >
        {name}
      </h2>

      <div
        className="mono muted"
        style={{ fontSize: 12, textTransform: 'uppercase', letterSpacing: '.06em' }}
      >
        {/* dayLabel gives "TODAY" on the day, which is the whole point of the
            card, and a dated weekday on a multi-day tournament's later days.

            THE COUNT DROPS OUT AT ZERO rather than printing "0 PLAYERS". It is
            reachable — an event left at `live` whose entrants all withdrew, and
            occupiesAPlace correctly excludes every one of them — and "UNDER WAY
            / 0 PLAYERS" reads as a broken card, which is the exact impression
            the not-entered branch below is built to avoid. A card that says only
            the day is still true. */}
        {[
          dayLabel(startDate.slice(0, 10), todayKey),
          entered > 0 ? `${entered} ${entered === 1 ? 'PLAYER' : 'PLAYERS'}` : null,
        ]
          .filter(Boolean)
          .join(' · ')}
      </div>

      {mine.length > 0 ? (
        /* ENTERED. One row per running event the member is in — because a
           member can be in the men's singles AND the mixed doubles of the same
           tournament, and they are two different draws in two different corners
           of the gym. Each row goes straight to that event's own page, which is
           where the court, the opponent and the ready toggle are. */
        <div style={{ marginTop: 14 }}>
          {mine.map((e) => (
            <Link
              key={e.eventId}
              href={`/tournaments/${tournamentId}/events/${e.eventId}`}
              className="press"
              style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                // 44px is the floor for a thumb, and these rows are the card's
                // only tap targets. 12px of padding either side of a 14px line
                // clears it; the explicit minHeight is what keeps it true if the
                // label ever wraps to nothing.
                minHeight: 44,
                padding: '10px 0',
                borderTop: '1px solid var(--line)',
              }}
            >
              <span style={{ fontSize: 14, fontWeight: 600, lineHeight: 1.3, minWidth: 0 }}>
                {TOURNAMENT_EVENT_TYPE_LABELS[e.eventType]}
              </span>
              {/* THE ONE PERSONAL FACT WORTH A LANDING SURFACE. It is not on the
                  event page's "Your Matches" block at all (that block is about
                  matches; check-in is a chip up in the event header), and it is
                  the thing a member standing in the doorway actually needs to
                  know: has the desk got me yet.

                  Stated, never offered as a button. Self check-in exists but
                  EventActions gates it on `!isDoubles && regStatus ===
                  'registered' && eventStatus === 'checkin' && !suspended &&
                  standing.ok` — five conditions, one of which rules out every
                  doubles entrant, because check-in for a pair is the desk's job.
                  A "Check in" button here would be a dead end for half the
                  club's events. The event page it links to already owns that
                  gate and states each refusal; a second copy is how the two
                  drift apart. */}
              <span
                className="mono"
                style={{
                  fontSize: 11,
                  letterSpacing: '.06em',
                  textTransform: 'uppercase',
                  whiteSpace: 'nowrap',
                  color: e.mine!.checkedIn ? 'var(--win)' : 'var(--mute)',
                }}
              >
                {e.mine!.checkedIn ? 'Checked in' : 'Not checked in'}
              </span>
            </Link>
          ))}
        </div>
      ) : (
        /* NOT ENTERED — and this branch is why the card is worth having at all
           for most of the club. A tournament running in the members' own gym is
           news whether or not they are in it, so the card still appears; what it
           must not do is look like the entered state with the personal part
           broken. So: no empty rows, no "—" where a status would go, no
           disabled button. One sentence that is true, and one link that goes
           somewhere useful.

           The link is the TOURNAMENT page, not an event page: this member has no
           event of their own to be sent to, and /tournaments/[id] is the route
           that lists every event with its draw. It exists and takes a plain id
           (apps/player/src/app/tournaments/[id]/page.tsx). */
        <>
          <p className="wide-note">
            {events.length === 1
              ? `The ${TOURNAMENT_EVENT_TYPE_LABELS[events[0]!.eventType]} is on now. You are not entered — the draw is open to watch.`
              : `${events.length} events are on now. You are not entered — the draws are open to watch.`}
          </p>
          <Link
            href={`/tournaments/${tournamentId}`}
            className="btn btn-ghost press"
            style={{ marginTop: 12, minHeight: 44 }}
          >
            Follow the draw
          </Link>
        </>
      )}
    </div>
  );
}
