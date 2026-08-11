// Derivations behind the /tournaments index screen.
//
// Lives in apps/player rather than packages/shared for the same reason
// feed-activity.ts does: these are the shapes this one screen needs, and the
// brief for it forbids touching the shared packages.
//
// Everything here is pure and takes `now`/`todayKey` as an argument rather
// than reading the clock, so "open" and "upcoming" can be tested rather than
// hoped for.

import { isDoublesEvent, type TournamentEventType } from '@badminton/shared';

export type IndexEvent = {
  id: string;
  event_type: TournamentEventType;
  status: string;
  max_participants: number | null;
};

export type IndexTournament = {
  id: string;
  name: string;
  start_date: string;
  status: string;
  suspended_at: string | null;
  tournament_events: IndexEvent[];
};

/** An event a member could actually enter right now.
 *
 *  `registration` is the only status registerForEventImpl accepts (see
 *  tournament-actions.ts:81) — every other status makes the button a lie. */
export function isOpenForEntry(event: IndexEvent): boolean {
  return event.status === 'registration';
}

/**
 * The one tournament the screen leads with.
 *
 * "Open" means it has at least one event taking entries and is not suspended —
 * a suspended tournament refuses registration server-side (tournament-actions.ts:66),
 * so leading with it would be an invitation to a refusal.
 *
 * Earliest start date wins: of two open tournaments the nearer one is the one
 * with a deadline in practice, even though no deadline is stored.
 */
export function pickHeroTournament(tournaments: IndexTournament[]): IndexTournament | null {
  const open = tournaments.filter(
    (t) => !t.suspended_at && (t.tournament_events ?? []).some(isOpenForEntry),
  );
  if (open.length === 0) return null;
  return [...open].sort((a, b) => a.start_date.localeCompare(b.start_date))[0] ?? null;
}

/**
 * "SINGLES + DOUBLES" — the disciplines this tournament runs.
 *
 * Deliberately coarser than TOURNAMENT_EVENT_TYPE_LABELS: the index answers
 * "is there something here for me", and "Men's Singles + Open Singles +
 * Mixed Doubles" is a sentence, not a glance. The detail page names each event.
 */
export function describeDisciplines(events: IndexEvent[]): string {
  const hasSingles = events.some((e) => !isDoublesEvent(e.event_type));
  const hasDoubles = events.some((e) => isDoublesEvent(e.event_type));
  if (hasSingles && hasDoubles) return 'SINGLES + DOUBLES';
  if (hasDoubles) return 'DOUBLES';
  if (hasSingles) return 'SINGLES';
  return 'NO EVENTS YET';
}

/** The statuses that still count as somebody occupying a place in the draw.
 *  Mirrors the capacity check the server actually enforces
 *  (tournament-actions.ts:98) — a card that says "6 spots" while the action
 *  says "Event is full" is a support ticket. */
export function occupiesAPlace(status: string): boolean {
  return status !== 'withdrawn' && status !== 'disqualified';
}

/**
 * How many PEOPLE are entered across a tournament, counted distinctly.
 *
 * Not "rows": a tournament with a singles and a doubles event holds one row per
 * player in one table and one row per PAIR in the other, so adding the two
 * counts together would mix units and undercount doubles by half. Someone
 * entered in both events is one person, so the set is keyed by player id.
 */
export function countEnteredPlayers(
  participants: Array<{ player_id: string; status: string }>,
  pairs: Array<{ player1_id: string; player2_id: string; status: string }>,
): number {
  const players = new Set<string>();
  for (const p of participants) {
    if (occupiesAPlace(p.status)) players.add(p.player_id);
  }
  for (const p of pairs) {
    if (occupiesAPlace(p.status)) {
      players.add(p.player1_id);
      players.add(p.player2_id);
    }
  }
  return players.size;
}

/**
 * Places left — or null when the number would be a guess.
 *
 * `max_participants` is per EVENT, not per tournament, so a tournament running
 * a 16-cap singles event beside an 8-cap doubles event has no single well-defined
 * "spots left" figure. Three things must therefore all hold before a number is
 * shown, and otherwise the screen shows a bare entered count and no denominator:
 *
 *   1. exactly one event is taking entries, so "the cap" is unambiguous;
 *   2. that event is singles — doubles has no member entry path at all
 *      (EventRegistrationButton renders "Doubles — admin managed"), so spots
 *      a member cannot take are not spots;
 *   3. the event actually carries a cap. max_participants is nullable and
 *      uncapped events are normal.
 */
export function spotsLeft(
  events: IndexEvent[],
  participants: Array<{ event_id: string; status: string }>,
): number | null {
  const open = events.filter(isOpenForEntry);
  if (open.length !== 1) return null;
  const event = open[0]!;
  if (isDoublesEvent(event.event_type)) return null;
  if (!event.max_participants) return null;
  const taken = participants.filter(
    (p) => p.event_id === event.id && occupiesAPlace(p.status),
  ).length;
  return Math.max(0, event.max_participants - taken);
}

/** The single singles event a member can enter, when there is exactly one.
 *  Used to decide whether the hero card may promise entry at all. */
export function soleEnterableEvent(events: IndexEvent[]): IndexEvent | null {
  const enterable = events.filter((e) => isOpenForEntry(e) && !isDoublesEvent(e.event_type));
  return enterable.length === 1 ? enterable[0]! : null;
}

/**
 * "1st" / "2nd" / "3rd" / "5th" — an English ordinal.
 *
 * The stored figure is a genuine finishing position, not a round name: finalize.ts
 * writes 1 to the champion, 2 to the beaten finalist, then 2^n+1 to everyone
 * knocked out n rounds from the final — so quarter-final losers all share 5th and
 * round-of-16 losers all share 9th. Round robin writes a plain 1..n.
 *
 * Rendering the number is therefore the only honest option. Mapping 5 back to
 * "QF" would be right for a bracket and wrong for a round robin, where 5th means
 * literally fifth of the pool, and nothing on the row says which format it was.
 */
export function ordinalPlacing(position: number): string {
  const mod100 = position % 100;
  if (mod100 >= 11 && mod100 <= 13) return `${position}th`;
  switch (position % 10) {
    case 1: return `${position}st`;
    case 2: return `${position}nd`;
    case 3: return `${position}rd`;
    default: return `${position}th`;
  }
}

/** A podium finish is worth colouring; 7th is not. --gold is the only medal
 *  token in the system, so it marks the top three and everything else stays
 *  muted rather than inventing silver and bronze. */
export function isPodium(position: number): boolean {
  return position <= 3;
}

/** "NOV 2025" — the month a result belongs to, from a YYYY-MM-DD key.
 *  Anchored at noon UTC so a timezone offset can never roll it into the
 *  neighbouring month, the same guard shiftDayKey uses. */
export function resultMonth(dateKey: string): string {
  const [y, m, d] = dateKey.slice(0, 10).split('-').map(Number);
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC',
    month: 'short',
    year: 'numeric',
  })
    .format(new Date(Date.UTC(y ?? 1970, (m ?? 1) - 1, d ?? 1, 12)))
    .toUpperCase();
}

/**
 * Is this tournament still to come, in CLUB time?
 *
 * A string compare, not a Date compare. `tournaments.start_date` is a Postgres
 * DATE and arrives as "YYYY-MM-DD", which is the same shape clubDayKey returns,
 * and both sort correctly as plain strings.
 *
 * The screen this replaced used `new Date(t.start_date).getTime() > now`, which
 * parses that DATE as UTC midnight and compares it to an instant — so from
 * ~16:00 Vancouver a tournament starting today had already "started", and from
 * ~16:00 on the day before, tomorrow's tournament read as today's.
 */
export function isUpcoming(startDate: string, todayKey: string): boolean {
  return startDate.slice(0, 10) >= todayKey;
}
