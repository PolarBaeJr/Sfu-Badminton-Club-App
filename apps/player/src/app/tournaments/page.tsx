import Link from 'next/link';
import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import {
  CLUB_TIMEZONE,
  isDoublesEvent,
  scopeToActiveSeason,
  TOURNAMENT_EVENT_TYPE_LABELS,
  type TournamentEventType,
} from '@badminton/shared';
import { AvatarChip, Badge } from '@badminton/ui';
import { clubDayKey, dayLabel } from '@/lib/feed-activity';
import {
  countEnteredPlayers,
  describeDisciplines,
  isPodium,
  isUpcoming,
  ordinalPlacing,
  pickHeroTournament,
  resultMonth,
  soleEnterableEvent,
  spotsLeft,
  occupiesAPlace,
  type IndexEvent,
  type IndexTournament,
} from '@/lib/tournament-index';

// The rows this screen actually reads, spelled out so a schema change breaks the
// build here rather than rendering an undefined into the page.
type EntryRow = {
  event_id: string;
  player_id: string;
  status: string;
};
type PairRow = {
  event_id: string;
  player1_id: string;
  player2_id: string;
  status: string;
};
type NestedEvent = {
  id: string;
  event_type: TournamentEventType;
  status: string;
  tournament: { id: string; name: string; start_date: string } | null;
};
type MyEntry = {
  id: string;
  seed_number: number | null;
  status: string;
  final_position: number | null;
  elo_change: number | null;
  event: NestedEvent | null;
  partner: { id: string; full_name: string; avatar_url: string | null } | null;
  isDoubles: boolean;
};

// Supabase returns a to-one embed as object-or-array depending on how it infers
// the relationship. Every read below goes through this rather than trusting one
// shape — the same defensive unwrap tournament-actions.ts uses.
function one<T>(embed: unknown): T | null {
  return ((Array.isArray(embed) ? embed[0] : embed) ?? null) as T | null;
}

export default async function TournamentsPage() {
  const supabase = await createServerSupabaseClient();
  const player = await getCurrentPlayer();
  const todayKey = clubDayKey(new Date().toISOString(), CLUB_TIMEZONE);

  // Members see the season they are playing in. Same rule as the sessions list.
  const { data: activeSeason } = await supabase
    .from('seasons').select('id').eq('active_flag', true).maybeSingle();

  // The club's tournaments, and — separately — everything the member is in.
  // The member's own history is deliberately NOT season-scoped: it is their
  // record, and a new season would otherwise wipe the results panel on day one.
  const [tournamentsRes, myEntriesRes, myPairsRes] = await Promise.all([
    scopeToActiveSeason(
      supabase
        .from('tournaments')
        .select(
          'id, name, start_date, status, suspended_at, ' +
          'tournament_events(id, event_type, status, max_participants), ' +
          'tournament_fee_tiers(amount_cents, is_default, sort_order)',
        ),
      activeSeason?.id,
    ).order('start_date', { ascending: true }),
    player
      ? supabase
          .from('tournament_participants')
          .select(
            'id, seed_number, status, final_position, elo_change, ' +
            'event:tournament_events(id, event_type, status, tournament:tournaments(id, name, start_date))',
          )
          .eq('player_id', player.id)
      : Promise.resolve({ data: [] as unknown[] }),
    player
      ? supabase
          .from('tournament_pairs')
          .select(
            'id, seed_number, status, final_position, player1_id, player2_id, ' +
            'player1:players!tournament_pairs_player1_id_fkey(id, full_name, avatar_url), ' +
            'player2:players!tournament_pairs_player2_id_fkey(id, full_name, avatar_url), ' +
            'event:tournament_events(id, event_type, status, tournament:tournaments(id, name, start_date))',
          )
          .or(`player1_id.eq.${player.id},player2_id.eq.${player.id}`)
      : Promise.resolve({ data: [] as unknown[] }),
  ]);

  const tournaments = ((tournamentsRes.data ?? []) as unknown as IndexTournament[]).map((t) => ({
    ...t,
    tournament_events: t.tournament_events ?? [],
  }));

  // Fold singles rows and pair rows into one shape, because from the member's
  // point of view "an entry" is an entry — the table it lives in is an
  // implementation detail of the format.
  const myEntries: MyEntry[] = [
    ...((myEntriesRes.data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => ({
      id: r.id as string,
      seed_number: (r.seed_number ?? null) as number | null,
      status: r.status as string,
      final_position: (r.final_position ?? null) as number | null,
      elo_change: (r.elo_change ?? null) as number | null,
      event: one<NestedEvent>(r.event),
      partner: null,
      isDoubles: false,
    })),
    ...((myPairsRes.data ?? []) as unknown as Array<Record<string, unknown>>).map((r) => {
      const p1 = one<{ id: string; full_name: string; avatar_url: string | null }>(r.player1);
      const p2 = one<{ id: string; full_name: string; avatar_url: string | null }>(r.player2);
      // Whichever half of the pair is not the viewer. Compared on the id column
      // rather than the embed so a partner whose row failed to embed still
      // resolves to "the other one" instead of silently becoming the viewer.
      const partner = r.player1_id === player?.id ? p2 : p1;
      return {
        id: r.id as string,
        seed_number: (r.seed_number ?? null) as number | null,
        status: r.status as string,
        final_position: (r.final_position ?? null) as number | null,
        // tournament_pairs has no elo_change column — the ladder moves per
        // PLAYER and the pair is not one. A doubles result therefore shows no
        // swing rather than a made-up one. See the note by PAST RESULTS.
        elo_change: null,
        event: one<NestedEvent>(r.event),
        partner,
        isDoubles: true,
      };
    }),
  ].filter((e) => e.event !== null);

  const hero = pickHeroTournament(tournaments);

  // A finished entry is one the bracket has placed. Everything else that is not
  // withdrawn is still live for the member, which is what "you are in" means.
  const liveEntries = myEntries
    .filter((e) => e.final_position === null && occupiesAPlace(e.status))
    .sort((a, b) => (a.event?.tournament?.start_date ?? '').localeCompare(b.event?.tournament?.start_date ?? ''));
  const pastEntries = myEntries
    .filter((e) => e.final_position !== null)
    .sort((a, b) => (b.event?.tournament?.start_date ?? '').localeCompare(a.event?.tournament?.start_date ?? ''));

  // One round trip for every headcount the screen needs: the hero's field, and
  // the field size beside each past result. Counting rows here rather than with
  // an embedded aggregate is what lets withdrawn entries be excluded — the same
  // filter the server's own capacity check applies.
  const countedEventIds = [
    ...(hero?.tournament_events ?? []).map((e) => e.id),
    ...pastEntries.map((e) => e.event!.id),
  ].filter((v, i, a) => a.indexOf(v) === i);

  let entryRows: EntryRow[] = [];
  let pairRows: PairRow[] = [];
  if (countedEventIds.length > 0) {
    const [pRes, prRes] = await Promise.all([
      supabase.from('tournament_participants').select('event_id, player_id, status').in('event_id', countedEventIds),
      supabase.from('tournament_pairs').select('event_id, player1_id, player2_id, status').in('event_id', countedEventIds),
    ]);
    entryRows = (pRes.data ?? []) as unknown as EntryRow[];
    pairRows = (prRes.data ?? []) as unknown as PairRow[];
  }

  const fieldSize = (eventId: string) =>
    entryRows.filter((r) => r.event_id === eventId && occupiesAPlace(r.status)).length +
    pairRows.filter((r) => r.event_id === eventId && occupiesAPlace(r.status)).length;

  // ── The hero card's figures ──────────────────────────────────────────────
  const heroEvents: IndexEvent[] = hero?.tournament_events ?? [];
  const heroEventIds = heroEvents.map((e) => e.id);
  const heroEntered = countEnteredPlayers(
    entryRows.filter((r) => heroEventIds.includes(r.event_id)),
    pairRows.filter((r) => heroEventIds.includes(r.event_id)),
  );
  const heroSpots = spotsLeft(heroEvents, entryRows.filter((r) => heroEventIds.includes(r.event_id)));
  const heroEnterable = soleEnterableEvent(heroEvents);

  // The entry fee, from the tournament's own tiers. The default tier is the one
  // a member pays; failing an explicit default, the lowest — never a guess.
  const heroTiers = (
    (hero as unknown as { tournament_fee_tiers?: Array<{ amount_cents: number; is_default: boolean; sort_order: number }> } | null)
      ?.tournament_fee_tiers ?? []
  );
  const heroFeeCents =
    heroTiers.find((t) => t.is_default)?.amount_cents ??
    [...heroTiers].sort((a, b) => a.amount_cents - b.amount_cents)[0]?.amount_cents ??
    null;
  const heroFee = heroFeeCents === null ? null : `$${(heroFeeCents / 100).toFixed(2).replace(/\.00$/, '')}`;
  const heroIAmIn = hero ? liveEntries.some((e) => e.event?.tournament?.id === hero.id) : false;

  // Everything in the season that is not the hero, so publishing a second
  // tournament cannot make it invisible.
  const otherTournaments = tournaments.filter((t) => t.id !== hero?.id);
  const otherUpcoming = otherTournaments.filter((t) => isUpcoming(t.start_date, todayKey));
  const otherDone = otherTournaments
    .filter((t) => !isUpcoming(t.start_date, todayKey))
    .sort((a, b) => b.start_date.localeCompare(a.start_date));

  return (
    <div data-screen-label="Tournaments" className="wide-page">
      <header className="wide-head ptourn-head">
        <Link href="/feed" className="ptourn-back">← Feed</Link>
        <h1 className="ptourn-title">
          Tournaments<span className="ptourn-stop">.</span>
        </h1>
        <p className="ptourn-sub">Club events and the entries you are in.</p>
      </header>

      {/* The river carries what is happening and what the member is in; the rail
          carries their record and the rest of the calendar. Below 1101px
          .wide-grid is a single column and the rail unstacks underneath, which
          is the phone order the screen was designed in: what is open, what you
          are in, what you have done. */}
      <div className="wide-grid">
        <div className="ptourn-river">
          {/* ── THE OPEN EVENT ─────────────────────────────────────────── */}
          {hero ? (
            <section className="ptourn-open">
              <div className="ptourn-open-top">
                {/* The mockup's "ENTRIES CLOSE FRIDAY" is not built: there is no
                    entry-deadline column anywhere in the schema. What is real is
                    the event status, which is the thing that actually decides
                    whether the server will accept an entry. */}
                <span className="ptourn-eyebrow">Entries open</span>
                {heroSpots !== null && (
                  <Badge variant={heroSpots <= 6 ? 'warning' : 'neutral'}>
                    {heroSpots === 0 ? 'Full' : `${heroSpots} ${heroSpots === 1 ? 'spot' : 'spots'}`}
                  </Badge>
                )}
              </div>

              <h2 className="ptourn-open-name">{hero.name}</h2>

              {/* "EAST GYM" in the mockup is dropped — `tournaments` has no
                  location column; only `sessions` carries one. */}
              <p className="ptourn-open-meta">
                {dayLabel(hero.start_date, todayKey)} · {describeDisciplines(heroEvents)}
              </p>

              <div className="ptourn-cells">
                <div className="ptourn-cell">
                  <div className="ptourn-cell-label">Entry</div>
                  <div className="ptourn-cell-value mono">{heroFee ?? '—'}</div>
                </div>
                <div className="ptourn-cell">
                  <div className="ptourn-cell-label">Entered</div>
                  <div className="ptourn-cell-value mono">{heroEntered}</div>
                </div>
                <div className="ptourn-cell">
                  <div className="ptourn-cell-label">Events</div>
                  <div className="ptourn-cell-value mono">{heroEvents.length}</div>
                </div>
              </div>

              {/* The mockup's third cell is "YOUR SEED", which cannot be shown
                  here: seed_number is written when the draw is generated, and an
                  event taking entries has no draw — the cell would read "—" for
                  every member on every open event forever. The seed is shown in
                  YOU ARE IN instead, which is where it exists.

                  The button navigates rather than entering inline. registerForEvent
                  refuses on five separate grounds (suspension, membership, waiver,
                  status, capacity) and EventRegistrationButton already states each
                  one on the detail page; a second copy of that gate here is how the
                  two drift apart. It is also the only honest label when the
                  tournament runs several events — you pick one there. */}
              <Link href={`/tournaments/${hero.id}`} className="btn btn-primary ptourn-cta press">
                {heroIAmIn
                  ? 'View your entry'
                  : heroEnterable
                    ? `Enter ${TOURNAMENT_EVENT_TYPE_LABELS[heroEnterable.event_type]}${heroFee ? ` · ${heroFee}` : ''}`
                    : 'See events and enter'}
              </Link>
            </section>
          ) : (
            <section className="ptourn-open ptourn-open-empty">
              <span className="ptourn-eyebrow">Nothing open</span>
              <h2 className="ptourn-open-name">No entries being taken</h2>
              <p className="ptourn-open-meta">
                {tournaments.length > 0
                  ? 'Every event this season has closed its entries.'
                  : 'No tournaments have been scheduled this season yet.'}
              </p>
              <p className="wide-note">
                When the exec opens a draw it appears here, and you can enter from
                the tournament&apos;s own page.
              </p>
            </section>
          )}

          {/* ── YOU ARE IN ─────────────────────────────────────────────── */}
          <section className="ptourn-sec">
            <div className="ptourn-sec-label">You are in</div>
            {liveEntries.length === 0 ? (
              <p className="wide-note ptourn-empty">
                You are not entered in anything right now. Entering a draw puts it
                here with your seed and your next opponent.
              </p>
            ) : (
              liveEntries.map((entry) => (
                <EntryBlock key={`${entry.isDoubles ? 'pair' : 'solo'}-${entry.id}`} entry={entry} todayKey={todayKey} />
              ))
            )}
          </section>
        </div>

        <aside className="wide-rail">
          {/* ── PAST RESULTS ───────────────────────────────────────────── */}
          <section className="card-base">
            <div className="wide-cap">Past results</div>
            {pastEntries.length === 0 ? (
              <p className="wide-note">
                Nothing finished yet. A placing appears here once the event you
                played is finalised.
              </p>
            ) : (
              <div className="ptourn-results">
                {pastEntries.map((entry) => {
                  const position = entry.final_position!;
                  const field = fieldSize(entry.event!.id);
                  return (
                    <Link
                      key={`${entry.isDoubles ? 'pair' : 'solo'}-${entry.id}`}
                      href={`/tournaments/${entry.event!.tournament!.id}`}
                      className="ptourn-result press"
                    >
                      <div
                        className="ptourn-place mono"
                        style={{ color: isPodium(position) ? 'var(--gold)' : 'var(--mute)' }}
                      >
                        {ordinalPlacing(position)}
                      </div>
                      <div className="ptourn-result-body">
                        <div className="ptourn-result-name">{entry.event!.tournament!.name}</div>
                        <div className="ptourn-result-sub mono">
                          {[
                            resultMonth(entry.event!.tournament!.start_date),
                            entry.isDoubles ? 'DOUBLES' : 'SINGLES',
                            field > 0 ? `${field} ${entry.isDoubles ? 'PAIRS' : 'ENTRIES'}` : null,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                        </div>
                      </div>
                      {/* Only singles carries a swing: elo_change lives on
                          tournament_participants and there is no equivalent on
                          tournament_pairs, so a doubles row shows nothing rather
                          than a number that is not the member's. */}
                      {entry.elo_change !== null && entry.elo_change !== 0 && (
                        <div
                          className="ptourn-swing mono"
                          style={{ color: entry.elo_change > 0 ? 'var(--win)' : 'var(--loss)' }}
                        >
                          {entry.elo_change > 0 ? '+' : ''}{entry.elo_change}
                        </div>
                      )}
                    </Link>
                  );
                })}
              </div>
            )}
          </section>

          {/* ── THE REST OF THE CALENDAR ───────────────────────────────── */}
          <section className="card-base">
            <div className="wide-cap">Also this season</div>
            {otherUpcoming.length === 0 && otherDone.length === 0 ? (
              <p className="wide-note">
                {hero
                  ? 'Nothing else on the calendar this season.'
                  : 'The season’s tournaments will be listed here once they are scheduled.'}
              </p>
            ) : (
              <div className="ptourn-also">
                {[...otherUpcoming, ...otherDone].map((t) => (
                  <Link key={t.id} href={`/tournaments/${t.id}`} className="wide-item press">
                    <div className="wide-item-title">{t.name}</div>
                    <div className="wide-item-sub">
                      {dayLabel(t.start_date, todayKey)} · {describeDisciplines(t.tournament_events)}
                      {isUpcoming(t.start_date, todayKey) ? '' : ' · DONE'}
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </section>
        </aside>
      </div>

      {/* True, and worth saying: apply_tournament_match_rating (00082/00083)
          moves the same singles and doubles ladders every other rated match
          moves, and finalize.ts adds a placement bonus on top. */}
      <p className="ptourn-note">Tournament results count toward your rating</p>
    </div>
  );
}

/** One live entry: what it is, where the member is seeded, and who they are
 *  playing it with. */
function EntryBlock({ entry, todayKey }: { entry: MyEntry; todayKey: string }) {
  const event = entry.event!;
  const tournament = event.tournament;
  const doubles = isDoublesEvent(event.event_type);

  return (
    <Link href={`/tournaments/${tournament?.id ?? ''}/events/${event.id}`} className="ptourn-entry press">
      <div className="ptourn-entry-top">
        <div className="ptourn-entry-head">
          <div className="ptourn-entry-name">{tournament?.name ?? 'Tournament'}</div>
          <div className="ptourn-entry-sub mono">
            {tournament?.start_date ? `${dayLabel(tournament.start_date, todayKey)} · ` : ''}
            {TOURNAMENT_EVENT_TYPE_LABELS[event.event_type].toUpperCase()}
          </div>
        </div>
        {/* A seed exists only once the draw is generated, so before that the
            badge is the member's registration state instead of an empty chip. */}
        {entry.seed_number !== null ? (
          <Badge variant="success">Seed {entry.seed_number}</Badge>
        ) : (
          <Badge variant="neutral">
            {entry.status === 'checked_in' ? 'Checked in' : 'Entered'}
          </Badge>
        )}
      </div>

      {doubles && entry.partner && (
        <div className="ptourn-partner">
          <AvatarChip name={entry.partner.full_name} id={entry.partner.id} src={entry.partner.avatar_url ?? undefined} size="sm" />
          <div className="ptourn-partner-body">
            <div className="ptourn-partner-name">Partner · {entry.partner.full_name}</div>
            {/* The mockup reads "CONFIRMED". There is no partner-confirmation
                state in the schema: tournament_pairs.status is the PAIR's
                progress through the event (registered / checked_in / withdrawn /
                disqualified / no_show), and a pair is created whole by an exec —
                nobody ever accepts an invitation. The real status is shown. */}
            <div className="ptourn-partner-state mono">
              {entry.status === 'checked_in' ? 'CHECKED IN' : entry.status.replace('_', ' ').toUpperCase()}
            </div>
          </div>
        </div>
      )}

      {/* The mockup's "YOUR ROUND 1" strip — a time, an opponent and "CT 3" — is
          not built. tournament_matches has `court` and `scheduled_time` columns,
          and nothing in either app ever writes to them: no admin screen sets a
          court or a start time, so both would render empty on every row in
          production. The opponent alone was not worth a strip that promised a
          schedule the club does not keep; the event's own page draws the
          bracket, which is where the next match genuinely lives. */}
    </Link>
  );
}
