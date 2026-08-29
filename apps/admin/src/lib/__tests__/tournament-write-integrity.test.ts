import { describe, it, expect, beforeEach, vi } from 'vitest';

// supabase-js resolves with { data, error } and only REJECTS on a transport
// failure, so every Postgres error the tournament engine hit — an RLS denial, a
// constraint violation — arrived as a fulfilled promise and was dropped on the
// floor. These tests exist to prove that stopped: the harness below can make
// any individual write fail the way Postgres actually fails, and every case
// asserts the failure reaches the caller AND that what is left behind can be
// repaired.

type Row = Record<string, unknown>;
type Op = 'select' | 'update' | 'insert' | 'delete' | 'upsert';

interface Fault {
  table: string;
  op: Op;
  message: string;
  /**
   * Narrow the fault to one row: gets the filters and the payload of the write,
   * and the column list it asked for. `cols` is what lets a fault stand for a
   * MISSING COLUMN rather than a broken table — PostgREST answers 42703 only to
   * the query that names the column, and a fault that took down every read of
   * the table instead would model an outage, not an out-of-date schema.
   */
  when?: (ctx: { filters: Array<[string, unknown]>; payload: Row; cols: string }) => boolean;
}

const store = vi.hoisted(() => ({
  db: {} as Record<string, Row[]>,
  faults: [] as Fault[],
  /**
   * Runs at the top of delete_phase_matches — the instant a redraw's guard has
   * already passed and its DELETE has not yet run. That is exactly where the
   * other desk's result commits in production, and the only way to reach D1.
   */
  beforeDeletePhase: null as null | (() => void),
  /**
   * Runs before each tournament_matches INSERT — the only place a competing
   * generation can land in production, because a draw is built one PostgREST
   * round trip at a time and the advisory lock its teardown took was released
   * at that teardown's COMMIT. Nothing else in this harness can put the other
   * desk's redraw INSIDE the insert loop, which is where 00197's whole finding
   * lives.
   */
  beforeMatchInsert: null as null | (() => void),
  /**
   * Runs at the top of complete_event_under_field_lock — after finalisation
   * has read the winners' status and written their placings, and before the
   * flip. That gap is precisely where an admin's disqualification commits in
   * production, and it is the only place the round-18 crowned-DQ interleaving
   * can be created: the guard in assignPositionsAndPoints has already run.
   */
  beforeCompleteEvent: null as null | (() => void),
  /** Every RPC the code under test issued, so a test can assert what it PASSED. */
  rpcCalls: [] as Array<{ name: string; args: Record<string, unknown> }>,
  /**
   * Runs at the top of promote_pool_qualifier — after buildFieldFromPool has
   * read the target field and passed assertNobodyLeftUnpaired, and before the
   * promotion writes. That gap is where a member's own entry commits in
   * production, and it is the only place the F-004 duplicate can be created:
   * for a doubles bracket the `existing` map is built from tournament_pairs
   * alone, so an unpaired participant row arriving here is invisible to it.
   */
  beforePromote: null as null | (() => void),
  /**
   * Runs at the top of add_participants_under_field_lock — after
   * addParticipantToEvent has asked playersAlreadyPaired and been told no, and
   * before the entry is written. In production those are two PostgREST round
   * trips and therefore two transactions, which is exactly why the check moved
   * into the RPC: an advisory lock cannot span them.
   */
  beforeAdd: null as null | (() => void),
  /**
   * "This database predates 00197" — ONE fact, honoured everywhere it shows.
   *
   * It has to be one switch rather than a hand-placed fault, because the two
   * observable consequences are not independent: the column the fence probes is
   * missing AND delete_phase_matches is still 00144's integer-returning
   * version. A test that arranged only one of them would be describing a
   * database that cannot exist, and the mutation proof would land on the wrong
   * line.
   */
  oldSchema: false,
  // Stands in for `gen_random_uuid()`. Bracket generation inserts a match shell
  // and immediately uses the id it gets back to wire up the next round, so an
  // insert that returns no id cannot be exercised at all.
  seq: 0,
}));

// Minimal PostgREST-shaped query builder: enough of select/eq/in/not/order/
// update/insert for the tournament actions, thenable so
// `await client.from(t).update(x).eq(...)` resolves the way the real client
// does — INCLUDING resolving with an { error } rather than throwing.
const makeClient = vi.hoisted(() => () => {
  function query(table: string) {
    const filters: Array<[string, unknown]> = [];
    const inFilters: Array<[string, unknown[]]> = [];
    const notFilters: Array<[string, string, unknown]> = [];
    // `.is(col, null)` — a seeded row may omit the column entirely, which stands
    // for SQL NULL here just as COALESCE tolerates it elsewhere in this harness.
    const isFilters: Array<[string, unknown]> = [];
    let orderBy: [string, boolean] | null = null;
    let cols = '*';
    let op: Op = 'select';
    let payload: Row = {};
    // The conflict target of an upsert. Undefined for every other op.
    let onConflict: string | undefined;
    // `.select(cols, { count: 'exact', head: true })`. An UPDATE already
    // reported its count here, because "matched no rows is a success" is the
    // whole reason this harness exists — but a SELECT did not, so every guard
    // that counts rows and refuses (assertDrawIsRebuildable, the go-live "no
    // bracket" check, the entry-cap checks) read `undefined`, took the
    // `(count ?? 0) > 0` branch as false, and was VACUOUS in every test that
    // reached it. A guard that cannot fail in the harness is a guard the
    // harness is not testing.
    let countExact = false;
    let head = false;

    // PostgREST spells a list literal `("a","b")`.
    const parseList = (raw: unknown): unknown[] =>
      String(raw).replace(/^\(/, '').replace(/\)$/, '').split(',')
        .map((s) => s.trim().replace(/^"/, '').replace(/"$/, ''));

    const passesNot = (r: Row) =>
      notFilters.every(([c, o, v]) => {
        if (o === 'in') return !parseList(v).includes(r[c]);
        if (o === 'is') return v === null ? r[c] !== null && r[c] !== undefined : r[c] !== v;
        return r[c] !== v;
      });

    const matching = () => {
      const rows = (store.db[table] ?? []).filter(
        (r) =>
          filters.every(([c, v]) => r[c] === v) &&
          inFilters.every(([c, vs]) => vs.includes(r[c])) &&
          isFilters.every(([c, v]) => (v === null ? r[c] === null || r[c] === undefined : r[c] === v)) &&
          passesNot(r),
      );
      if (!orderBy) return rows;
      const [col, asc] = orderBy;
      return [...rows].sort((a, b) => (((a[col] as number) ?? 0) - ((b[col] as number) ?? 0)) * (asc ? 1 : -1));
    };

    // Always a COPY. The real client decodes a row out of an HTTP response, so a
    // caller that read a row, wrote to it, and then consulted its own copy sees
    // the values from BEFORE the write. Handing back the live object instead made
    // that read follow the write, which is how a rollback-to-the-row-as-found
    // could look like a no-op and pass for the wrong reason.
    const embed = (r: Row): Row =>
      cols.includes('tournament_events(')
        ? { ...r, event: (store.db.tournament_events ?? []).find((e) => e.id === r.event_id) ?? null }
        : { ...r };

    const fault = () => {
      // 42703, and only for the query that names the missing column — the
      // generator's own `select('*')` on this row still succeeds on an old
      // database, it just comes back a column short.
      if (store.oldSchema && table === 'tournament_events' && op === 'select'
          && cols.includes('draw_generation_id')) {
        return { table, op, message: 'column tournament_events.draw_generation_id does not exist' } as Fault;
      }
      return store.faults.find((f) => f.table === table && f.op === op && (!f.when || f.when({ filters, payload, cols })));
    };

    const run = () => {
      const f = fault();
      // The whole point: a Postgres error is a RESOLVED value, not a rejection.
      if (f) return { data: null, error: { message: f.message } };
      if (op === 'update') {
        const hit = matching();
        for (const r of hit) Object.assign(r, payload);
        // PostgREST reports "matched no rows" as SUCCESS, so the count is the
        // only way a caller can tell a guarded write fired from one that did
        // not. Always returned; supabase-js only populates it when asked, and a
        // caller that does not ask simply ignores it.
        return { data: null, error: null, count: hit.length };
      }
      if (op === 'insert') {
        const rows = Array.isArray(payload) ? (payload as Row[]) : [payload];
        // trg_tournament_match_generation (00197). A stamped row whose claim is
        // not the event's current one is refused; an unstamped row passes. This
        // is on the TABLE and not in an RPC because the real inserts go straight
        // through PostgREST, and modelling it anywhere else would make the
        // superseded-generator tests pass without the fence existing.
        if (table === 'tournament_matches') {
          store.beforeMatchInsert?.();
          for (const r of rows) {
            if (r.draw_generation_id == null) continue;
            const ev = (store.db.tournament_events ?? []).find((e) => e.id === r.event_id);
            if (ev?.draw_generation_id !== r.draw_generation_id) {
              return {
                data: null,
                error: {
                  message: 'This draw was rebuilt by somebody else while it was being generated, so these matches were not saved. Press Generate again to build the current draw.',
                  code: '23514',
                },
              };
            }
          }
        }
        // The id is spread FIRST so an explicit one in the payload wins, exactly
        // as a DEFAULT does. Rows are returned rather than discarded because
        // `.insert(...).select('id').single()` is how every match shell in the
        // bracket generator is created.
        const created = rows.map((r) => ({ id: `gen-${++store.seq}`, ...r }));
        (store.db[table] ??= []).push(...created);
        return { data: created, error: null };
      }
      if (op === 'delete') {
        // The SAME window hook the delete_phase_matches stand-in fires, so the
        // redraw tests below drive the PRE-FIX sources too: before 00144 the
        // phase was cleared by a bare `.delete().eq('event_id', ...)` from
        // TypeScript and this is where the other desk's result lands. Without
        // it a test written against the RPC would simply not reproduce the
        // defect on the old code, and "it fails before the fix" would be a
        // claim rather than a measurement.
        if (table === 'tournament_matches') store.beforeDeletePhase?.();
        store.db[table] = (store.db[table] ?? []).filter((r) => !matching().includes(r));
        return { data: null, error: null };
      }
      // ONE ROW PER PARENT, matched on the conflict column rather than on the
      // filter chain — an upsert carries no `.eq()`. Added for 00118's private
      // note tables, which every void, no-show, restore and draw exit now
      // writes; without it those actions met an undefined method and the whole
      // action failed, which is precisely the coupling 00118 exists to avoid.
      if (op === 'upsert') {
        const rows = Array.isArray(payload) ? (payload as Row[]) : [payload];
        const bucket = (store.db[table] ??= []);
        // Copied to a const so it narrows inside the closure — `onConflict` is
        // a `let` in the enclosing scope, which tsc will not narrow across a
        // callback boundary.
        const key = onConflict;
        for (const r of rows) {
          const existing = key ? bucket.find((e) => e[key] === r[key]) : undefined;
          if (existing) Object.assign(existing, r);
          else bucket.push({ ...r });
        }
        return { data: null, error: null };
      }
      const rows = matching();
      // head:true asks PostgREST for the count and no body, so `data` is null —
      // a caller that reads `data` off a head request must see nothing there.
      if (countExact) return { data: head ? null : rows.map(embed), error: null, count: rows.length };
      return { data: rows.map(embed), error: null };
    };

    const api = {
      select(c: string, opts?: { count?: string; head?: boolean }) {
        cols = c;
        countExact = opts?.count === 'exact';
        head = opts?.head === true;
        return api;
      },
      update(p: Row) { op = 'update'; payload = p; return api; },
      insert(p: Row) { op = 'insert'; payload = p; return api; },
      upsert(p: Row, opts?: { onConflict?: string }) {
        op = 'upsert';
        payload = p;
        onConflict = opts?.onConflict;
        return api;
      },
      delete() { op = 'delete'; return api; },
      eq(c: string, v: unknown) { filters.push([c, v]); return api; },
      in(c: string, vs: unknown[]) { inFilters.push([c, vs]); return api; },
      is(c: string, v: unknown) { isFilters.push([c, v]); return api; },
      not(c: string, o: string, v: unknown) { notFilters.push([c, o, v]); return api; },
      order(c: string, opts?: { ascending?: boolean }) { orderBy = [c, opts?.ascending !== false]; return api; },
      async single() {
        const f = fault();
        if (f) return { data: null, error: { message: f.message } };
        // `.insert(x).select('id').single()` is a WRITE that returns what it
        // wrote. Reading the table instead — which is what this did — meant an
        // insert issued that way never happened at all, and any code path built
        // on the returned id was untestable.
        if (op !== 'select') {
          const res = run() as { data: Row[] | null; error: unknown };
          if (res.error) return { data: null, error: res.error };
          const created = res.data?.[0];
          return { data: created ? embed(created) : null, error: null };
        }
        const r = matching()[0];
        return { data: r ? embed(r) : null, error: null };
      },
      async maybeSingle() {
        const f = fault();
        if (f) return { data: null, error: { message: f.message } };
        const r = matching()[0];
        return { data: r ? embed(r) : null, error: null };
      },
      then(resolve: (v: unknown) => unknown) { return Promise.resolve(run()).then(resolve); },
    };
    return api;
  }

  // Stand-ins for the two rating RPCs
  // (supabase/migrations/00070_tournament_rating_atomic.sql and
  //  supabase/migrations/00078_tournament_rating_reversal_atomic.sql).
  //
  // BOTH ARE ATOMIC ON PURPOSE. Every logical write still consults store.faults
  // with the same { table, op, filters, payload } shape a direct PostgREST write
  // would, so the existing fault fixtures keep working — but the FIRST failure
  // restores the whole store and returns an error. A harness that let half the
  // writes survive could not tell the fixed behaviour from the bug it replaces.
  const faultFor = (table: string, op: Op, ctx: { filters: Array<[string, unknown]>; payload: Row; cols?: string }) =>
    store.faults.find((f) => f.table === table && f.op === op && (!f.when || f.when({ cols: '*', ...ctx })));

  // rating_setting_int('provisional_threshold', 8)
  const threshold = () => {
    const settings = (store.db.platform_settings ?? []).find((r) => r.key === 'rating_defaults')?.value as Row | undefined;
    return (settings?.provisional_threshold as number) ?? 8;
  };

  function applyRpc(args: Record<string, unknown>) {
    const rollback = structuredClone(store.db);
    const abort = (message: string) => {
      store.db = rollback;
      return Promise.resolve({ data: null, error: { message } });
    };

    const matchId = args.p_match_id as string;
    const discipline = args.p_discipline as 'singles' | 'doubles';
    const entries = args.p_entries as Array<Record<string, unknown>>;

    const m = (store.db.tournament_matches ?? []).find((r) => r.id === matchId);
    if (!m) return abort(`Tournament match not found: ${matchId}`);
    if (m.elo_snapshot) return abort(`Tournament match ${matchId} is already rated`);

    const snapshotEntries: Row[] = [];

    for (const e of entries) {
      const pid = e.player_id as string;
      const row = (store.db.ratings ?? []).find((r) => r.player_id === pid);
      if (!row) return abort(`No ratings row for player ${pid} — cannot rate tournament match ${matchId}`);

      const eloField = `${discipline}_elo`;
      const ratingFault = faultFor('ratings', 'update', {
        filters: [['player_id', pid]],
        payload: { [eloField]: e.after },
      });
      if (ratingFault) return abort(ratingFault.message);

      // apply_rating_stats. The seeded ratings rows omit the statistics columns
      // entirely, exactly as COALESCE(%I, 0) in the real SQL tolerates a NULL —
      // so a missing column has to read as 0 here or the assertions would come
      // back NaN and pass for the wrong reason.
      const n = (k: string) => (row[k] as number | undefined) ?? 0;
      const won = e.won === true;
      const played = n(`${discipline}_matches_played`) + 1;
      const streakField = `current_${discipline}_streak`;
      // Read BEFORE apply_rating_stats moves it, and stored on the snapshot, so
      // the reversal can put the streak back exactly rather than stepping it.
      const streakBefore = n(streakField);
      const streakAfter = won ? Math.max(streakBefore + 1, 1) : Math.min(streakBefore - 1, -1);

      row[eloField] = e.after;
      row[`${discipline}_matches_played`] = played;
      row[`${discipline}_wins`] = n(`${discipline}_wins`) + (won ? 1 : 0);
      row[`${discipline}_losses`] = n(`${discipline}_losses`) + (won ? 0 : 1);
      row[`${discipline}_points_scored`] = n(`${discipline}_points_scored`) + ((e.points_scored as number) ?? 0);
      row[`${discipline}_points_allowed`] = n(`${discipline}_points_allowed`) + ((e.points_allowed as number) ?? 0);
      row[`${discipline}_games_won`] = n(`${discipline}_games_won`) + ((e.games_won as number) ?? 0);
      row[`${discipline}_games_lost`] = n(`${discipline}_games_lost`) + ((e.games_lost as number) ?? 0);
      row[streakField] = streakAfter;
      if (played >= threshold()) row[`${discipline}_provisional`] = false;

      // The half apply_match_result has always done for challenges and the
      // tournament path never did. INSERT ... ON CONFLICT in the SQL, so a
      // player with no row gets one.
      const rel = (store.db.reliability_metrics ??= []).find((r) => r.player_id === pid);
      if (rel) rel.matches_completed = ((rel.matches_completed as number | undefined) ?? 0) + 1;
      else store.db.reliability_metrics.push({ player_id: pid, matches_completed: 1 });

      if (e.participant_id) {
        const payload = { elo_after: e.after, elo_change: e.delta };
        const pFault = faultFor('tournament_participants', 'update', {
          filters: [['id', e.participant_id]],
          payload,
        });
        if (pFault) return abort(pFault.message);
        const p = (store.db.tournament_participants ?? []).find((r) => r.id === e.participant_id);
        if (p) Object.assign(p, payload);
      }

      snapshotEntries.push({
        player_id: e.player_id, before: e.before, after: e.after, delta: e.delta,
        won: e.won, points_scored: e.points_scored ?? 0, points_allowed: e.points_allowed ?? 0,
        games_won: e.games_won ?? 0, games_lost: e.games_lost ?? 0,
        streak_before: streakBefore, streak_after: streakAfter,
      });
    }

    // A superset of the pre-00070 shape: the four rating fields are unchanged,
    // and the statistics plus the streak ride along so the reversal can take
    // them off exactly.
    const snapshot = { discipline, entries: snapshotEntries };
    const snapFault = faultFor('tournament_matches', 'update', {
      filters: [['id', matchId]],
      payload: { elo_snapshot: snapshot },
    });
    if (snapFault) return abort(snapFault.message);
    m.elo_snapshot = snapshot;

    return Promise.resolve({ data: null, error: null });
  }

  function reverseRpc(args: Record<string, unknown>) {
    const rollback = structuredClone(store.db);
    const abort = (message: string) => {
      store.db = rollback;
      return Promise.resolve({ data: null, error: { message } });
    };
    const ok = () => Promise.resolve({ data: null, error: null });

    const matchId = args.p_match_id as string;
    const m = (store.db.tournament_matches ?? []).find((r) => r.id === matchId);
    if (!m) return abort(`Tournament match not found: ${matchId}`);

    const snapshot = m.elo_snapshot as { discipline: 'singles' | 'doubles'; entries: Row[] } | null;
    // Nothing to reverse is not an error — that is what makes a retry safe.
    if (!snapshot || !snapshot.entries?.length) return ok();

    const d = snapshot.discipline;
    const eloField = `${d}_elo`;
    const streakField = `current_${d}_streak`;

    for (const e of snapshot.entries) {
      const pid = e.player_id as string;
      const row = (store.db.ratings ?? []).find((r) => r.player_id === pid);
      if (!row) return abort(`No ratings row for player ${pid} — cannot reverse tournament match ${matchId}`);

      const n = (k: string) => (row[k] as number | undefined) ?? 0;
      const ratingFault = faultFor('ratings', 'update', {
        filters: [['player_id', pid]],
        payload: { [eloField]: n(eloField) - (e.delta as number) },
      });
      if (ratingFault) return abort(ratingFault.message);

      // The three snapshot tiers, discriminated exactly as the SQL does it and
      // by POSITIVE tests, so an absent key falls through to the older, more
      // conservative branch.
      const hasStats = typeof e.won === 'boolean';
      const hasStreak = hasStats && typeof e.streak_before === 'number' && typeof e.streak_after === 'number';

      row[eloField] = n(eloField) - (e.delta as number);
      if (!hasStats) continue; // pre-00070: its match moved the Elo and nothing else

      const won = e.won === true;
      const played = Math.max(0, n(`${d}_matches_played`) - 1);
      row[`${d}_matches_played`] = played;
      row[won ? `${d}_wins` : `${d}_losses`] = Math.max(0, n(won ? `${d}_wins` : `${d}_losses`) - 1);
      row[`${d}_points_scored`] = Math.max(0, n(`${d}_points_scored`) - ((e.points_scored as number) ?? 0));
      row[`${d}_points_allowed`] = Math.max(0, n(`${d}_points_allowed`) - ((e.points_allowed as number) ?? 0));
      row[`${d}_games_won`] = Math.max(0, n(`${d}_games_won`) - ((e.games_won as number) ?? 0));
      row[`${d}_games_lost`] = Math.max(0, n(`${d}_games_lost`) - ((e.games_lost as number) ?? 0));
      // Exact only while this is still the player's most recent rated match —
      // otherwise rewinding would erase whatever moved the streak since.
      row[streakField] = hasStreak && n(streakField) === e.streak_after
        ? e.streak_before
        : (won ? Math.max(0, n(streakField) - 1) : Math.min(0, n(streakField) + 1));
      if (played < threshold()) row[`${d}_provisional`] = true;

      // Only a 00078 snapshot counted the match on reliability_metrics, so only
      // that tier may take it back off.
      if (hasStreak) {
        const rel = (store.db.reliability_metrics ?? []).find((r) => r.player_id === pid);
        if (rel) rel.matches_completed = Math.max(0, ((rel.matches_completed as number | undefined) ?? 0) - 1);
      }
    }

    if (d === 'singles') {
      const participantIds = [m.winner_participant_id, m.loser_participant_id]
        .filter((x): x is string => typeof x === 'string' && x.length > 0);
      if (participantIds.length > 0) {
        const payload = { elo_after: null, elo_change: null };
        const pFault = faultFor('tournament_participants', 'update', { filters: [], payload });
        if (pFault) return abort(pFault.message);
        for (const p of (store.db.tournament_participants ?? []).filter((r) => participantIds.includes(r.id as string))) {
          Object.assign(p, payload);
        }
      }
    }

    const snapFault = faultFor('tournament_matches', 'update', {
      filters: [['id', matchId]],
      payload: { elo_snapshot: null },
    });
    if (snapFault) return abort(snapFault.message);
    m.elo_snapshot = null;

    return ok();
  }

  // Stand-in for delete_phase_matches (00144).
  //
  // MODELLED AS ONE STATEMENT, because that is the whole of its correctness. The
  // real function deletes the phase and counts what it deleted in a single
  // data-modifying CTE, then RAISEs — rolling the delete back — if anything in
  // it had a result, carried an unreversed rating, or was on court. A harness
  // that counted first and deleted second would model the BROKEN version and
  // pass the tests below for the wrong reason, so this deletes, inspects the
  // rows it removed, and restores them on refusal.
  //
  // `store.beforeDeletePhase` fires at the top, which is where the other desk's
  // commit lands in production: the TypeScript guard has already read zero, the
  // seeding writes have already gone out, and the result arrives before the
  // delete does.
  function deletePhaseRpc(args: Record<string, unknown>) {
    const eventId = args.p_event_id as string;
    const phase = (args.p_phase as string | null) ?? null;
    store.beforeDeletePhase?.();

    const all = store.db.tournament_matches ?? [];
    // `p_phase IS NULL OR phase = p_phase` — NULL is NO FILTER, not `phase IS NULL`.
    const gone = all.filter((m) => m.event_id === eventId && (phase === null || m.phase === phase));
    store.db.tournament_matches = all.filter((m) => !gone.includes(m));

    const notBye = (m: Row) => m.is_bye !== true;
    const played = gone.filter((m) => notBye(m)
      && ['completed', 'walkover', 'disputed'].includes(m.status as string)).length;
    const rated = gone.filter((m) => m.elo_snapshot != null).length;
    const live = gone.filter((m) => notBye(m) && m.status === 'live').length;

    const refuse = (message: string) => {
      // The RAISE rolls the DELETE back with it.
      store.db.tournament_matches = all;
      return Promise.resolve({ data: null, error: { message, code: '23514' } });
    };
    if (played > 0) return refuse(`${played} match(es) in this draw have a result`);
    if (rated > 0) return refuse(`${rated} match(es) in this draw still carry an applied rating that was never reversed`);
    if (live > 0) return refuse(`${live} match(es) in this draw are being played right now`);

    // THE CLAIM (00197), issued after the three refusals for the same reason
    // the real one is: a teardown that is not allowed to proceed must not take
    // the event's generation away from one that is.
    const generation = `gen-${++store.seq}-draw`;
    const ev = (store.db.tournament_events ?? []).find((r) => r.id === eventId);
    if (ev) ev.draw_generation_id = generation;
    // 00144 returned a bare count. The app reading `.generation` off that is
    // the whole reason the fence has to run before the DELETE commits.
    if (store.oldSchema) return Promise.resolve({ data: gone.length, error: null });
    return Promise.resolve({ data: { deleted: gone.length, generation }, error: null });
  }

  // The grant ledger of 00188, which is what actually makes a bonus once-only.
  // Modelled as a table rather than a flag because the uniqueness is per
  // (event, kind, subject) and the two kinds are independent.
  function claimGrant(eventId: string, kind: string, subjectId: string): boolean {
    const grants = (store.db.tournament_bonus_grants ??= []);
    if (grants.some((g) => g.event_id === eventId && g.kind === kind && g.subject_id === subjectId)) {
      return false;
    }
    grants.push({ event_id: eventId, kind, subject_id: subjectId, applied_delta: 0 });
    return true;
  }

  // THE GRANT AND THE PAYMENT SHARE A TRANSACTION, so a failure after the claim
  // takes the claim down with it and the retry pays. Modelling the claim as
  // durable-on-failure would make a transient error permanently un-payable —
  // the opposite of what the ledger is for — and would quietly assert the
  // wrong contract about SQL that does roll back.
  function releaseGrant(eventId: string, kind: string, subjectId: string): void {
    const grants = (store.db.tournament_bonus_grants ??= []);
    const i = grants.findIndex(
      (g) => g.event_id === eventId && g.kind === kind && g.subject_id === subjectId
    );
    if (i >= 0) grants.splice(i, 1);
  }

  function ratingBounds(): { lo: number; hi: number } {
    const settings = (store.db.platform_settings ?? []).find((r) => r.key === 'rating_defaults')?.value as Row | undefined;
    let lo = (settings?.min_elo as number | undefined) ?? 100;
    let hi = (settings?.max_elo as number | undefined) ?? 1500;
    // rating_bounds() falls back wholesale when the pair is nonsensical.
    if (hi <= lo) { lo = 100; hi = 1500; }
    return { lo, hi };
  }

  // Mirrors apply_placement_bonus (00179, 00188): claim the grant, then read
  // the CURRENT rating, add, clamp to the CONFIGURED bounds, write, and report
  // what actually landed. The clamp used to happen in TypeScript before the
  // write; the point of 00179 is that the read, the add and the write are one
  // locked operation, and of 00188 that the claim is in the same transaction,
  // so the tests that assert clamping and single-payment are really asserting
  // this function.
  function placementBonusRpc(args: Record<string, unknown>) {
    const pid = args.p_player_id as string;
    const eventId = args.p_event_id as string;
    if (!claimGrant(eventId, 'rating', pid)) {
      return Promise.resolve({ data: { applied: false, already_granted: true, applied_delta: 0 }, error: null });
    }
    const field = args.p_discipline === 'singles' ? 'singles_elo' : 'doubles_elo';
    const row = (store.db.ratings ?? []).find((r) => r.player_id === pid);
    // The SQL raises rather than inventing 400 for a player with no rating row.
    if (!row) {
      releaseGrant(eventId, 'rating', pid);
      return Promise.resolve({
        data: null,
        error: { message: `No ratings row for player ${pid} — cannot award a placement bonus` },
      });
    }
    // Consulted with the same { table, op, filters, payload } shape a direct
    // PostgREST write would present, so fault fixtures written against
    // `ratings`/`update` keep describing this write after it moved into SQL.
    const fault = faultFor('ratings', 'update', { filters: [['player_id', pid]], payload: {} });
    if (fault) {
      releaseGrant(eventId, 'rating', pid);
      return Promise.resolve({ data: null, error: { message: fault.message } });
    }
    const { lo, hi } = ratingBounds();
    const before = row[field] as number;
    const after = Math.min(Math.max(before + ((args.p_bonus as number) ?? 0), lo), hi);
    row[field] = after;
    row.updated_at = new Date().toISOString();
    return Promise.resolve({
      data: { applied: true, already_granted: false, new_elo: after, applied_delta: after - before },
      error: null,
    });
  }

  // Mirrors credit_participant_placement_bonus (00188). Same grant, same lock,
  // same clamp — this write was a read-modify-write issued from the
  // application until 00188, and it carried the whole batch as its race
  // window exactly as the rating write did before 00179.
  function creditParticipantRpc(args: Record<string, unknown>) {
    const eventId = args.p_event_id as string;
    const partId = args.p_participant_id as string;
    const bonus = (args.p_bonus as number) ?? 0;
    if (!claimGrant(eventId, 'participant_credit', partId)) {
      return Promise.resolve({ data: { applied: false, already_granted: true }, error: null });
    }
    const row = (store.db.tournament_participants ?? []).find(
      (r) => r.id === partId && r.event_id === eventId
    );
    if (!row) {
      releaseGrant(eventId, 'participant_credit', partId);
      return Promise.resolve({
        data: null,
        error: { message: `No participant ${partId} in event ${eventId}` },
      });
    }
    // Same { table, op, filters, payload } shape a direct PostgREST write
    // presented, so fault fixtures written against tournament_participants
    // keep describing this write after it moved into SQL.
    const fault = faultFor('tournament_participants', 'update', { filters: [['id', partId]], payload: {} });
    if (fault) {
      releaseGrant(eventId, 'participant_credit', partId);
      return Promise.resolve({ data: null, error: { message: fault.message } });
    }
    const { lo, hi } = ratingBounds();
    const prevAfter = row.elo_after as number | null | undefined;
    const newAfter = prevAfter === null || prevAfter === undefined
      ? null
      : Math.min(Math.max(prevAfter + bonus, lo), hi);
    row.elo_change = ((row.elo_change as number | null) ?? 0) + bonus;
    row.elo_after = newAfter;
    return Promise.resolve({
      data: { applied: true, already_granted: false, elo_change: row.elo_change, elo_after: newAfter },
      error: null,
    });
  }

  function rpc(name: string, args: Record<string, unknown>) {
    store.rpcCalls.push({ name, args });
    if (name === 'apply_tournament_match_rating') return applyRpc(args);
    if (name === 'reverse_tournament_match_rating') return reverseRpc(args);
    if (name === 'delete_phase_matches') return deletePhaseRpc(args);
    if (name === 'apply_placement_bonus') return placementBonusRpc(args);
    if (name === 'credit_participant_placement_bonus') return creditParticipantRpc(args);
    // Mirrors event_has_legacy_bonus_payment (00189), reading the same marker
    // rows the SQL reads rather than a parallel fixture.
    if (name === 'event_has_legacy_bonus_payment') {
      const eventId = args.p_event_id as string;
      const f = faultFor('tournament_bonus_grants', 'select', { filters: [['event_id', eventId]], payload: {} });
      if (f) return Promise.resolve({ data: null, error: { message: f.message } });
      const marked = (store.db.tournament_bonus_grants ?? []).some(
        (g) => g.event_id === eventId && g.kind === 'event_legacy_paid' && g.subject_id === eventId,
      );
      return Promise.resolve({ data: marked, error: null });
    }
    // Mirrors publish_event_draw (00193). The status flip stopped being a plain
    // UPDATE when the re-count moved into the same statement, so the fake has to
    // model both halves — and it still consults faultFor on the tournament_events
    // UPDATE, because the fault-injection tests that make the publish fail are
    // asserting on the draw not being advertised, not on which wire call carried
    // it.
    if (name === 'publish_event_draw') {
      const eventId = args.p_event_id as string;
      const doubles = args.p_doubles as boolean;
      const payload = { status: args.p_new_status, updated_at: new Date().toISOString() };
      const f = faultFor('tournament_events', 'update', { filters: [['id', eventId]], payload });
      if (f) return Promise.resolve({ data: null, error: { message: f.message } });
      const ev = (store.db.tournament_events ?? []).find((r) => r.id === eventId);
      if (!ev) return Promise.resolve({ data: { ok: false, reason: 'event_not_found' }, error: null });
      // THE THREE ASSERTIONS 00197 ADDED. The first is the fence: publishing a
      // claim that has moved on would put this generation's status on somebody
      // else's bracket. The other two are about what was actually built, which
      // publication never looked at before.
      if (ev.draw_generation_id !== args.p_generation) {
        return Promise.resolve({ data: { ok: false, reason: 'superseded' }, error: null });
      }
      // THE DRAWN SET, NOT A COUNT (00200). p_expected was an integer and null
      // meant "do not check", which is how the pool-seeded path came to assert
      // nothing at all. Both directions are modelled here because the swap case
      // — one entrant out, one in, total unchanged — is invisible to a count and
      // is the reason the shape changed.
      const entrants = (args.p_entrants as string[] | null) ?? [];
      const wholeField = args.p_whole_field as boolean;
      const table = doubles ? 'tournament_pairs' : 'tournament_participants';
      const live = (store.db[table] ?? []).filter(
        (r) => r.event_id === eventId && (r.status === 'registered' || r.status === 'checked_in'),
      );
      if (entrants.length === 0) {
        // The real function RAISES here rather than returning a refusal: an
        // empty list is a caller fault, and letting it through would be the
        // null-means-do-not-check behaviour coming back by another door.
        return Promise.resolve({ data: null, error: { message: 'publish_event_draw: p_entrants may not be null or empty' } });
      }
      const liveIds = new Set(live.map((r) => r.id as string));
      const left = entrants.filter((id) => !liveIds.has(id)).length;
      if (left > 0) {
        return Promise.resolve({
          data: { ok: false, reason: 'entrant_left', count: left }, error: null,
        });
      }
      // Only when the draw was supposed to BE the field. A pool-seeded draw is
      // a subset by construction — the members who did not qualify are still
      // registered — so extras there are the normal state, not a fault.
      if (wholeField) {
        const drawn = new Set(entrants);
        const extra = live.filter((r) => !drawn.has(r.id as string)).length;
        if (extra > 0) {
          return Promise.resolve({
            data: { ok: false, reason: 'field_grew', expected: entrants.length, now: live.length },
            error: null,
          });
        }
      }
      const phase = (args.p_phase as string | null) ?? null;
      const built = (store.db.tournament_matches ?? []).filter(
        (m) => m.event_id === eventId && (phase === null || m.phase === phase),
      );
      const foreign = built.filter((m) => m.draw_generation_id !== args.p_generation).length;
      if (foreign > 0) {
        return Promise.resolve({ data: { ok: false, reason: 'foreign_matches', count: foreign }, error: null });
      }
      if (built.length === 0) {
        return Promise.resolve({ data: { ok: false, reason: 'no_matches' }, error: null });
      }
      Object.assign(ev, payload);
      return Promise.resolve({ data: { ok: true, matches: built.length }, error: null });
    }
    // Stand-in for promote_pool_qualifier (00198). The pool promotion used to be
    // a direct insert into one of these two tables; it moved behind an RPC so the
    // duplicate check and the write happen under the SAME field advisory lock the
    // entry path takes. The fake cannot model a lock, but it can model the check
    // the lock exists to make answerable — and the write still goes through the
    // ordinary query() path, so every fault fixture aimed at a tournament_pairs
    // or tournament_participants insert keeps firing exactly as before.
    if (name === 'promote_pool_qualifier') {
      store.beforePromote?.();
      const eventId = args.p_event_id as string;
      const doubles = args.p_doubles as boolean;
      const p1 = args.p_player1_id as string;
      const p2 = (args.p_player2_id as string | null) ?? null;
      const ids = [p1, p2].filter((v): v is string => typeof v === 'string');
      const live = (r: Row) => r.status !== 'withdrawn' && r.status !== 'disqualified';
      const asParticipant = (store.db.tournament_participants ?? []).some(
        (r) => r.event_id === eventId && ids.includes(r.player_id as string) && live(r),
      );
      const asPair = (store.db.tournament_pairs ?? []).some(
        (r) =>
          r.event_id === eventId &&
          (ids.includes(r.player1_id as string) || ids.includes(r.player2_id as string)) &&
          live(r),
      );
      if (asParticipant || asPair) {
        return Promise.resolve({
          data: { ok: false, reason: 'already_in_field', conflict: asParticipant ? 'participant' : 'pair' },
          error: null,
        });
      }
      const table = doubles ? 'tournament_pairs' : 'tournament_participants';
      const row: Row = doubles
        ? {
            event_id: eventId, player1_id: p1, player2_id: p2, pair_name: args.p_pair_name,
            combined_elo: args.p_elo, status: 'checked_in', checked_in_at: args.p_checked_in_at,
            checked_in_by: args.p_admin_id, seed_number: args.p_seed, added_by: args.p_admin_id,
          }
        : {
            event_id: eventId, player_id: p1, elo_before: args.p_elo,
            status: 'checked_in', checked_in_at: args.p_checked_in_at,
            checked_in_by: args.p_admin_id, seed_number: args.p_seed, added_by: args.p_admin_id,
          };
      return query(table).insert(row).select('id').single().then((res) =>
        res.error
          ? { data: null, error: res.error }
          : { data: { ok: true, id: (res.data as Row).id }, error: null },
      );
    }
    // Stand-in for add_participants_under_field_lock (00199). The exec's two
    // entry paths used to insert into tournament_participants directly, asking
    // "is this person already half of a pair?" one round trip earlier; the
    // check and the write now happen under the same field lock everybody else
    // takes. Modelled here are the two questions that lock exists to make
    // answerable — an existing pair and an existing live entry. Capacity and
    // the per-member cap are NOT modelled here even though 00199 does enforce
    // both (and refuses the whole call when either trips), because the app
    // decides them above this call and its own tests cover them there. So a
    // test that seeds a full event or an over-cap member and expects THIS to
    // refuse is testing nothing — it would pass here and fail against the real
    // database. Model them before writing one.
    if (name === 'add_participants_under_field_lock') {
      store.beforeAdd?.();
      const eventId = args.p_event_id as string;
      const entries = (args.p_entries as Array<{ player_id: string; elo_before: number }>) ?? [];
      const ids = entries.map((e) => e.player_id);
      const live = (r: Row) => r.status !== 'withdrawn' && r.status !== 'disqualified';
      const inPair = (store.db.tournament_pairs ?? []).some(
        (r) =>
          r.event_id === eventId &&
          (ids.includes(r.player1_id as string) || ids.includes(r.player2_id as string)) &&
          live(r),
      );
      if (inPair) {
        return Promise.resolve({ data: { ok: false, reason: 'already_in_pair' }, error: null });
      }
      const dupe = (store.db.tournament_participants ?? []).find(
        (r) => r.event_id === eventId && ids.includes(r.player_id as string) && live(r),
      );
      if (dupe) {
        return Promise.resolve({
          data: { ok: false, reason: 'already_registered', player_id: dupe.player_id },
          error: null,
        });
      }
      // The write still goes through the ordinary query() path, so every fault
      // fixture aimed at a tournament_participants insert keeps firing. One row
      // at a time because this builder's insert() takes one — the real function
      // writes the batch in a single statement, which matters for atomicity in
      // Postgres and not at all for what these tests observe, since a refusal
      // returns above this line and never reaches a partial write.
      return (async () => {
        const written: Row[] = [];
        for (const e of entries) {
          const row: Row = {
            event_id: eventId, player_id: e.player_id, elo_before: e.elo_before,
            added_by: args.p_admin_id, status: 'registered',
          };
          const res = await query('tournament_participants').insert(row).select('id').single();
          if (res.error) return { data: null, error: res.error };
          written.push({ ...row, id: (res.data as Row).id });
        }
        return { data: { ok: true, participants: written }, error: null };
      })();
    }
    // ---- THE FENCED FIELD RPCS (00201) -----------------------------------
    // These replaced nine direct PostgREST writes. Modelled against the same
    // store rather than stubbed, and they still consult faultFor on the
    // underlying table UPDATE, because the fault-injection tests that make a
    // withdrawal fail are asserting on the entry not moving — not on which wire
    // call carried it.
    const fieldTableFor = (isPair: boolean) => (isPair ? 'tournament_pairs' : 'tournament_participants');

    if (name === 'set_field_entry_status') {
      const entryId = args.p_entry_id as string;
      const isPair = args.p_is_pair as boolean;
      const next = args.p_new_status as string;
      const table = fieldTableFor(isPair);
      const row = (store.db[table] ?? []).find((r) => r.id === entryId);
      if (!row) return Promise.resolve({ data: { ok: false, reason: 'entry_not_found' }, error: null });
      const ev = (store.db.tournament_events ?? []).find((e) => e.id === row.event_id);
      if (!ev) return Promise.resolve({ data: { ok: false, reason: 'event_not_found' }, error: null });

      // The narrow guards, in the SQL's order: the check-in/no-show floor
      // first, then the completed ceiling that applies to all four statuses.
      if ((next === 'checked_in' || next === 'no_show') && ev.status === 'registration') {
        return Promise.resolve({ data: { ok: false, reason: 'event_status', event_status: ev.status }, error: null });
      }
      if (ev.status === 'completed') {
        return Promise.resolve({ data: { ok: false, reason: 'event_completed', event_status: ev.status }, error: null });
      }
      if (next === 'checked_in' && row.status !== 'registered' && row.status !== 'checked_in') {
        return Promise.resolve({
          data: { ok: false, reason: 'entry_status', entry_status: row.status, event_status: ev.status },
          error: null,
        });
      }

      const already = row.status === next;
      if (!already) {
        const payload: Row = { status: next };
        if (next === 'checked_in') {
          payload.checked_in_at = new Date().toISOString();
          payload.checked_in_by = (args.p_actor as string | null) ?? null;
        }
        const f = faultFor(table, 'update', { filters: [['id', entryId]], payload });
        if (f) return Promise.resolve({ data: null, error: { message: f.message } });
        Object.assign(row, payload);
      }
      return Promise.resolve({
        data: {
          ok: true, already, entry_status_before: row.status, event_status: ev.status,
          event_id: ev.id, tournament_id: ev.tournament_id, draw_locked: ev.draw_locked ?? false,
        },
        error: null,
      });
    }

    if (name === 'remove_field_entry') {
      const entryId = args.p_entry_id as string;
      const isPair = args.p_is_pair as boolean;
      const table = fieldTableFor(isPair);
      const rows = store.db[table] ?? [];
      const row = rows.find((r) => r.id === entryId);
      if (!row) return Promise.resolve({ data: { ok: false, reason: 'entry_not_found' }, error: null });
      const ev = (store.db.tournament_events ?? []).find((e) => e.id === row.event_id);
      if (!ev) return Promise.resolve({ data: { ok: false, reason: 'event_not_found' }, error: null });
      if (ev.status !== 'registration' && ev.status !== 'checkin') {
        return Promise.resolve({ data: { ok: false, reason: 'event_status', event_status: ev.status }, error: null });
      }
      if (ev.draw_locked) return Promise.resolve({ data: { ok: false, reason: 'draw_locked' }, error: null });
      const f = faultFor(table, 'delete', { filters: [['id', entryId]], payload: {} });
      if (f) return Promise.resolve({ data: null, error: { message: f.message } });
      store.db[table] = rows.filter((r) => r.id !== entryId);
      return Promise.resolve({
        data: { ok: true, event_id: ev.id, tournament_id: ev.tournament_id, event_status: ev.status },
        error: null,
      });
    }

    if (name === 'bulk_check_in_field') {
      const eventId = args.p_event_id as string;
      const table = fieldTableFor(args.p_is_pair as boolean);
      const ids = args.p_ids as string[] | null;
      const ev = (store.db.tournament_events ?? []).find((e) => e.id === eventId);
      if (!ev) return Promise.resolve({ data: { ok: false, reason: 'event_not_found' }, error: null });
      if (ev.status === 'registration' || ev.status === 'completed') {
        return Promise.resolve({ data: { ok: false, reason: 'event_status', event_status: ev.status }, error: null });
      }
      const payload: Row = {
        status: 'checked_in', checked_in_at: new Date().toISOString(),
        checked_in_by: (args.p_actor as string | null) ?? null,
      };
      const f = faultFor(table, 'update', { filters: [['event_id', eventId]], payload });
      if (f) return Promise.resolve({ data: null, error: { message: f.message } });
      // `status === 'registered'` is re-checked here and NOT taken from the id
      // list, exactly as the SQL does — the list was screened outside the fence.
      const hit = (store.db[table] ?? []).filter(
        (r) => r.event_id === eventId && r.status === 'registered' && (ids === null || ids.includes(r.id as string)),
      );
      for (const r of hit) Object.assign(r, payload);
      return Promise.resolve({
        data: {
          ok: true, checked_in: hit.length, ids: hit.map((r) => r.id),
          event_status: ev.status, tournament_id: ev.tournament_id,
        },
        error: null,
      });
    }

    if (name === 'mark_field_entries_no_show') {
      const ids = args.p_entry_ids as string[];
      const table = fieldTableFor(args.p_is_pair as boolean);
      const rows = (store.db[table] ?? []).filter((r) => ids.includes(r.id as string));
      if (rows.length === 0) return Promise.resolve({ data: { ok: false, reason: 'entry_not_found' }, error: null });
      const events = [...new Set(rows.map((r) => r.event_id))];
      if (events.length !== 1) {
        return Promise.resolve({ data: { ok: false, reason: 'entries_span_events', events: events.length }, error: null });
      }
      const ev = (store.db.tournament_events ?? []).find((e) => e.id === events[0]);
      if (!ev) return Promise.resolve({ data: { ok: false, reason: 'event_not_found' }, error: null });
      if (ev.status === 'registration' || ev.status === 'completed') {
        return Promise.resolve({ data: { ok: false, reason: 'event_status', event_status: ev.status }, error: null });
      }
      const f = faultFor(table, 'update', { filters: [['id', ids[0] as string]], payload: { status: 'no_show' } });
      if (f) return Promise.resolve({ data: null, error: { message: f.message } });
      for (const r of rows) r.status = 'no_show';
      return Promise.resolve({
        data: { ok: true, marked: rows.length, event_id: ev.id, tournament_id: ev.tournament_id, event_status: ev.status },
        error: null,
      });
    }

    // ---- 00209: the seeding, grouping and finalisation fences -----------
    //
    // Transcribed from the SQL in the same order the SQL asks them, so a guard
    // added there and not here shows up as a test that stops mirroring the
    // database rather than as one that quietly passes. faultFor is still
    // consulted on the underlying table so the existing fault-injection tests
    // reach these paths.

    /** The refusals every 00209 event-scoped RPC makes, in the SQL's order. */
    function seedStageRefusal(ev: Row | undefined, statuses: string[]) {
      if (!ev) return { ok: false, reason: 'event_not_found' };
      if (ev.draw_locked) return { ok: false, reason: 'draw_locked' };
      if (!statuses.includes(ev.status as string)) {
        return { ok: false, reason: 'event_status', event_status: ev.status };
      }
      return null;
    }

    if (name === 'set_field_entry_seed') {
      const entryId = args.p_entry_id as string;
      const table = fieldTableFor(args.p_is_pair as boolean);
      const row = (store.db[table] ?? []).find((r) => r.id === entryId);
      if (!row) return Promise.resolve({ data: { ok: false, reason: 'entry_not_found' }, error: null });
      const ev = (store.db.tournament_events ?? []).find((e) => e.id === row.event_id);
      const refusal = seedStageRefusal(ev, ['registration']);
      if (refusal) return Promise.resolve({ data: refusal, error: null });
      const payload: Row = { seed_number: (args.p_seed as number | null) ?? null };
      const f = faultFor(table, 'update', { filters: [['id', entryId]], payload });
      if (f) return Promise.resolve({ data: null, error: { message: f.message } });
      Object.assign(row, payload);
      return Promise.resolve({
        data: { ok: true, event_id: ev!.id, tournament_id: ev!.tournament_id, event_status: ev!.status },
        error: null,
      });
    }

    if (name === 'auto_seed_field_by_rating') {
      const eventId = args.p_event_id as string;
      const isPair = args.p_is_pair as boolean;
      const table = fieldTableFor(isPair);
      const ev = (store.db.tournament_events ?? []).find((e) => e.id === eventId);
      const refusal = seedStageRefusal(ev, ['registration']);
      if (refusal) return Promise.resolve({ data: refusal, error: null });
      const f = faultFor(table, 'update', { filters: [['event_id', eventId]], payload: { seed_number: 1 } });
      if (f) return Promise.resolve({ data: null, error: { message: f.message } });
      // row_number() OVER (ORDER BY <rating> DESC NULLS LAST, id).
      const ratingCol = isPair ? 'combined_elo' : 'elo_before';
      const eligible = (store.db[table] ?? [])
        .filter((r) => r.event_id === eventId && r.status !== 'withdrawn' && r.status !== 'disqualified')
        .sort((a, b) => {
          const x = a[ratingCol] as number | null;
          const y = b[ratingCol] as number | null;
          if (x === null && y === null) return String(a.id).localeCompare(String(b.id));
          if (x === null) return 1;
          if (y === null) return -1;
          if (x !== y) return y - x;
          return String(a.id).localeCompare(String(b.id));
        });
      eligible.forEach((r, i) => { r.seed_number = i + 1; });
      return Promise.resolve({
        data: {
          ok: true, seeded: eligible.length, event_id: eventId,
          tournament_id: ev!.tournament_id, event_status: ev!.status,
        },
        error: null,
      });
    }

    if (name === 'clear_field_seeds') {
      const eventId = args.p_event_id as string;
      const table = fieldTableFor(args.p_is_pair as boolean);
      const ev = (store.db.tournament_events ?? []).find((e) => e.id === eventId);
      const refusal = seedStageRefusal(ev, ['registration']);
      if (refusal) return Promise.resolve({ data: refusal, error: null });
      const f = faultFor(table, 'update', { filters: [['event_id', eventId]], payload: { seed_number: null } });
      if (f) return Promise.resolve({ data: null, error: { message: f.message } });
      // The WHOLE field, seeded or not — see the SQL's comment.
      const hit = (store.db[table] ?? []).filter((r) => r.event_id === eventId);
      for (const r of hit) r.seed_number = null;
      return Promise.resolve({
        data: {
          ok: true, cleared: hit.length, event_id: eventId,
          tournament_id: ev!.tournament_id, event_status: ev!.status,
        },
        error: null,
      });
    }

    if (name === 'set_field_groups') {
      const eventId = args.p_event_id as string;
      const table = fieldTableFor(args.p_is_pair as boolean);
      const assignments = args.p_assignments as Record<string, number>;
      const expected = args.p_expected as string[];
      const ev = (store.db.tournament_events ?? []).find((e) => e.id === eventId);
      const refusal = seedStageRefusal(ev, ['registration', 'checkin']);
      if (refusal) return Promise.resolve({ data: refusal, error: null });
      const groupCount = (ev!.group_count as number | null) ?? 1;
      if (groupCount < 2) {
        return Promise.resolve({ data: { ok: false, reason: 'not_a_group_stage', group_count: groupCount }, error: null });
      }
      const matches = (store.db.tournament_matches ?? []).filter((m) => m.event_id === eventId).length;
      if (matches > 0) {
        return Promise.resolve({ data: { ok: false, reason: 'fixtures_exist', matches }, error: null });
      }
      const now = (store.db[table] ?? [])
        .filter((r) => r.event_id === eventId && (r.status === 'registered' || r.status === 'checked_in'))
        .map((r) => r.id as string);
      const arrived = now.filter((id) => !expected.includes(id)).length;
      const left = expected.filter((id) => !now.includes(id)).length;
      if (arrived > 0 || left > 0) {
        return Promise.resolve({ data: { ok: false, reason: 'field_changed', arrived, left }, error: null });
      }
      const bad = Object.values(assignments).filter((g) => g < 1 || g > groupCount).length;
      if (bad > 0) {
        return Promise.resolve({ data: { ok: false, reason: 'group_out_of_range', group_count: groupCount, bad }, error: null });
      }
      const f = faultFor(table, 'update', { filters: [['event_id', eventId]], payload: { group_number: 1 } });
      if (f) return Promise.resolve({ data: null, error: { message: f.message } });
      let written = 0;
      for (const [id, group] of Object.entries(assignments)) {
        const row = (store.db[table] ?? []).find((r) => r.id === id && r.event_id === eventId);
        if (row) { row.group_number = group; written++; }
      }
      return Promise.resolve({
        data: {
          ok: true, assigned: written, group_count: groupCount, event_id: eventId,
          tournament_id: ev!.tournament_id, event_status: ev!.status,
        },
        error: null,
      });
    }

    if (name === 'set_field_entry_group') {
      const entryId = args.p_entry_id as string;
      const table = fieldTableFor(args.p_is_pair as boolean);
      const group = args.p_group as number;
      const row = (store.db[table] ?? []).find((r) => r.id === entryId);
      if (!row) return Promise.resolve({ data: { ok: false, reason: 'entry_not_found' }, error: null });
      const ev = (store.db.tournament_events ?? []).find((e) => e.id === row.event_id);
      const refusal = seedStageRefusal(ev, ['registration', 'checkin']);
      if (refusal) return Promise.resolve({ data: refusal, error: null });
      const groupCount = (ev!.group_count as number | null) ?? 1;
      if (groupCount < 2) {
        return Promise.resolve({ data: { ok: false, reason: 'not_a_group_stage', group_count: groupCount }, error: null });
      }
      if (group < 1 || group > groupCount) {
        return Promise.resolve({ data: { ok: false, reason: 'group_out_of_range', group_count: groupCount }, error: null });
      }
      const matches = (store.db.tournament_matches ?? []).filter((m) => m.event_id === row.event_id).length;
      if (matches > 0) {
        return Promise.resolve({ data: { ok: false, reason: 'fixtures_exist', matches }, error: null });
      }
      const payload: Row = { group_number: group };
      const f = faultFor(table, 'update', { filters: [['id', entryId]], payload });
      if (f) return Promise.resolve({ data: null, error: { message: f.message } });
      Object.assign(row, payload);
      return Promise.resolve({
        data: { ok: true, event_id: ev!.id, tournament_id: ev!.tournament_id, event_status: ev!.status },
        error: null,
      });
    }

    if (name === 'complete_event_under_field_lock') {
      store.beforeCompleteEvent?.();
      const eventId = args.p_event_id as string;
      const table = fieldTableFor(args.p_is_pair as boolean);
      const field = args.p_field as string[];
      const ev = (store.db.tournament_events ?? []).find((e) => e.id === eventId);
      if (!ev) return Promise.resolve({ data: { ok: false, reason: 'event_not_found' }, error: null });
      if (ev.status !== 'live') {
        return Promise.resolve({ data: { ok: false, reason: 'event_status', event_status: ev.status }, error: null });
      }
      const arrived = (store.db[table] ?? []).filter(
        (r) => r.event_id === eventId && r.status !== 'withdrawn' && r.status !== 'disqualified'
          && !field.includes(r.id as string),
      ).length;
      if (arrived > 0) {
        return Promise.resolve({ data: { ok: false, reason: 'field_changed', arrived }, error: null });
      }
      // 00211. Mirrors the real function: the field check above deliberately
      // allows SHRINKAGE, so it cannot see an entry that left AND had won.
      const won = (args.p_won as string[] | undefined) ?? [];
      const exitedWinners = (store.db[table] ?? []).filter(
        (r) => r.event_id === eventId && won.includes(r.id as string)
          && (r.status === 'withdrawn' || r.status === 'disqualified'),
      );
      if (exitedWinners.length > 0) {
        return Promise.resolve({
          data: {
            ok: false,
            reason: 'winner_exited',
            winners: exitedWinners.map((r) => `${r.id} (${r.status})`).join(', '),
          },
          error: null,
        });
      }
      const incomplete = (store.db.tournament_matches ?? []).filter(
        (m) => m.event_id === eventId
          && !['completed', 'walkover', 'voided', 'bye'].includes(m.status as string)
          && m.is_bye !== true,
      ).length;
      if (incomplete > 0) {
        return Promise.resolve({ data: { ok: false, reason: 'matches_incomplete', incomplete }, error: null });
      }
      const payload: Row = { status: 'completed', updated_at: new Date().toISOString() };
      const f = faultFor('tournament_events', 'update', { filters: [['id', eventId]], payload });
      if (f) return Promise.resolve({ data: null, error: { message: f.message } });
      Object.assign(ev, payload);
      return Promise.resolve({
        data: { ok: true, event_id: eventId, tournament_id: ev.tournament_id },
        error: null,
      });
    }

    return Promise.resolve({ data: null, error: { message: `unknown rpc ${name}` } });
  }

  return { from: (table: string) => query(table), rpc };
});

vi.mock('next/cache', () => ({ revalidatePath: () => {} }));
vi.mock('@sentry/nextjs', () => ({ captureException: () => {} }));
vi.mock('../supabase-server', () => ({ createAdminClient: makeClient }));
vi.mock('../actions/_shared', () => ({ requireCapability: async () => ({ id: 'admin-1' }) }));

import {
  enterMatchResult, editMatchResult, enterWalkover, voidMatch, undoMatchResult,
} from '../tournament-actions/results';
import { finalizeEvent, applyPlacementBonuses } from '../tournament-actions/finalize';
import { generateSingleEliminationBracket, generateRoundRobinMatches, setRoundMatchShape } from '../tournament-actions/brackets';
import { updateTournamentEvent } from '../tournament-actions/events';
// THE FORM'S OWN PAYLOAD BUILDER, not a hand-made patch. Whether an exec's
// choice of seed_by survives a save depends on toFormatPayload and
// updateTournamentEvent agreeing about when the column means something, and a
// test that wrote the patch by hand would assert the server half while assuming
// the client half — which is the exact seam the bug lived in.
import { toFormatPayload, EMPTY_FORMAT_VALUES } from '@/app/tournaments/[id]/event-format-fields';
// 00124's ceiling, imported rather than restated: the form, the generator's
// refusal and these tests must all be reading the same arithmetic.
import { maxFirstRoundByes, nextPowerOf2 } from '@badminton/shared';
import { autoSeedEventByElo } from '../tournament-actions/seeding';
import { addParticipantToEvent, withdrawParticipant } from '../tournament-actions/participants';
import {
  settleWrites, assertWritesSucceeded, reverseEloSnapshot, undoDecidedResult,
  FORFEIT_REASON, PUBLIC_WALKOVER_REASONS,
} from '../tournament-actions/_internal';
import { createAdminClient } from '../supabase-server';

const QF = 'match-qf';
const SF = 'match-sf';

function ratingOf(playerId: string) {
  return store.db.ratings!.find((r) => r.player_id === playerId)!.singles_elo as number;
}
function match(id: string) {
  return store.db.tournament_matches!.find((m) => m.id === id)!;
}
function participant(id: string) {
  return store.db.tournament_participants!.find((p) => p.id === id)!;
}
function event() {
  return store.db.tournament_events![0]!;
}
function snapshotPlayers(matchId: string): string[] {
  const snap = match(matchId).elo_snapshot as { entries: Array<{ player_id: string }> } | null;
  return (snap?.entries ?? []).map((e) => e.player_id);
}

// rating_defaults as it is actually configured in production, read live off the
// Pi rather than copied out of a migration: max_elo is 3001, not the 1500 the
// TS constant falls back to, and singles_k_established is 36, not the code
// default of 48. Tests that use the fallbacks would pass for the wrong reasons.
const LIVE_RATING_DEFAULTS = {
  min_elo: 100,
  max_elo: 3001,
  default_elo: 400,
  provisional_threshold: 8,
  singles_k_provisional: 64,
  singles_k_established: 36,
  doubles_k_provisional: 64,
  doubles_k_established: 36,
  sweep_margin_multiplier: 1.15,
};

beforeEach(() => {
  store.faults = [];
  store.beforeDeletePhase = null;
  store.beforeMatchInsert = null;
  store.beforeCompleteEvent = null;
  store.rpcCalls = [];
  store.beforePromote = null;
  store.beforeAdd = null;
  store.oldSchema = false;
  store.db = {
    tournaments: [{ id: 't1', suspended_at: null, suspension_reason: null, name: 'Test Cup' }],
    tournament_events: [{
      id: 'e1', tournament_id: 't1', status: 'live', event_type: 'mens_singles',
      format: 'single_elimination', match_format: 'best_of_3_to_21', elo_multiplier: 1,
      placement_bonus_enabled: false,
    }],
    tournament_participants: [
      { id: 'p-alice', event_id: 'e1', player_id: 'pl-alice', elo_before: 1000, elo_after: null, elo_change: null, final_position: null, points: null, status: 'checked_in' },
      { id: 'p-bob', event_id: 'e1', player_id: 'pl-bob', elo_before: 1000, elo_after: null, elo_change: null, final_position: null, points: null, status: 'checked_in' },
    ],
    ratings: [
      { player_id: 'pl-alice', singles_elo: 1000, singles_provisional: false, singles_matches_played: 30 },
      { player_id: 'pl-bob', singles_elo: 1000, singles_provisional: false, singles_matches_played: 30 },
    ],
    // Created for every player by the on-insert trigger (00004). Seeded non-zero
    // so a decrement that ran when it should not have is visible.
    reliability_metrics: [
      { player_id: 'pl-alice', matches_completed: 5 },
      { player_id: 'pl-bob', matches_completed: 5 },
    ],
    tournament_matches: [
      {
        id: QF, event_id: 'e1', status: 'ready', is_bye: false,
        participant_a_id: 'p-alice', participant_b_id: 'p-bob',
        winner_participant_id: null, loser_participant_id: null,
        winner_to_match_id: SF, winner_to_position: 'a',
        round_number: 1, scores: null, elo_snapshot: null, notes: null,
      },
      {
        id: SF, event_id: 'e1', status: 'pending', is_bye: false,
        participant_a_id: null, participant_b_id: null,
        winner_participant_id: null, loser_participant_id: null,
        winner_to_match_id: null, winner_to_position: null,
        round_number: 2, scores: null, elo_snapshot: null, notes: null,
      },
    ],
    platform_settings: [{ key: 'rating_defaults', value: { ...LIVE_RATING_DEFAULTS } }],
    notifications: [],
    tournament_audit_log: [],
  };
});

function setRatingDefault(key: string, value: unknown) {
  const row = store.db.platform_settings!.find((r) => r.key === 'rating_defaults')!;
  row.value = { ...(row.value as Row), [key]: value };
}

describe('settleWrites', () => {
  it('counts a resolved { error } as a failure, exactly like a rejection', async () => {
    const { failures, landed } = await settleWrites([
      ['row that saved', Promise.resolve({ data: null, error: null })],
      ['row denied by RLS', Promise.resolve({ data: null, error: { message: 'permission denied for table ratings' } })],
      ['row lost in transit', Promise.reject(new Error('fetch failed'))],
    ]);

    expect(landed).toEqual([true, false, false]);
    expect(failures.map((f) => f.label)).toEqual(['row denied by RLS', 'row lost in transit']);
    // The old idiom (`if (r.status === 'rejected')`) would have seen ONE failure
    // here and silently accepted the RLS denial as a successful write.
    expect(failures).toHaveLength(2);
  });

  it('names every failed write in the error it throws', () => {
    expect(() =>
      assertWritesSucceeded('Test batch', [{ label: 'ratings.singles_elo for player X', message: 'permission denied' }]),
    ).toThrow(/ratings\.singles_elo for player X \(permission denied\)/);
  });

  it('is a no-op when everything landed', () => {
    expect(() => assertWritesSucceeded('Test batch', [])).not.toThrow();
  });
});

describe('post-match Elo writes', () => {
  // These four used to assert the MITIGATION for a half-applied rating: one
  // player's Elo moved, the other's did not, and the snapshot recorded only the
  // half that landed. All the writes now happen inside
  // apply_tournament_match_rating, so a failure rolls the whole thing back and
  // the half-state is no longer reachable. Each assertion below is the corrected
  // behaviour, not the old one.

  it('rolls the whole result back when one player\'s rating write fails', async () => {
    store.faults.push({
      table: 'ratings', op: 'update', message: 'permission denied for table ratings',
      when: ({ filters }) => filters.some(([c, v]) => c === 'player_id' && v === 'pl-bob'),
    });

    const res = await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/permission denied/);
    expect(res.ok === false && res.error).toMatch(/NOTHING was applied/);
    // Previously Alice's rating moved and Bob's did not. Now neither does —
    // there is no partial rating to reconcile by hand.
    expect(ratingOf('pl-alice')).toBe(1000);
    expect(ratingOf('pl-bob')).toBe(1000);
  });

  it('never leaves ratings moved without a snapshot recording the deltas', async () => {
    // Finding #3: the snapshot write used to be a separate round trip AFTER the
    // rating writes committed. Fault the snapshot write specifically and prove
    // the ratings did not survive it — undo/void/edit all reverse from that
    // snapshot, so a moved rating with no snapshot was unrecoverable in-app.
    store.faults.push({
      table: 'tournament_matches', op: 'update', message: 'could not serialize access',
      when: ({ payload }) => 'elo_snapshot' in payload,
    });

    const res = await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect(res.ok).toBe(false);
    expect(match(QF).elo_snapshot).toBeNull();
    expect(ratingOf('pl-alice')).toBe(1000);
    expect(ratingOf('pl-bob')).toBe(1000);
  });

  it('leaves elo_snapshot null when nothing landed, so the match can be rated again', async () => {
    store.faults.push({ table: 'ratings', op: 'update', message: 'permission denied for table ratings' });

    const res = await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect(res.ok).toBe(false);
    // An empty snapshot is still truthy JSON, and the idempotency guard reads
    // any snapshot as "already rated" — writing one here would wedge the match.
    expect(match(QF).elo_snapshot).toBeNull();
    expect(ratingOf('pl-alice')).toBe(1000);
    expect(ratingOf('pl-bob')).toBe(1000);
  });

  it('rolls the ratings back when the participant row is what fails', async () => {
    store.faults.push({
      table: 'tournament_participants', op: 'update', message: 'null value violates not-null constraint',
      when: ({ payload }) => 'elo_after' in payload,
    });

    const res = await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect(res.ok).toBe(false);
    // The RPC surfaces whatever Postgres said; the label naming the individual
    // write is gone with the per-write batching, but the match id is not.
    expect(res.ok === false && res.error).toMatch(/match-qf/);
    expect(res.ok === false && res.error).toMatch(/not-null constraint/);
    // This used to snapshot both players because "ratings are the source of
    // truth and they did move". They no longer move at all.
    expect(snapshotPlayers(QF)).toEqual([]);
    expect(ratingOf('pl-alice')).toBe(1000);
  });

  it('writes a snapshot that is a superset of the shape undo/void/edit read', async () => {
    // player_id/before/after/delta are unchanged, so the snapshots already in
    // production stay readable. The statistics are added alongside them because
    // reversal now has to take those back off too.
    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    const snap = match(QF).elo_snapshot as { discipline: string; entries: Row[] };
    expect(snap.discipline).toBe('singles');
    expect(snap.entries).toHaveLength(2);
    expect(Object.keys(snap.entries[0]!).sort()).toEqual([
      'after', 'before', 'delta', 'games_lost', 'games_won',
      'player_id', 'points_allowed', 'points_scored',
      // 00078 adds these two. streak_before is what makes the streak reversible
      // exactly; streak_after is what says whether doing so is still safe. Their
      // presence is also the marker that reliability_metrics was incremented.
      'streak_after', 'streak_before', 'won',
    ]);
  });
});

describe('a decided match is never left unrated', () => {
  // The result row has to be written BEFORE the rating, because rating reads the
  // winner and loser off it. So a failed rating used to leave the match
  // completed-but-unrated — and nothing could retry it: enterMatchResult refuses
  // anything that is not pending/ready/live, and the withdrawal cascade skips
  // matches that are no longer open. A missing ratings row is the case that
  // actually reaches this, and it is deterministic: every retry hits it again.
  it('takes the result back off when the rating fails, so the desk can re-enter it', async () => {
    store.db.ratings = store.db.ratings!.filter((r) => r.player_id !== 'pl-bob');

    const res = await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/No ratings row for player pl-bob/);
    // The match is back where it started, not stranded on 'completed'.
    expect(match(QF).status).toBe('ready');
    expect(match(QF).winner_participant_id).toBeNull();
    expect(match(QF).loser_participant_id).toBeNull();
    expect(match(QF).scores).toBeNull();
    expect(match(QF).elo_snapshot).toBeNull();
    // ...and nothing advanced, because rating runs before advancement.
    expect(match(SF).participant_a_id).toBeNull();
  });

  it('lets the retry succeed once the cause is repaired', async () => {
    store.db.ratings = store.db.ratings!.filter((r) => r.player_id !== 'pl-bob');
    expect((await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a')).ok).toBe(false);

    store.db.ratings!.push({
      player_id: 'pl-bob', singles_elo: 1000, singles_provisional: false, singles_matches_played: 30,
    });
    const res = await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect(res.ok).toBe(true);
    expect(match(QF).status).toBe('completed');
    expect(ratingOf('pl-alice')).toBe(1026);
    // Counted exactly once — the abandoned first attempt left nothing behind.
    expect(store.db.ratings!.find((r) => r.player_id === 'pl-alice')!.singles_matches_played).toBe(31);
  });

  it('does the same for a walkover, which the withdrawal cascade cannot retry either', async () => {
    store.db.ratings = store.db.ratings!.filter((r) => r.player_id !== 'pl-bob');

    const res = await enterWalkover(QF, 'a', 'Opponent did not appear');

    expect(res.ok).toBe(false);
    expect(match(QF).status).toBe('ready');
    expect(match(QF).walkover_winner ?? null).toBeNull();
    expect(match(QF).winner_participant_id).toBeNull();
    expect(match(SF).participant_a_id).toBeNull();
  });

  it('refuses a result written over a match that changed underneath it', async () => {
    // The race closed at its source. Two desks both read a playable match and
    // both pass the status check; without a compare-and-swap both then WRITE a
    // result and both go on to rate it, and the loser only finds out inside the
    // rating RPC — by which point it has already stamped its own scores over the
    // winner's. Conditioning the write on the status this request read means the
    // loser writes nothing at all.
    //
    // Modelled by moving the match on between the read and the write, which is
    // what the other desk's commit does. The hook hangs off the suspension check
    // because that read sits between the two, and it declines to fault (returns
    // false) — it is here for its side effect only.
    store.faults.push({
      table: 'tournaments', op: 'select', message: 'unused',
      when: () => { match(QF).status = 'completed'; return false; },
    });

    const res = await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/changed while you were entering the result/);
    // Nothing of this attempt survives: no scores, no winner, no rating.
    expect(match(QF).scores).toBeNull();
    expect(match(QF).winner_participant_id).toBeNull();
    expect(match(QF).elo_snapshot).toBeNull();
    expect(ratingOf('pl-alice')).toBe(1000);
  });

  it('refuses to un-decide a match that turned out to be rated after all', async () => {
    // The losing side of a two-desk race. Both read a playable match, both write
    // a result, both compute against a null snapshot; the first RPC commits and
    // the second is refused with "already rated". Rolling the result back on
    // that refusal would leave a RATED match open for entry — every rating,
    // statistic and reliability count applied, and the idempotency guard then
    // refusing every attempt to enter it again. Strictly worse than the gap the
    // compensation closes, so the write is conditional on the snapshot still
    // being null and the count is what reports that it did not fire.
    //
    // The same guard covers a response lost after Postgres committed.
    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    const rated = { ...match(QF) };

    await expect(
      undoDecidedResult(createAdminClient(), QF, { ...rated, status: 'ready' }, new Error('is already rated')),
    ).rejects.toThrow(/already rated, so the result was left in place/);

    expect(match(QF).status).toBe('completed');
    expect(match(QF).winner_participant_id).toBe('p-alice');
    expect(match(QF).elo_snapshot).toEqual(rated.elo_snapshot);
    expect(ratingOf('pl-alice')).toBe(1026);
  });

  it('compensates when a prerequisite READ fails, not only the rating write', async () => {
    // applyTournamentMatchElo used to return quietly when one of its own reads
    // came back with an error — reporting the match as rated when nothing was.
    // Nothing threw, so the compensation never fired and the caller went on to
    // advance the winner: a decided, unrated match with a bracket built on it.
    store.faults.push({ table: 'ratings', op: 'select', message: 'permission denied for table ratings' });

    const res = await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/Could not read current ratings/);
    expect(match(QF).status).toBe('ready');
    expect(match(QF).elo_snapshot).toBeNull();
    expect(match(SF).participant_a_id).toBeNull();
  });

  it('tells the exec a failed CORRECTION is safe to repeat, and proves it is', async () => {
    // editMatchResult cannot be compensated the way entry is: by the time it
    // rates, the old rating has been reversed and the scoreline it came from
    // overwritten, so there is nothing to put back. Going forward is the only
    // route and it is safe — but only if the exec knows that pressing Save again
    // will not double the delta.
    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    store.faults.push({ table: 'ratings', op: 'select', message: 'deadlock detected' });
    const failed = await editMatchResult(QF, [{ a: 15, b: 21 }, { a: 17, b: 21 }], 'b', 'Scores read off the wrong sheet');
    expect(failed.ok).toBe(false);
    expect(failed.ok === false && failed.error).toMatch(/WAS saved but is not yet rated/);

    // The correction is on the row; the rating is not, and the snapshot is clear.
    expect(match(QF).winner_participant_id).toBe('p-bob');
    expect(match(QF).elo_snapshot).toBeNull();

    store.faults = [];
    expect((await editMatchResult(QF, [{ a: 15, b: 21 }, { a: 17, b: 21 }], 'b', 'Retry')).ok).toBe(true);

    // Rated once, for the corrected result — not once per attempt.
    expect(ratingOf('pl-bob')).toBe(1026);
    expect(ratingOf('pl-alice')).toBe(974);
    const alice = store.db.ratings!.find((r) => r.player_id === 'pl-alice')!;
    expect(alice.singles_matches_played).toBe(31);
    expect(alice.singles_losses).toBe(1);
    expect(alice.singles_wins).toBe(0);
    expect(store.db.reliability_metrics!.find((r) => r.player_id === 'pl-alice')!.matches_completed).toBe(6);
  });

  it('says so plainly when the result cannot be taken back off either', async () => {
    // The compensating write is a PostgREST write like any other. If it fails
    // too, the match really is decided and unrated, and the message has to say
    // that rather than "rating failed, try again" — which the exec would.
    store.db.ratings = store.db.ratings!.filter((r) => r.player_id !== 'pl-bob');
    store.faults.push({
      table: 'tournament_matches', op: 'update', message: 'deadlock detected',
      when: ({ payload }) => payload.status === 'ready',
    });

    const res = await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/decided but UNRATED/);
    expect(res.ok === false && res.error).toMatch(/No ratings row for player pl-bob/);
  });
});

describe('reliability metrics count tournament matches', () => {
  // apply_match_result has always incremented matches_completed for a confirmed
  // challenge; the tournament path never did, so the console's "Matches
  // Completed" figure and the player's own /my-stats page counted challenges
  // only, however many tournament rounds they played.
  function completed(playerId: string) {
    return store.db.reliability_metrics!.find((r) => r.player_id === playerId)!.matches_completed;
  }

  it('counts a tournament result for both players', async () => {
    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect(completed('pl-alice')).toBe(6);
    expect(completed('pl-bob')).toBe(6);
  });

  it('counts a walkover too — it is still a match that resolved', async () => {
    await enterWalkover(QF, 'a', 'Opponent did not appear');

    expect(completed('pl-alice')).toBe(6);
  });

  it('takes the count back off when the match is voided', async () => {
    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    await voidMatch(QF, 'Court collapsed');

    expect(completed('pl-alice')).toBe(5);
    expect(completed('pl-bob')).toBe(5);
  });

  it('does not double-count a corrected result', async () => {
    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    await editMatchResult(QF, [{ a: 15, b: 21 }, { a: 17, b: 21 }], 'b', 'Winner recorded on the wrong side');

    expect(completed('pl-alice')).toBe(6);
    expect(completed('pl-bob')).toBe(6);
  });

  it('leaves the count alone for a 00070-era snapshot, which never incremented it', async () => {
    // 00070 is already applied in production, so snapshots with statistics but no
    // streak_before exist. Their matches never touched reliability_metrics, and
    // decrementing on the way out would subtract a challenge somebody played.
    match(QF).status = 'completed';
    match(QF).winner_participant_id = 'p-alice';
    match(QF).loser_participant_id = 'p-bob';
    match(QF).elo_snapshot = {
      discipline: 'singles',
      entries: [{
        player_id: 'pl-alice', before: 1000, after: 1026, delta: 26,
        won: true, points_scored: 42, points_allowed: 32, games_won: 2, games_lost: 0,
      }],
    };
    Object.assign(store.db.ratings!.find((r) => r.player_id === 'pl-alice')!, {
      singles_elo: 1026, singles_matches_played: 31, singles_wins: 1,
      singles_points_scored: 42, current_singles_streak: 1,
    });

    expect((await voidMatch(QF, '00070-era row')).ok).toBe(true);

    // The statistics still reverse...
    expect(ratingOf('pl-alice')).toBe(1000);
    expect(store.db.ratings!.find((r) => r.player_id === 'pl-alice')!.singles_matches_played).toBe(30);
    // ...but the counter this snapshot never touched is left where it was.
    expect(completed('pl-alice')).toBe(5);
  });
});

describe('winner must agree with the scores', () => {
  // Finding #1: enterMatchResult validated that the GAME COUNT was legal but
  // never compared the caller's winnerSide with it. The dialog derives the
  // winner correctly, so this is only reachable by invoking the server action
  // directly — which is exactly why the server action has to check.
  it('refuses a 2-0 recorded for the side that lost both games', async () => {
    const res = await enterMatchResult(QF, [{ a: 21, b: 10 }, { a: 21, b: 12 }], 'b');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/winner_side does not match game scores/);
    // Nothing about the match may have moved: no stored winner, no Elo, no
    // advancement into the semi-final.
    expect(match(QF).status).toBe('ready');
    expect(match(QF).winner_participant_id).toBeNull();
    expect(match(QF).elo_snapshot).toBeNull();
    expect(ratingOf('pl-alice')).toBe(1000);
    expect(ratingOf('pl-bob')).toBe(1000);
    expect(match(SF).participant_a_id).toBeNull();
  });

  it('still accepts the result when the declared winner is the side that won', async () => {
    // Guards the fix against over-rejection — the check must not break the
    // normal path the dialog drives.
    const res = await enterMatchResult(QF, [{ a: 21, b: 10 }, { a: 21, b: 12 }], 'a');

    expect(res.ok).toBe(true);
    expect(match(QF).winner_participant_id).toBe('p-alice');
    expect(match(SF).participant_a_id).toBe('p-alice');
  });

  it('still lets a scoreless walkover be corrected', async () => {
    // A walkover's winner comes from the forfeit, not a scoreline, and
    // editMatchResult explicitly re-rates one. Rejecting an empty score list as
    // a 0-0 tie would take away the only way to fix a walkover awarded to the
    // wrong side, so the check has to skip a match with no games.
    expect((await enterWalkover(QF, 'a', 'Opponent did not appear')).ok).toBe(true);
    expect(match(QF).winner_participant_id).toBe('p-alice');

    expect((await editMatchResult(QF, [], 'b', 'Awarded to the wrong side')).ok).toBe(true);

    expect(match(QF).winner_participant_id).toBe('p-bob');
    expect(match(QF).loser_participant_id).toBe('p-alice');
  });

  it("keeps the exec's own sentence off the published match row", async () => {
    // FIX-LIST #18. `tournament_matches` is published to supabase_realtime by
    // 00113, and REPLICATION IGNORES COLUMN GRANTS — so whatever this action
    // put in `walkover_reason` was delivered to every phone watching the
    // bracket, on top of being readable through PostgREST by any signed-in
    // member. 00117/00118/00125 swept four columns of exec free text into
    // private tables and missed this one, because all four passes were scoped
    // by the word "note" and this column is called `reason`.
    //
    // The assertion is deliberately on the WHOLE ROW, not just the one column.
    // The bug was never that a particular field was wrong — it was that the
    // sentence travelled at all, and a `walkover_reason`-only check would pass
    // against a fix that merely moved it to a different published column.
    const sentence = 'Bob showed up drunk and I sent him home';
    expect((await enterWalkover(QF, 'a', sentence)).ok).toBe(true);

    expect(match(QF).walkover_reason).toBe('Walkover awarded by the desk');
    expect(JSON.stringify(match(QF))).not.toContain('drunk');

    // Not lost, though — the exec still has to be able to read back why they
    // awarded it. It is in the private table beside the void and no-show
    // reasons the same dialog writes.
    const note = (store.db.tournament_match_notes ?? []).find((n) => n.match_id === QF);
    expect(note?.note).toBe(sentence);
  });

  it('leaves the automatic forfeit phrase alone — that one IS the feature', async () => {
    // The withdrawal cascade writes one of two canned sentences, and those are
    // exactly what the opponent should see on the bracket: a walkover that
    // appears with no explanation is worse than one that says why. Bounding the
    // column is the fix, not emptying it, so the vocabulary has to stay
    // reachable — a test that only pinned the desk phrase would pass against a
    // change that nulled these too.
    expect(FORFEIT_REASON.withdrawn).toBe('Opponent withdrew from the event');
    expect(PUBLIC_WALKOVER_REASONS).toContain(FORFEIT_REASON.withdrawn);
    expect(PUBLIC_WALKOVER_REASONS).toContain(FORFEIT_REASON.disqualified);
    expect(PUBLIC_WALKOVER_REASONS).toContain('Walkover awarded by the desk');
    expect(PUBLIC_WALKOVER_REASONS).toHaveLength(3);
  });

  it('refuses through editMatchResult too — the same hole on the correction path', async () => {
    await enterMatchResult(QF, [{ a: 21, b: 10 }, { a: 21, b: 12 }], 'a');
    const aliceAfterWin = ratingOf('pl-alice');

    const res = await editMatchResult(QF, [{ a: 21, b: 10 }, { a: 21, b: 12 }], 'b', 'Trying to flip the winner');
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/winner_side does not match game scores/);

    // Refused before the snapshot was reversed, so the applied result is intact.
    expect(match(QF).winner_participant_id).toBe('p-alice');
    expect(ratingOf('pl-alice')).toBe(aliceAfterWin);
  });
});

describe('tournament matches update the whole ratings row', () => {
  // Finding #2, the one with confirmed live divergence: the tournament path
  // moved singles_elo and nothing else, so stored match counts were lower than
  // the real regular-plus-tournament counts.
  function rating(playerId: string) {
    return store.db.ratings!.find((r) => r.player_id === playerId)!;
  }

  it('increments matches played, wins and losses', async () => {
    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect(rating('pl-alice').singles_matches_played).toBe(31);
    expect(rating('pl-bob').singles_matches_played).toBe(31);
    expect(rating('pl-alice').singles_wins).toBe(1);
    expect(rating('pl-alice').singles_losses).toBe(0);
    expect(rating('pl-bob').singles_wins).toBe(0);
    expect(rating('pl-bob').singles_losses).toBe(1);
  });

  it('sums points and games onto the right side of the match', async () => {
    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect(rating('pl-alice').singles_points_scored).toBe(42);
    expect(rating('pl-alice').singles_points_allowed).toBe(32);
    expect(rating('pl-alice').singles_games_won).toBe(2);
    expect(rating('pl-alice').singles_games_lost).toBe(0);
    // The loser's figures are the exact mirror — a transposed side here would
    // credit the loser with the winner's points.
    expect(rating('pl-bob').singles_points_scored).toBe(32);
    expect(rating('pl-bob').singles_points_allowed).toBe(42);
    expect(rating('pl-bob').singles_games_won).toBe(0);
    expect(rating('pl-bob').singles_games_lost).toBe(2);
  });

  it('attributes points correctly when side B is the winner', async () => {
    // The mirror of the case above. statsForSide is keyed off which physical
    // slot the winner occupies, and getting it backwards is invisible whenever
    // side A happens to win.
    await enterMatchResult(QF, [{ a: 15, b: 21 }, { a: 17, b: 21 }], 'b');

    expect(rating('pl-bob').singles_points_scored).toBe(42);
    expect(rating('pl-bob').singles_games_won).toBe(2);
    expect(rating('pl-alice').singles_points_scored).toBe(32);
    expect(rating('pl-alice').singles_games_lost).toBe(2);
  });

  it('moves the current streak, up for the winner and down for the loser', async () => {
    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect(rating('pl-alice').current_singles_streak).toBe(1);
    expect(rating('pl-bob').current_singles_streak).toBe(-1);
  });

  it('clears the provisional flag on the match that reaches the threshold', async () => {
    // The specific consequence the review names: a player with eight tournament
    // singles matches stayed provisional forever AND kept drawing the placement
    // K-factor, because that K is chosen from the same count that never moved.
    for (const p of ['pl-alice', 'pl-bob']) {
      Object.assign(rating(p), { singles_matches_played: 7, singles_provisional: true });
    }

    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect(rating('pl-alice').singles_matches_played).toBe(8);
    expect(rating('pl-alice').singles_provisional).toBe(false);
    expect(rating('pl-bob').singles_provisional).toBe(false);
  });

  it('leaves a player short of the threshold provisional', async () => {
    for (const p of ['pl-alice', 'pl-bob']) {
      Object.assign(rating(p), { singles_matches_played: 3, singles_provisional: true });
    }

    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect(rating('pl-alice').singles_matches_played).toBe(4);
    expect(rating('pl-alice').singles_provisional).toBe(true);
  });

  it('takes the statistics back off when the match is voided', async () => {
    // Counterpart to the increments above. Once a tournament match moves the
    // counts, a reversal that only moved the Elo would leave a result in the
    // statistics that no longer exists anywhere else.
    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    expect((await voidMatch(QF, 'Court collapsed')).ok).toBe(true);

    expect(rating('pl-alice').singles_matches_played).toBe(30);
    expect(rating('pl-alice').singles_wins).toBe(0);
    expect(rating('pl-alice').singles_points_scored).toBe(0);
    expect(rating('pl-alice').singles_games_won).toBe(0);
    expect(rating('pl-alice').current_singles_streak).toBe(0);
    expect(ratingOf('pl-alice')).toBe(1000);
    expect(rating('pl-bob').singles_matches_played).toBe(30);
    expect(rating('pl-bob').singles_losses).toBe(0);
  });

  it('makes a player provisional again when the undo drops them below the threshold', async () => {
    // The mirror of clearing the flag. Without this, one entered-then-voided
    // match would permanently establish a player who has played 7.
    for (const p of ['pl-alice', 'pl-bob']) {
      Object.assign(rating(p), { singles_matches_played: 7, singles_provisional: true });
    }

    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    expect(rating('pl-alice').singles_provisional).toBe(false);

    await voidMatch(QF, 'Wrong court');

    expect(rating('pl-alice').singles_matches_played).toBe(7);
    expect(rating('pl-alice').singles_provisional).toBe(true);
  });

  it('does not double-count the statistics when a result is corrected', async () => {
    // editMatchResult reverses the snapshot and then RE-rates the match. Before
    // the reversal learned to move the counts, every correction added a second
    // matches_played, a second win, and a second set of points.
    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    await editMatchResult(QF, [{ a: 15, b: 21 }, { a: 17, b: 21 }], 'b', 'Scoresheet transcribed backwards');

    expect(rating('pl-alice').singles_matches_played).toBe(31);
    expect(rating('pl-bob').singles_matches_played).toBe(31);
    // The corrected result, not the sum of both.
    expect(rating('pl-alice').singles_wins).toBe(0);
    expect(rating('pl-alice').singles_losses).toBe(1);
    expect(rating('pl-bob').singles_wins).toBe(1);
    expect(rating('pl-bob').singles_losses).toBe(0);
    expect(rating('pl-bob').singles_points_scored).toBe(42);
    expect(rating('pl-alice').singles_points_scored).toBe(32);
  });

  it('leaves a pre-00070 snapshot\'s statistics alone when reversing it', async () => {
    // The three snapshots already in production have no `won` key, and their
    // matches never touched the counts. Reversing one must not deduct
    // statistics this match never added.
    Object.assign(rating('pl-alice'), { singles_matches_played: 30, singles_wins: 12 });
    match(QF).status = 'completed';
    match(QF).winner_participant_id = 'p-alice';
    match(QF).loser_participant_id = 'p-bob';
    match(QF).elo_snapshot = {
      discipline: 'singles',
      entries: [{ player_id: 'pl-alice', before: 1000, after: 1026, delta: 26 }],
    };
    store.db.ratings!.find((r) => r.player_id === 'pl-alice')!.singles_elo = 1026;

    expect((await voidMatch(QF, 'Legacy row')).ok).toBe(true);

    expect(ratingOf('pl-alice')).toBe(1000);          // Elo still reverses
    expect(rating('pl-alice').singles_matches_played).toBe(30); // counts untouched
    expect(rating('pl-alice').singles_wins).toBe(12);
  });

  it('records a walkover as a played match with no points or games', async () => {
    // A walkover carries no scores, exactly like a challenge walkover carries no
    // match_games rows. It still counts as a match played.
    const res = await enterWalkover(QF, 'a', 'Opponent did not appear');

    expect(res.ok).toBe(true);
    expect(rating('pl-alice').singles_matches_played).toBe(31);
    expect(rating('pl-alice').singles_wins).toBe(1);
    expect(rating('pl-alice').singles_points_scored).toBe(0);
    expect(rating('pl-alice').singles_games_won).toBe(0);
  });
});

describe('Elo reversal', () => {
  // These two replace a pair that asserted the old PARTIAL-reversal machinery:
  // the reversal ran as a batch of PostgREST writes, so one player's delta could
  // come off while the other's did not, and the mitigation was to write the
  // un-reversed entries back onto the snapshot and retry the remainder. That
  // shape is what made a double-reverse possible in the first place — the
  // reduced-snapshot write was a SEPARATE round trip, and when it failed the
  // ORIGINAL snapshot survived with every delta already gone, so the next
  // attempt subtracted them again. Since 00070 the statistics travel with the
  // Elo, so the second subtraction also strips a matches_played, a win, and a
  // set of points and games the match never added.
  //
  // reverse_tournament_match_rating (00078) does the whole reversal in one
  // transaction, so a partial reversal is unreachable and the assertions below
  // are the corrected invariant: all or nothing, and a retry reverses once.

  it('leaves every rating and the snapshot untouched when the reversal fails', async () => {
    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    const aliceApplied = ratingOf('pl-alice');
    const bobApplied = ratingOf('pl-bob');

    store.faults.push({
      table: 'ratings', op: 'update', message: 'permission denied for table ratings',
      when: ({ filters }) => filters.some(([c, v]) => c === 'player_id' && v === 'pl-alice'),
    });

    const res = await voidMatch(QF, 'Court collapsed');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/NOTHING was reversed/);
    // Previously Bob's half DID reverse while Alice's did not, and the snapshot
    // was rewritten to hold Alice alone. Now neither moves.
    expect(ratingOf('pl-alice')).toBe(aliceApplied);
    expect(ratingOf('pl-bob')).toBe(bobApplied);
    expect(match(QF).status).toBe('completed');   // so the void did not happen
    // The snapshot is intact — not reduced — so a retry reverses the whole
    // match and there is no entry that has already come off the ladder.
    expect(snapshotPlayers(QF)).toEqual(['pl-alice', 'pl-bob']);
    for (const p of ['pl-alice', 'pl-bob']) {
      expect(store.db.ratings!.find((r) => r.player_id === p)!.singles_matches_played).toBe(31);
    }
  });

  it('reverses exactly once when the void is retried', async () => {
    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    store.faults.push({
      table: 'ratings', op: 'update', message: 'deadlock detected',
      when: ({ filters }) => filters.some(([c, v]) => c === 'player_id' && v === 'pl-alice'),
    });
    expect((await voidMatch(QF, 'first attempt')).ok).toBe(false);

    store.faults = [];
    const res = await voidMatch(QF, 'second attempt');

    expect(res.ok).toBe(true);
    expect(ratingOf('pl-alice')).toBe(1000);
    expect(ratingOf('pl-bob')).toBe(1000);
    expect(match(QF).elo_snapshot).toBeNull();
    expect(match(QF).status).toBe('voided');
    for (const p of ['pl-alice', 'pl-bob']) {
      const row = store.db.ratings!.find((r) => r.player_id === p)!;
      expect(row.singles_matches_played).toBe(30);
      expect(row.singles_points_scored).toBe(0);
    }
    expect(store.db.ratings!.find((r) => r.player_id === 'pl-alice')!.singles_wins).toBe(0);
    expect(store.db.ratings!.find((r) => r.player_id === 'pl-bob')!.singles_losses).toBe(0);
    expect(store.db.reliability_metrics!.find((r) => r.player_id === 'pl-alice')!.matches_completed).toBe(5);
  });

  it('is a no-op the second time, rather than subtracting the deltas twice', async () => {
    // The failure this whole change exists to prevent, reduced to its core: the
    // snapshot and the reversal commit together, so a match with nothing left to
    // reverse reverses nothing. Before 00078 a surviving snapshot over
    // already-reversed ratings sent the second attempt through the same
    // subtraction again — Elo, match count, wins, points and games all.
    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    await reverseEloSnapshot(createAdminClient(), QF);
    await reverseEloSnapshot(createAdminClient(), QF);
    await reverseEloSnapshot(createAdminClient(), QF);

    const alice = store.db.ratings!.find((r) => r.player_id === 'pl-alice')!;
    expect(alice.singles_elo).toBe(1000);
    expect(alice.singles_matches_played).toBe(30);
    expect(alice.singles_wins).toBe(0);
    expect(alice.singles_points_scored).toBe(0);
    expect(store.db.reliability_metrics!.find((r) => r.player_id === 'pl-alice')!.matches_completed).toBe(5);
  });
});

describe('current streak survives an undo', () => {
  // Reversal used to step the streak one toward zero and stop, because nothing
  // recorded where it had been. A player on a three-match losing run who won and
  // had that win undone came out on 0 — their losing run erased.
  function streak(playerId: string) {
    return store.db.ratings!.find((r) => r.player_id === playerId)!.current_singles_streak;
  }

  it('restores a losing run exactly, instead of leaving the player on zero', async () => {
    Object.assign(store.db.ratings!.find((r) => r.player_id === 'pl-alice')!, { current_singles_streak: -3 });

    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    expect(streak('pl-alice')).toBe(1); // a win resets the run and starts a new one

    expect((await voidMatch(QF, 'Wrong court')).ok).toBe(true);

    expect(streak('pl-alice')).toBe(-3); // was 0 before 00078
  });

  it('restores a winning run for the loser of the undone match', async () => {
    Object.assign(store.db.ratings!.find((r) => r.player_id === 'pl-bob')!, { current_singles_streak: 6 });

    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    expect(streak('pl-bob')).toBe(-1);

    await voidMatch(QF, 'Wrong court');

    expect(streak('pl-bob')).toBe(6); // was 0 before 00078
  });

  it('steps toward zero instead when a later match has moved the streak since', async () => {
    // The exactness is only safe while the undone match is still the player's
    // most recent rated one. Otherwise restoring the stored value would erase
    // every result played in between, which is worse than the old imprecision —
    // so the stored streak_after is compared with what is actually in the row.
    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    expect(streak('pl-alice')).toBe(1);

    // Alice wins again somewhere else.
    Object.assign(store.db.ratings!.find((r) => r.player_id === 'pl-alice')!, { current_singles_streak: 2 });

    await voidMatch(QF, 'Scoresheet lost');

    expect(streak('pl-alice')).toBe(1);
  });

  it('KNOWN BOUND: restores anyway when later matches happen to land on the same streak', async () => {
    // Pinning a limitation, not asserting a desirable outcome. The "is this
    // still their most recent rated match" test is streak equality, and streak
    // values repeat: a win to +1, a loss to -1, a win back to +1 puts the row
    // back on the stored streak_after, and the restore then rewinds over both
    // later matches. Telling that apart needs a per-match streak ledger, which
    // is a bigger change than 00078; the pre-00078 step-toward-zero was wrong
    // here too, just differently. Only current_*_streak is affected — the Elo,
    // the counts and the reliability figure all reverse from the entry's own
    // numbers and are unaffected.
    Object.assign(store.db.ratings!.find((r) => r.player_id === 'pl-alice')!, { current_singles_streak: -3 });

    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    expect(streak('pl-alice')).toBe(1);

    // Two later matches elsewhere: a loss, then a win — back on 1.
    Object.assign(store.db.ratings!.find((r) => r.player_id === 'pl-alice')!, { current_singles_streak: 1 });

    await voidMatch(QF, 'Scoresheet lost');

    // Ideally 1 (the two later matches from a base of -3). Documented as -3.
    expect(streak('pl-alice')).toBe(-3);
  });

  it('leaves a pre-00070 snapshot\'s streak alone entirely', async () => {
    // No `won` key means the match never moved the statistics at all, streak
    // included. Three such rows are live in production.
    Object.assign(store.db.ratings!.find((r) => r.player_id === 'pl-alice')!, {
      singles_elo: 1026, current_singles_streak: 4,
    });
    match(QF).status = 'completed';
    match(QF).winner_participant_id = 'p-alice';
    match(QF).loser_participant_id = 'p-bob';
    match(QF).elo_snapshot = {
      discipline: 'singles',
      entries: [{ player_id: 'pl-alice', before: 1000, after: 1026, delta: 26 }],
    };

    expect((await voidMatch(QF, 'Legacy row')).ok).toBe(true);

    expect(ratingOf('pl-alice')).toBe(1000);
    expect(streak('pl-alice')).toBe(4);
  });

  it('steps toward zero for a 00070-era snapshot, which carries no prior streak', async () => {
    // The middle tier: statistics were applied, so they must reverse, but the
    // prior streak was never recorded and cannot be invented.
    Object.assign(store.db.ratings!.find((r) => r.player_id === 'pl-alice')!, {
      singles_elo: 1026, singles_matches_played: 31, singles_wins: 1, current_singles_streak: 1,
    });
    match(QF).status = 'completed';
    match(QF).winner_participant_id = 'p-alice';
    match(QF).loser_participant_id = 'p-bob';
    match(QF).elo_snapshot = {
      discipline: 'singles',
      entries: [{
        player_id: 'pl-alice', before: 1000, after: 1026, delta: 26,
        won: true, points_scored: 42, points_allowed: 32, games_won: 2, games_lost: 0,
      }],
    };

    expect((await voidMatch(QF, '00070-era row')).ok).toBe(true);

    expect(ratingOf('pl-alice')).toBe(1000);
    expect(store.db.ratings!.find((r) => r.player_id === 'pl-alice')!.singles_matches_played).toBe(30);
    expect(streak('pl-alice')).toBe(0);
  });
});

describe('sweep margin multiplier', () => {
  // apply_match_result passes get_margin_multiplier(games_won, games_lost) for
  // every challenge; this path passed nothing. K=36, format weight 1.25,
  // event multiplier 1, both players on 1000 so expected = 0.5:
  //   went the distance -> round(36 * 1.25 * 0.5)        = 23
  //   clean sweep       -> round(36 * 1.25 * 1.15 * 0.5) = 26
  it('leaves a match that went the distance unscaled', async () => {
    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 17, b: 21 }, { a: 21, b: 18 }], 'a');

    expect(ratingOf('pl-alice')).toBe(1023);
    expect(ratingOf('pl-bob')).toBe(977);
  });

  it('scales a 2-0 by the sweep multiplier, the way a challenge already did', async () => {
    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect(ratingOf('pl-alice')).toBe(1026);
    expect(ratingOf('pl-bob')).toBe(974);
  });

  it('scales the loser by the same factor — a sweep is a sweep for both sides', async () => {
    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    const gained = ratingOf('pl-alice') - 1000;
    const lost = 1000 - ratingOf('pl-bob');
    // Asymmetry here would inject net rating into the ladder.
    expect(gained).toBe(lost);
  });

  it('reads sweep_margin_multiplier from platform_settings, not the constant', async () => {
    setRatingDefault('sweep_margin_multiplier', 2);

    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect(ratingOf('pl-alice')).toBe(1045); // round(36 * 1.25 * 2 * 0.5)
  });

  it('bounds a wild setting to 2.0, matching get_margin_multiplier in SQL', async () => {
    setRatingDefault('sweep_margin_multiplier', 50);

    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect(ratingOf('pl-alice')).toBe(1045);
  });
});

describe('finalizeEvent', () => {
  // A one-match event: the semi is removed so the final IS the whole draw.
  beforeEach(async () => {
    store.db.tournament_matches = [match(QF)];
    match(QF).winner_to_match_id = null;
    match(QF).winner_to_position = null;
    await enterMatchResult(QF, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
  });

  it('leaves the event live when a final_position write fails, so it can be retried', async () => {
    store.faults.push({
      table: 'tournament_participants', op: 'update', message: 'permission denied for table tournament_participants',
      when: ({ payload }) => payload.final_position === 2,
    });

    await expect(finalizeEvent('e1')).rejects.toThrow(/final_position/);

    // The old code flipped the event to completed regardless, and finalizeEvent
    // refuses anything that is not live — so a half-positioned event could not
    // be repaired from the console at all.
    expect(event().status).toBe('live');
    expect(participant('p-alice').final_position).toBe(1);
    expect(participant('p-bob').final_position).toBeNull();
  });

  it('finishes the job on retry, because positions and points are absolute writes', async () => {
    store.faults.push({
      table: 'tournament_participants', op: 'update', message: 'deadlock detected',
      when: ({ payload }) => payload.final_position === 2,
    });
    await expect(finalizeEvent('e1')).rejects.toThrow();

    store.faults = [];
    await finalizeEvent('e1');

    expect(event().status).toBe('completed');
    expect(participant('p-alice').final_position).toBe(1);
    expect(participant('p-bob').final_position).toBe(2);
    expect(participant('p-alice').points).toBe(100);
    expect(participant('p-bob').points).toBe(75);
  });

  // NO FAULT IS INJECTED IN EITHER OF THESE. That is the point: the defect they
  // cover needs no failed write, no concurrency and no interleaving -- just an
  // ordinary disqualification after an ordinary final.
  it('refuses to crown a champion who has been disqualified', async () => {
    // The final is already recorded with p-alice as the winner (beforeEach).
    // The disqualification lands afterwards, which is the ordinary case: the
    // cascade forfeits only OPEN matches, so a completed final keeps its
    // recorded winner and finalisation used to read that as a championship.
    participant('p-alice').status = 'disqualified';

    await expect(finalizeEvent('e1')).rejects.toThrow(/has left the event/);

    // Nothing awarded, and the event still finalisable once a human voids or
    // replays the match. Deliberately NOT "or reinstate the entry": there is no
    // console path back from disqualified -- set_field_entry_status refuses
    // check-in from an exited status (00201) and is the only status writer.
    expect(event().status).toBe('live');
    expect(participant('p-alice').final_position).toBeNull();
    expect(participant('p-alice').points).toBeNull();
    expect(participant('p-bob').final_position).toBeNull();
    expect(participant('p-bob').points).toBeNull();
  });

  it('hands the winners to the completion fence, so the DQ cannot slip in behind the guard', async () => {
    // The round-18 finding. The guard above is a READ, and it holds no lock
    // through to the status flip -- an admin can disqualify the champion in
    // between, and the fence's own field check deliberately allows shrinkage,
    // so nothing downstream would have caught it. 00211 closes that by
    // re-reading these same entries under the lock, which only works if the
    // app actually tells it who won.
    await finalizeEvent('e1');
    expect(event().status).toBe('completed');

    const call = store.rpcCalls.find((c) => c.name === 'complete_event_under_field_lock');
    expect(call).toBeDefined();
    // p-alice won the final. An empty array here would make the fence's check
    // vacuous while every other test still passed.
    expect(call!.args.p_won).toEqual(['p-alice']);
  });

  it('refuses at the fence when the champion is disqualified after the guard ran', async () => {
    // The interleaving itself, driven through the mock, which mirrors 00211.
    // The guard cannot see this -- the status changes after it read -- so if
    // this passes it is the fence that caught it.
    store.beforeCompleteEvent = () => { participant('p-alice').status = 'disqualified'; };

    await expect(finalizeEvent('e1')).rejects.toThrow(/won its place left the event/);
    expect(event().status).toBe('live');
  });

  // ROUND ROBIN, and the two above are not enough on their own. wonTheirPosition
  // used to be filled only inside `if (knockout)`, so a round robin handed the
  // fence an empty p_won and its winner check was skipped entirely -- the guard
  // read as present in every knockout test while being absent on the other
  // branch. Codex found this in round 19.
  it('hands the fence a round robins placings too, not an empty set', async () => {
    Object.assign(event(), { format: 'round_robin' });

    await finalizeEvent('e1');
    expect(event().status).toBe('completed');

    const call = store.rpcCalls.find((c) => c.name === 'complete_event_under_field_lock');
    expect(call).toBeDefined();
    // BOTH, not just the leader. A round-robin table is computed against the
    // whole field, so one entry leaving moves every win count that was measured
    // against them -- the table nobody would compute again.
    expect((call!.args.p_won as string[]).slice().sort()).toEqual(['p-alice', 'p-bob']);
  });

  it('refuses a round robin whose leader is disqualified after the guard ran', async () => {
    Object.assign(event(), { format: 'round_robin' });
    store.beforeCompleteEvent = () => { participant('p-alice').status = 'disqualified'; };

    await expect(finalizeEvent('e1')).rejects.toThrow(/won its place left the event/);

    // The whole of codex's sequence: the leader kept final_position = 1 in a
    // COMPLETED event, so the placement-bonus ledger would have paid it.
    expect(event().status).toBe('live');
  });

  // THE ASYMMETRY, and it is the reason the round-robin hole was argued away in
  // the first place. A DQ landing BEFORE finalisation is not the same defect: a
  // round-robin table can simply be recomputed without that entry, and
  // computeRoundRobinStandings does exactly that, so nobody holds a placing
  // they cannot keep. A knockout has no such move -- the recorded final still
  // names the champion -- which is why the sibling test above DOES refuse.
  //
  // What the original reasoning missed is that this only covers entries that
  // left before the standings were computed. The two tests above are the case
  // it does not cover.
  it('places a round robins disqualified leader nowhere, rather than refusing', async () => {
    Object.assign(event(), { format: 'round_robin' });
    participant('p-alice').status = 'disqualified';

    await finalizeEvent('e1');

    expect(event().status).toBe('completed');
    expect(participant('p-alice').final_position).toBeNull();
    expect(participant('p-bob').final_position).toBe(1);
    // And the fence was told about the entry that IS placed, not about the one
    // that left -- so p_won stays a set of entries that must still be present.
    const call = store.rpcCalls.find((c) => c.name === 'complete_event_under_field_lock');
    expect(call!.args.p_won).toEqual(['p-bob']);
  });

  it('still finalises when the entry that left is one that LOST', async () => {
    // The guard is scoped to entries that won their placing. A withdrawal is
    // most often exactly this -- the forfeit cascade ends the run with a
    // loser's placing -- and refusing here would block most real events.
    participant('p-bob').status = 'withdrawn';

    await finalizeEvent('e1');

    expect(event().status).toBe('completed');
    expect(participant('p-alice').final_position).toBe(1);
    expect(participant('p-alice').points).toBe(100);
    expect(participant('p-bob').final_position).toBe(2);
  });

  it('surfaces a failed points write without completing the event', async () => {
    store.faults.push({
      table: 'tournament_participants', op: 'update', message: 'permission denied',
      when: ({ payload }) => 'points' in payload,
    });

    await expect(finalizeEvent('e1')).rejects.toThrow(/points/);
    expect(event().status).toBe('live');
  });
});

describe('late withdrawal cascade', () => {
  // A round-robin shape: Bob owes two matches, so a rating failure on the first
  // forfeit leaves the second one still open. Single elimination cannot show
  // this — an entry only ever has one live match at a time.
  const RR1 = 'match-rr1';
  const RR2 = 'match-rr2';

  beforeEach(() => {
    event().format = 'round_robin';
    store.db.tournament_participants!.push({
      id: 'p-carol', event_id: 'e1', player_id: 'pl-carol', elo_before: 1000,
      elo_after: null, elo_change: null, final_position: null, points: null, status: 'checked_in',
    });
    store.db.ratings!.push({
      player_id: 'pl-carol', singles_elo: 1000, singles_provisional: false, singles_matches_played: 30,
    });
    store.db.tournament_matches = [
      {
        id: RR1, event_id: 'e1', status: 'ready', is_bye: false,
        participant_a_id: 'p-alice', participant_b_id: 'p-bob',
        winner_participant_id: null, loser_participant_id: null,
        winner_to_match_id: null, winner_to_position: null,
        round_number: 1, scores: null, elo_snapshot: null, notes: null,
      },
      {
        id: RR2, event_id: 'e1', status: 'ready', is_bye: false,
        participant_a_id: 'p-carol', participant_b_id: 'p-bob',
        winner_participant_id: null, loser_participant_id: null,
        winner_to_match_id: null, winner_to_position: null,
        round_number: 2, scores: null, elo_snapshot: null, notes: null,
      },
    ];
  });

  it('stops the cascade on a failed rating write and lets a retry finish it', async () => {
    store.faults.push({
      table: 'ratings', op: 'update', message: 'permission denied for table ratings',
      when: ({ filters }) => filters.some(([c, v]) => c === 'player_id' && v === 'pl-alice'),
    });

    const first = await withdrawParticipant('p-bob', 'Sprained ankle');
    expect(first.ok).toBe(false);

    // Bob is out, but NEITHER match was forfeited: the first one's rating failed,
    // and recordWalkover now takes the walkover back off rather than leaving a
    // forfeited-but-unrated match that no later action could reach — the cascade
    // skips anything that is no longer open, so it would have been stranded.
    expect(participant('p-bob').status).toBe('withdrawn');
    expect(match(RR1).status).toBe('ready');
    expect(match(RR1).walkover_winner ?? null).toBeNull();
    expect(match(RR2).status).toBe('ready');

    store.faults = [];
    const second = await withdrawParticipant('p-bob', 'Sprained ankle');

    // The old guard refused this outright with "Already withdrawn", leaving the
    // remaining matches live against someone who had gone home. Now the retry
    // forfeits BOTH — including the one the failed attempt rolled back.
    expect(second.ok).toBe(true);
    expect(second.ok === true && second.data.forfeited).toBe(2);
    expect(match(RR1).status).toBe('walkover');
    expect(match(RR2).status).toBe('walkover');
    // Rated exactly once each, not once per attempt.
    expect(store.db.ratings!.find((r) => r.player_id === 'pl-alice')!.singles_matches_played).toBe(31);
    expect(store.db.ratings!.find((r) => r.player_id === 'pl-bob')!.singles_matches_played).toBe(32);
  });

  it('still refuses a plain second press when there is nothing left to forfeit', async () => {
    await withdrawParticipant('p-bob', 'Sprained ankle');

    const again = await withdrawParticipant('p-bob', 'Sprained ankle');
    expect(again.ok).toBe(false);
    expect(again.ok === false && again.error).toMatch(/already withdrawn/i);
  });
});

describe('placement bonuses', () => {
  beforeEach(() => {
    event().status = 'completed';
    event().placement_bonus_enabled = true;
    participant('p-alice').final_position = 1;
    participant('p-bob').final_position = 2;
  });

  it('clamps to the configured ceiling, not the hardcoded 1500', async () => {
    // Live max_elo is 3001. With the hardcoded bound this player would be
    // pushed DOWN to 1500 by winning the event.
    store.db.ratings!.find((r) => r.player_id === 'pl-alice')!.singles_elo = 2000;

    await applyPlacementBonuses('e1');

    expect(ratingOf('pl-alice')).toBe(2032); // champion bonus is 32
  });

  it('still clamps at the configured ceiling', async () => {
    setRatingDefault('max_elo', 1200);
    store.db.ratings!.find((r) => r.player_id === 'pl-alice')!.singles_elo = 1190;

    await applyPlacementBonuses('e1');

    expect(ratingOf('pl-alice')).toBe(1200);
  });

  it('raises a partial failure and pays nobody twice when it is retried', async () => {
    store.faults.push({
      table: 'ratings', op: 'update', message: 'permission denied for table ratings',
      when: ({ filters }) => filters.some(([c, v]) => c === 'player_id' && v === 'pl-bob'),
    });

    await expect(applyPlacementBonuses('e1')).rejects.toThrow(/pl-bob/);
    expect(ratingOf('pl-alice')).toBe(1032);
    expect(ratingOf('pl-bob')).toBe(1000);

    store.faults = [];
    await applyPlacementBonuses('e1');

    // The retry finishes the job. Alice is NOT paid a second time — the read-
    // modify-write has no idempotency of its own, so the ledger has to supply it.
    expect(ratingOf('pl-alice')).toBe(1032);
    expect(ratingOf('pl-bob')).toBe(1020); // finalist bonus is 20
    expect(participant('p-alice').elo_change).toBe(32);
    expect(participant('p-bob').elo_change).toBe(20);
  });

  // F-003. The audit-log ledger could only ever be written AFTER the whole
  // batch was paid, so between two concurrent finalises — or one retried
  // through a proxy timeout — both runs read a ledger with no rows in it and
  // both paid the podium. Blanking the ledger after a successful run is
  // exactly what the loser of that race sees.
  it('pays nobody twice even when the ledger is invisible to the second run', async () => {
    await applyPlacementBonuses('e1');
    expect(ratingOf('pl-alice')).toBe(1032);
    expect(ratingOf('pl-bob')).toBe(1020);

    // The second run's view: the first run's ledger row does not exist yet.
    store.db.tournament_audit_log = [];

    await applyPlacementBonuses('e1');

    // Unchanged. The grant rows of 00188 are what refuse it, and they were
    // written in the same transaction as each payment — so there is no window
    // in which a second caller can observe "not yet paid".
    expect(ratingOf('pl-alice')).toBe(1032);
    expect(ratingOf('pl-bob')).toBe(1020);
    expect(participant('p-alice').elo_change).toBe(32);
    expect(participant('p-bob').elo_change).toBe(20);
  });

  it('refuses to award anything when the ledger cannot be read', async () => {
    store.faults.push({ table: 'tournament_audit_log', op: 'select', message: 'permission denied' });

    await expect(applyPlacementBonuses('e1')).rejects.toThrow(/would double every rating/);
    expect(ratingOf('pl-alice')).toBe(1000);
  });

  it('warns loudly when the bonuses landed but the record of them did not', async () => {
    store.faults.push({ table: 'tournament_audit_log', op: 'insert', message: 'disk full' });

    await expect(applyPlacementBonuses('e1')).rejects.toThrow(/Do NOT re-run placement bonuses/);
  });

  // 00189. The per-subject grant rows only exist for payments made after 00188.
  // An event paid before it has none — the backfill that was supposed to
  // reconstruct them read details -> 'rated_players' out of the audit log, and
  // those details are NULL on every historical row, so it inserted nothing.
  // Without an event-level marker the unique index excludes nobody and the
  // whole podium gets paid a second time.
  describe('events paid before the grant ledger existed', () => {
    const markLegacyPaid = (eventId: string) => {
      (store.db.tournament_bonus_grants ??= []).push({
        event_id: eventId, kind: 'event_legacy_paid', subject_id: eventId, applied_delta: 0,
      });
    };

    it('refuses to pay an event marked as already paid by the old code path', async () => {
      markLegacyPaid('e1');

      await expect(applyPlacementBonuses('e1')).rejects.toThrow(/already awarded placement bonuses/);
      expect(ratingOf('pl-alice')).toBe(1000);
      expect(ratingOf('pl-bob')).toBe(1000);
      expect(participant('p-alice').elo_change ?? 0).toBe(0);
    });

    // This used to assert the opposite — that an override argument let an admin
    // force the run. It was removed because finalize.ts is a 'use server'
    // module, which makes that argument a field of the POST body rather than a
    // test affordance: anyone holding tournaments.results.bonuses.write could
    // send it and walk through the guard, and that capability is exactly who
    // the guard is for. A marked event is now unpayable through the action at
    // all; the remedy is a deliberate DELETE of the marker row in the database.
    it('cannot be forced past the marker by a caller supplying extra arguments', async () => {
      markLegacyPaid('e1');

      // Deliberately shaped like the old override call. The cast is the point:
      // a client POST is not type-checked, so the only thing that can stop this
      // is the signature genuinely not reading a second argument.
      const forced = applyPlacementBonuses as unknown as (
        id: string, opts?: Record<string, unknown>,
      ) => Promise<unknown>;

      await expect(forced('e1', { allowLegacyRepay: true })).rejects.toThrow(/already awarded placement bonuses/);
      expect(ratingOf('pl-alice')).toBe(1000);
      expect(ratingOf('pl-bob')).toBe(1000);
      expect(participant('p-alice').elo_change ?? 0).toBe(0);
    });

    it('fails closed when the marker cannot be read at all', async () => {
      store.faults.push({ table: 'tournament_bonus_grants', op: 'select', message: 'permission denied' });

      await expect(applyPlacementBonuses('e1')).rejects.toThrow(/would double every rating/);
      expect(ratingOf('pl-alice')).toBe(1000);
    });

    it('does not block an event that was never paid', async () => {
      await applyPlacementBonuses('e1');
      expect(ratingOf('pl-alice')).toBe(1032);
    });
  });
});

// ============================================================
// Third-place playoff (00080)
// ============================================================
//
// A 4-entry singles draw: two semi-finals feed the final with their winners and
// the playoff with their losers. Built by hand rather than by running the
// generator so each test can start from a known bracket and break exactly one
// thing about it.
const SF1 = 'm-sf1';
const SF2 = 'm-sf2';
const FINAL = 'm-final';
const THIRD = 'm-third';

function seedFourDraw() {
  const entry = (id: string, playerId: string) => ({
    id, event_id: 'e1', player_id: playerId, elo_before: 1000, elo_after: null,
    elo_change: null, final_position: null, points: null, status: 'checked_in',
  });
  const players = ['pl-alice', 'pl-bob', 'pl-cara', 'pl-dan'];
  store.db.tournament_participants = [
    entry('p-alice', 'pl-alice'), entry('p-bob', 'pl-bob'),
    entry('p-cara', 'pl-cara'), entry('p-dan', 'pl-dan'),
  ];
  store.db.ratings = players.map((player_id) => ({
    player_id, singles_elo: 1000, singles_provisional: false, singles_matches_played: 30,
  }));
  store.db.reliability_metrics = players.map((player_id) => ({ player_id, matches_completed: 5 }));

  const shell = (id: string, round: number) => ({
    id, event_id: 'e1', status: 'pending', is_bye: false, is_third_place: false,
    participant_a_id: null, participant_b_id: null,
    winner_participant_id: null, loser_participant_id: null,
    winner_to_match_id: null, winner_to_position: null,
    loser_to_match_id: null, loser_to_position: null,
    round_number: round, scores: null, elo_snapshot: null, notes: null,
  });

  store.db.tournament_matches = [
    {
      ...shell(SF1, 1), status: 'ready',
      participant_a_id: 'p-alice', participant_b_id: 'p-bob',
      winner_to_match_id: FINAL, winner_to_position: 'a',
      loser_to_match_id: THIRD, loser_to_position: 'a',
    },
    {
      ...shell(SF2, 1), status: 'ready',
      participant_a_id: 'p-cara', participant_b_id: 'p-dan',
      winner_to_match_id: FINAL, winner_to_position: 'b',
      loser_to_match_id: THIRD, loser_to_position: 'b',
    },
    shell(FINAL, 2),
    // Same round_number as the final — scheduled alongside it — and it feeds
    // nothing, so winner_to_match_id stays null.
    { ...shell(THIRD, 2), is_third_place: true },
  ];
}

// The tests below seed the finished draw by hand, which proves what the
// CORRECTIVE actions do with it but says nothing about whether the generator
// builds that shape. These two close that gap: everything after them is
// checking a fixture that this describe block proves is real.
describe('generating a draw with a third-place playoff', () => {
  function seedField(n: number) {
    store.db.tournament_matches = [];
    store.db.tournament_participants = Array.from({ length: n }, (_, i) => ({
      id: `p-${i}`, event_id: 'e1', player_id: `pl-${i}`, elo_before: 1500 - i * 10,
      elo_after: null, elo_change: null, seed_number: i + 1,
      final_position: null, points: null, status: 'checked_in',
    }));
    Object.assign(event(), { status: 'checkin', draw_locked: false });
  }
  const thirdPlaceMatches = () =>
    store.db.tournament_matches!.filter((m) => m.is_third_place);
  const roundOf = (n: number) =>
    store.db.tournament_matches!
      .filter((m) => m.round_number === n && !m.is_third_place)
      .sort((a, b) => (a.bracket_position as number) - (b.bracket_position as number));

  it('creates one playoff and points BOTH semi-finals at it, on distinct sides', async () => {
    // The wiring the hand-seeded fixtures assume. If the generator read the
    // wrong entry of matchesByRound, or gave both semi-finals the same
    // loser_to_position, every other test here would still pass while the live
    // draw sent one loser into a slot and then overwrote them with the other.
    seedField(4);

    expect((await generateSingleEliminationBracket('e1', true)).ok).toBe(true);

    const playoffs = thirdPlaceMatches();
    expect(playoffs).toHaveLength(1);
    const playoff = playoffs[0]!;

    const semis = roundOf(1);
    expect(semis).toHaveLength(2);
    expect(semis.map((m) => m.loser_to_match_id)).toEqual([playoff.id, playoff.id]);
    expect(semis.map((m) => m.loser_to_position)).toEqual(['a', 'b']);
    // Both semi-finals still feed the final with their winners.
    const final = roundOf(2)[0]!;
    expect(semis.map((m) => m.winner_to_match_id)).toEqual([final.id, final.id]);

    // The playoff feeds NOTHING. A winner_to_match_id here is the bug the whole
    // UI treatment exists to avoid claiming.
    expect(playoff.winner_to_match_id).toBeNull();
    expect(playoff.winner_to_position).toBeNull();
    // Scheduled alongside the final — same round, its own bracket position.
    expect(playoff.round_number).toBe(final.round_number);
    expect(playoff.bracket_position).not.toBe(final.bracket_position);
    expect(playoff.round_name).toBe('3rd Place Playoff');
    // Numbered after the final, so the final keeps the number it would have had
    // without this feature.
    expect(playoff.match_number as number).toBeGreaterThan(final.match_number as number);
  });

  it('builds the ordinary draw untouched when the playoff is not asked for', async () => {
    seedField(4);

    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);

    expect(thirdPlaceMatches()).toHaveLength(0);
    expect(roundOf(1).every((m) => m.loser_to_match_id === null || m.loser_to_match_id === undefined)).toBe(true);
    expect(store.db.tournament_matches).toHaveLength(3);
  });

  it('skips the playoff on a 2-entry draw rather than failing the generation', async () => {
    // A 2-entry draw is a final and nothing else: there is no semi-final round
    // to lose. Refusing the whole generation over a ticked box would leave the
    // exec with no draw at all, so the skip is recorded in the audit instead.
    seedField(2);

    expect((await generateSingleEliminationBracket('e1', true)).ok).toBe(true);

    expect(thirdPlaceMatches()).toHaveLength(0);
    expect(store.db.tournament_matches).toHaveLength(1);
    const audit = store.db.tournament_audit_log!.find((r) => r.action === 'bracket_generated')!;
    expect((audit.details as Row).third_place_match).toBe('skipped_no_semi_finals');
  });
});

// ============================================================
// Regenerating a draw that already exists
// ============================================================
//
// The exec-facing gap the club owner hit: "once the bracket is generated theres
// no way to regenerate a bracket." The BUTTON was the missing part
// (participant-controls.ts / EventHeader), but opening that door made a
// second-press path reachable for the first time, and it did not work.
describe('regenerating a draw that already exists', () => {
  function seedField(n: number) {
    store.db.tournament_matches = [];
    store.db.tournament_participants = Array.from({ length: n }, (_, i) => ({
      id: `p-${i}`, event_id: 'e1', player_id: `pl-${i}`, elo_before: 1500 - i * 10,
      elo_after: null, elo_change: null, seed_number: i + 1,
      final_position: null, points: null, status: 'checked_in',
    }));
    Object.assign(event(), { status: 'checkin', draw_locked: false });
  }
  const byes = () => store.db.tournament_matches!.filter((m) => m.is_bye);
  const playoffs = () => store.db.tournament_matches!.filter((m) => m.is_third_place);
  /** Round one in bracket order — the whole draw, since everything else follows. */
  const round1 = () => store.db.tournament_matches!
    .filter((m) => m.round_number === 1 && !m.is_third_place)
    .sort((a, b) => (a.bracket_position as number) - (b.bracket_position as number));
  /** The draw as one comparable string per match, for "did it change?" tests. */
  const layout = () => round1().map((m) => `${m.participant_a_id}/${m.participant_b_id}`);
  const matchIndexOf = (r1: Row[], id: string) =>
    r1.findIndex((m) => m.participant_a_id === id || m.participant_b_id === id);
  /** Which half of the draw an entrant is in: they can only meet across it in the final. */
  const halfOf = (r1: Row[], id: string) => (matchIndexOf(r1, id) < r1.length / 2 ? 0 : 1);
  /** Which quarter: two entrants sharing one must meet by the semi-finals. */
  const quarterOf = (r1: Row[], id: string) =>
    Math.floor(matchIndexOf(r1, id) / Math.max(1, r1.length / 4));

  it('lets a draw WITH BYES be redrawn — a bye is not a result', async () => {
    // THE BUG THIS FEATURE WOULD HAVE SHIPPED WITH. Generation writes
    // status:'completed' onto every bye, and assertDrawIsRebuildable counted
    // exactly that set of statuses, so any field that is not a power of two
    // produced a draw the guard then called "results already entered" — about
    // matches with no score, no Elo and no opponent to void. Three of the four
    // staging events sitting at bracket_generated have byes and nothing else
    // completed, so this was three refusals out of four.
    //
    // Five entries: an 8-slot draw with 3 byes.
    seedField(5);
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    expect(byes().length).toBeGreaterThan(0);
    expect(event().status).toBe('bracket_generated');
    const firstIds = store.db.tournament_matches!.map((m) => m.id);

    const res = await generateSingleEliminationBracket('e1', false);

    expect(res.ok).toBe(true);
    // Genuinely rebuilt, not left alone: every match is a new row.
    const secondIds = store.db.tournament_matches!.map((m) => m.id);
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
    expect(event().status).toBe('bracket_generated');
  });

  it('still refuses once a real result is in, and names why', async () => {
    // The other half of the same assertion: excluding byes must not have made
    // the guard vacuous. A played match is exactly what regeneration would
    // erase, and it is the reason the guard exists.
    seedField(4);
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    const semi = store.db.tournament_matches!.find((m) => m.round_number === 1)!;
    Object.assign(semi, { status: 'completed', is_bye: false });

    const res = await generateSingleEliminationBracket('e1', false);

    expect(res.ok).toBe(false);
    // NAMES THE NUMBER. The refusal is now reachable from a live event, where
    // the exec cannot see at a glance what has been played, so "results have
    // already been entered" on a 128-match draw is not something anybody can
    // act on.
    expect(res.ok === false && res.error).toMatch(/1 match in this event has a result/);
    expect(res.ok === false && res.error).toMatch(/Byes do not count/);
    // Refused before the delete — the draw people are reading is still there.
    expect(store.db.tournament_matches!.length).toBeGreaterThan(0);
  });

  // ------------------------------------------------------------
  // THE GUARD IS A READ, AND THE DELETE IS NOT PROTECTED BY IT
  // ------------------------------------------------------------
  // assertDrawIsRebuildable runs 40+ sequential round trips before the delete —
  // the field read, the pool promotion, one seed_number UPDATE per entrant. A
  // result entered anywhere in that window is invisible to it, and the delete
  // that follows has no predicate at all.
  //
  // What that costs is not a rebuilt draw. `elo_snapshot` is the ONLY record of
  // the deltas a rated match put on the ladder — reverse_tournament_match_rating
  // reads that column and nothing else — so deleting the row leaves both players
  // holding a rating change that no path in the system can take back. Silent:
  // the exec entering the score is told it saved (it did), the exec redrawing is
  // told the draw regenerated (it did), and the ladder is wrong for the season.
  //
  // The assertions below are ON THE SURVIVING ROWS, never on "it threw". A fix
  // that refused and deleted anyway, or that deleted the phase and left the
  // rated match orphaned, passes a throw-only test and loses the rating.
  it('REFUSES WHEN A RESULT LANDS AFTER THE GUARD AND BEFORE THE DELETE, and loses nothing', async () => {
    seedField(4);
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    const before = store.db.tournament_matches!.map((m) => m.id).sort();
    const snapshot = { discipline: 'singles', entries: [{ player_id: 'pl-0', delta: 17 }] };

    // The other desk commits in the window. This is D1 exactly: the guard has
    // already counted zero and the seeding writes have already landed.
    store.beforeDeletePhase = () => {
      const semi = store.db.tournament_matches!.find((m) => m.round_number === 1 && !m.is_bye)!;
      Object.assign(semi, { status: 'completed', elo_snapshot: snapshot });
    };

    const res = await generateSingleEliminationBracket('e1', false);

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/have a result|has a result/);
    // NOTHING WAS DELETED. Not the rated match, and not the rest of the phase
    // either — a half-deleted draw is its own corruption.
    expect(store.db.tournament_matches!.map((m) => m.id).sort()).toEqual(before);
    const rated = store.db.tournament_matches!.find((m) => m.elo_snapshot != null);
    // The snapshot is still there, so the delta is still reversible.
    expect(rated?.elo_snapshot).toEqual(snapshot);
  });

  // ==========================================================================
  // A SUPERSEDED GENERATION CANNOT WRITE (00197)
  // ==========================================================================
  //
  // 00193 made the PUBLICATION of a draw atomic and said in its own header what
  // it left open: generation is dozens of separate round trips, and the advisory
  // lock its teardown takes is an xact lock that is gone the moment that DELETE
  // commits. So two execs pressing Generate interleave — A deletes and starts
  // inserting, B deletes (taking A's rows) and finishes, and A's remaining
  // INSERTs land in a draw that is already live.
  //
  // WHY THIS HAS NOT OBVIOUSLY BROKEN ANYTHING, and why that is not a defence.
  // tournament_matches_draw_position_idx (00107) is UNIQUE on
  // (event_id, phase, round_number, bracket_position), so most of A's late rows
  // collide with B's. That only holds while both generators build the SAME
  // position space. One withdrawal between A and B is enough to make A's draw
  // larger, and A's surplus positions collide with nothing.
  //
  // The hook fires INSIDE the insert loop, because that is the only place the
  // race exists. Fired at the teardown instead — the one window this file
  // already had — it would reproduce nothing: at that point A has written
  // nothing to supersede.
  // THE SWAP. Nobody asked for this one — it fell out of comparing the drawn
  // SET instead of the drawn TOTAL, and it is the strongest reason 00200
  // changed the shape.
  //
  // One entrant withdraws and another enters while the draw is being built. The
  // count is identical before and after, so the old `now > expected` comparison
  // saw nothing at all and published a bracket with a fixture for somebody who
  // had left and none for somebody who was in the event. Both halves are wrong
  // and neither is visible from a total.
  it('REFUSES A DRAW WHEN ONE ENTRANT SWAPPED FOR ANOTHER MID-BUILD, leaving the count unchanged', async () => {
    seedField(4);

    let fired = false;
    store.beforeMatchInsert = () => {
      if (fired || (store.db.tournament_matches ?? []).length === 0) return;
      fired = true;
      const rows = store.db.tournament_participants ?? [];
      // p-3 leaves, somebody new arrives. Four registered before, four after.
      rows.find((r) => r.id === 'p-3')!.status = 'withdrawn';
      rows.push({
        id: 'p-late', event_id: 'e1', player_id: 'pl-late', elo_before: 1400,
        elo_after: null, elo_change: null, seed_number: null,
        final_position: null, points: null, status: 'registered',
      });
    };

    const res = await generateSingleEliminationBracket('e1', false);

    // The count check could not have produced this. Proof it is the set:
    const live = (store.db.tournament_participants ?? []).filter(
      (r) => r.status === 'registered' || r.status === 'checked_in',
    );
    expect(live).toHaveLength(4);

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/left the event while it was being built/);
    // The remedy is one press of the button they just pressed, and the draw
    // must not have been advertised in the meantime.
    expect(res.ok === false && res.error).toMatch(/press Generate again/);
    expect(event().status).toBe('checkin');
  });

  // THE OTHER DIRECTION, AND WHAT ACTUALLY ANSWERS IT. A pure arrival never
  // reaches publish_event_draw's own check: assertFieldDidNotGrow runs a few
  // lines earlier and refuses first, by design — "it fails the generation early
  // and cheaply". Neutralising the RPC's arrival branch leaves this test green,
  // and that is not a gap in the test, it is where the answer comes from.
  //
  // So this pins the SENTENCE, not the fence. It is worth keeping through a
  // rewrite of the fence because the failure it guards against is a plausible
  // one: 00200 added a departure message beside the arrival message, and an
  // arrival that starts reading as "somebody left the event" is wrong in a way
  // no other test here would notice. The fence's own arrival branch is covered
  // by the swap case above, which assertFieldDidNotGrow cannot see.
  it('still refuses a draw that somebody entered mid-build, with the arrival sentence', async () => {
    seedField(4);

    let fired = false;
    store.beforeMatchInsert = () => {
      if (fired || (store.db.tournament_matches ?? []).length === 0) return;
      fired = true;
      (store.db.tournament_participants ?? []).push({
        id: 'p-late', event_id: 'e1', player_id: 'pl-late', elo_before: 1400,
        elo_after: null, elo_change: null, seed_number: null,
        final_position: null, points: null, status: 'registered',
      });
    };

    const res = await generateSingleEliminationBracket('e1', false);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/arrived while this draw was being built/);
    expect(event().status).toBe('checkin');
  });

  it('REFUSES A DRAW WHOSE GENERATION WAS SUPERSEDED MID-BUILD, and publishes nothing', async () => {
    seedField(4);
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    Object.assign(event(), { status: 'checkin', draw_locked: false });

    // The other desk redraws after A's first insert has landed: its teardown
    // clears the table and claims the event's generation. Once only — A must be
    // refused on its very next write, not repeatedly rescued.
    let fired = false;
    store.beforeMatchInsert = () => {
      if (fired || (store.db.tournament_matches ?? []).length === 0) return;
      fired = true;
      store.db.tournament_matches = [];
      Object.assign(event(), { draw_generation_id: 'the-other-desks-claim' });
    };

    const res = await generateSingleEliminationBracket('e1', false);

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/rebuilt by somebody else/);
    // THE ASSERTION THAT MATTERS. Not "it threw" — that a superseded generation
    // left no fixture behind and did not advertise a draw. A test that only
    // checked the message would pass on a fix that refused the publish and let
    // the orphan matches stand, which is the corrupt state, not the safe one.
    expect(store.db.tournament_matches ?? []).toHaveLength(0);
    expect(event().status).toBe('checkin');
  });

  // The other end of the same fence, and the case the trigger alone does not
  // cover: A's inserts ALL land — nothing supersedes it until it has finished
  // building — and the claim moves in the window between its last INSERT and its
  // publish. Without the check in publish_event_draw this flips a status onto a
  // table whose contents belong to somebody else's draw.
  it('refuses to publish a draw whose claim moved after the last insert', async () => {
    seedField(4);
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    Object.assign(event(), { status: 'checkin', draw_locked: false });

    const claim = event().draw_generation_id;
    expect(typeof claim).toBe('string');
    Object.assign(event(), { draw_generation_id: 'the-other-desks-claim' });

    const publish = await makeClient().rpc('publish_event_draw', {
      p_event_id: 'e1',
      p_new_status: 'bracket_generated',
      p_doubles: false,
      p_entrants: ['tp-1'],
      p_whole_field: false,
      p_phase: null,
      p_generation: claim,
    });
    expect(publish.data).toMatchObject({ ok: false, reason: 'superseded' });
    expect(event().status).toBe('checkin');
  });

  it('REFUSES TO TEAR DOWN A DRAW AGAINST A DATABASE OLDER THAN THIS IMAGE, deleting nothing', async () => {
    // The deploy order this repo actually runs. Images auto-update from CI the
    // moment a merge lands; migrations are applied by hand afterwards. So the
    // ordinary sequence is new-image-old-database, and in that window
    // delete_phase_matches is still 00144's integer-returning version.
    //
    // Without the fence, the shape of the failure is the worst one available:
    // the RPC commits its DELETE in its own round trip, the generation check
    // then finds no generation in an integer and throws, and the phase is gone
    // with nothing rebuilt. Pressing Generate again just repeats it. The fence
    // turns that into a refusal with the draw untouched, by dating the schema
    // BEFORE anything destructive runs.
    seedField(4);
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    const before = store.db.tournament_matches!.length;
    expect(before).toBeGreaterThan(0);
    Object.assign(event(), { status: 'checkin', draw_locked: false });

    // 42703 — what PostgREST answers when 00197 has not been applied and the
    // column the fence asks for does not exist yet.
    store.oldSchema = true;

    const res = await generateSingleEliminationBracket('e1', false);

    // FIRST, because it is the one that matters: the old draw is still
    // standing. Remove the fence and this is what breaks — the teardown commits
    // and the phase is gone, which no re-press can undo.
    expect(store.db.tournament_matches!.length).toBe(before);
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/left alone/);
  });

  it('refuses when a match is ON COURT — no race required', async () => {
    // RESULT_MATCH_STATUSES excludes 'live', correctly: a live match has no
    // score and no Elo. But it has PEOPLE ON IT, and the redraw deletes it from
    // under them along with its court and its ready marks. This needed no
    // concurrency at all — just an exec who did not know 'live' was not counted.
    seedField(4);
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    const semi = store.db.tournament_matches!.find((m) => m.round_number === 1 && !m.is_bye)!;
    Object.assign(semi, { status: 'live' });

    const res = await generateSingleEliminationBracket('e1', false);

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/being played right now/);
    // And it names the remedy, which costs one click on the Court Management tab.
    expect(res.ok === false && res.error).toMatch(/Undo the start/);
    expect(store.db.tournament_matches!.length).toBeGreaterThan(0);
  });

  it('refuses a row that reads `voided` but still carries an applied rating', async () => {
    // Production holds matches in this shape: a void racing a result entry,
    // from when voidMatchImpl wrote status on the id alone. That race is closed
    // now, but these rows remain. "Void it first" is a dead end for one — it IS
    // voided — so the refusal has to name the two-step that actually reverses
    // it.
    seedField(4);
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    const semi = store.db.tournament_matches!.find((m) => m.round_number === 1 && !m.is_bye)!;
    Object.assign(semi, {
      status: 'voided',
      elo_snapshot: { discipline: 'singles', entries: [{ player_id: 'pl-0', delta: 17 }] },
    });

    const res = await generateSingleEliminationBracket('e1', false);

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/applied rating that was never reversed/);
    expect(res.ok === false && res.error).toMatch(/Unvoid then undo/);
    expect(store.db.tournament_matches!.length).toBeGreaterThan(0);
  });

  it('STILL redraws over a properly voided match — the escape hatch must survive', async () => {
    // The other half of the previous assertion, and the one that decides whether
    // this is shippable. reverse_tournament_match_rating sets elo_snapshot to
    // NULL in the same transaction as the reversal (00078), so a match voided
    // through the console carries no snapshot and does not block. If it did,
    // "void those matches first" — the only remedy the refusal offers — would
    // lead nowhere and the draw would be permanently unregenerable.
    seedField(4);
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    for (const m of store.db.tournament_matches!) {
      Object.assign(m, { status: 'voided', is_bye: false, elo_snapshot: null });
    }

    const res = await generateSingleEliminationBracket('e1', false);

    expect(res.ok).toBe(true);
    expect(store.db.tournament_matches!.length).toBeGreaterThan(0);
    expect(store.db.tournament_matches!.every((m) => m.status !== 'voided')).toBe(true);
  });

  it('refuses to redraw a FINALISED knockout event', async () => {
    // 1922133 wired assertNotFinalised into the round-robin generator and not
    // this one. It matters more here, if anything: finalizeEvent reads
    // final_position off the bracket, so a completed knockout event whose
    // matches had all been voided could be redrawn on top of a placement-bonus
    // ledger that had already paid the old finishers.
    seedField(4);
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    Object.assign(event(), { status: 'completed' });
    // Voided, so assertDrawIsRebuildable has nothing to object to — which is
    // precisely the hole: this used to be the way past the block.
    for (const m of store.db.tournament_matches!) Object.assign(m, { status: 'voided', is_bye: false });

    const res = await generateSingleEliminationBracket('e1', false);

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/finalised/);
  });

  it('refuses to redraw a locked draw', async () => {
    seedField(4);
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    Object.assign(event(), { draw_locked: true });

    const res = await generateSingleEliminationBracket('e1', false);

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/Draw is locked/);
  });

  it('takes the third-place choice made at THIS regeneration, in both directions', async () => {
    // The choice is not stored on tournament_events — the generated match IS
    // the record — so the redraw has to be told, every time. A regenerate that
    // reused a stale flag would silently drop or add a bronze match that nobody
    // chose, which is why the confirm dialog asks again and pre-ticks from the
    // draw that exists.
    seedField(4);
    expect((await generateSingleEliminationBracket('e1', true)).ok).toBe(true);
    expect(playoffs()).toHaveLength(1);

    // Drop it.
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    expect(playoffs()).toHaveLength(0);

    // And add it back.
    expect((await generateSingleEliminationBracket('e1', true)).ok).toBe(true);
    expect(playoffs()).toHaveLength(1);
  });

  it('redraws from the field as it is NOW, not the one the first draw saw', async () => {
    // The usual reason to redraw. A withdrawal between bracket_generated and
    // going live is not forfeited (participants.ts defers that to go-live
    // precisely so the draw can be regenerated without it), so the entry is
    // still sitting in the bracket until somebody redraws.
    seedField(4);
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    expect(store.db.tournament_matches!.filter((m) => m.round_number === 1)).toHaveLength(2);

    Object.assign(participant('p-3'), { status: 'withdrawn' });

    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);

    // Three left, so a 4-slot draw with one bye — and the withdrawn entry is in
    // none of it.
    const seeded = store.db.tournament_matches!.flatMap((m) => [m.participant_a_id, m.participant_b_id]);
    expect(seeded).not.toContain('p-3');
    expect(byes()).toHaveLength(1);
  });

  // ------------------------------------------------------------
  // REDRAWING A LIVE EVENT
  // ------------------------------------------------------------
  //
  // The owner pressed "Start Tournament" and the Regenerate button vanished
  // with no way back. Three of the four events sitting at `live` on staging
  // have nothing played at all, so this is the common live event and not a
  // corner of one.

  it('REDRAWS A LIVE EVENT AND LEAVES IT LIVE', async () => {
    // THE BUG THIS FEATURE WOULD HAVE SHIPPED WITH, and it is not in the guard.
    // Both generators ended with an unconditional
    // `.update({ status: 'bracket_generated' })`, which was the forward step
    // while the only caller was the check-in press. Reached from a live event
    // it becomes the only write in the console that sends an event BACKWARDS:
    // the header's primary button reverts from "Finalize Tournament" to "Start
    // Tournament", and pressing it re-runs the go-live forfeit sweep.
    // setEventStatus's transition table is forward-only precisely so that
    // cannot happen, and this went around it.
    seedField(5);
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    Object.assign(event(), { status: 'live' });
    const firstIds = store.db.tournament_matches!.map((m) => m.id);

    const res = await generateSingleEliminationBracket('e1', false);

    expect(res.ok).toBe(true);
    expect(event().status).toBe('live');
    // Genuinely rebuilt, not quietly skipped: every match is a new row.
    const secondIds = store.db.tournament_matches!.map((m) => m.id);
    expect(secondIds.some((id) => firstIds.includes(id))).toBe(false);
    // ...and the byes came back, so the guard did not mistake them for results
    // on the way through.
    expect(byes().length).toBeGreaterThan(0);
  });

  it('leaves a live round robin live too', async () => {
    // The same unconditional write sat at the bottom of the other generator.
    Object.assign(event(), { format: 'round_robin' });
    seedField(4);
    Object.assign(event(), { format: 'round_robin' });
    expect((await generateRoundRobinMatches('e1')).ok).toBe(true);
    Object.assign(event(), { status: 'live' });

    expect((await generateRoundRobinMatches('e1')).ok).toBe(true);

    expect(event().status).toBe('live');
  });

  it('still refuses a live event the moment anything has been played', async () => {
    // The status is not the authority — the match rows are. A live event with a
    // real result must refuse exactly as a bracket_generated one does, and
    // nothing may be deleted on the way to the refusal.
    seedField(4);
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    Object.assign(event(), { status: 'live' });
    const played = store.db.tournament_matches!.find((m) => m.round_number === 1)!;
    Object.assign(played, { status: 'completed', is_bye: false });
    const before = store.db.tournament_matches!.length;

    const res = await generateSingleEliminationBracket('e1', false);

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/1 match in this event has a result/);
    expect(store.db.tournament_matches!).toHaveLength(before);
    expect(event().status).toBe('live');
  });

  it('refuses a live event that has a WALKOVER, which the go-live sweep records', async () => {
    // A walkover is rated (recordWalkover -> applyTournamentMatchElo), so it is
    // a result in every sense that matters here even though nobody played. This
    // is the case the old "never at live" rule was written around, and it is
    // still refused — it is just no longer the reason to hide the button.
    seedField(4);
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    Object.assign(event(), { status: 'live' });
    const m = store.db.tournament_matches!.find((x) => x.round_number === 1)!;
    Object.assign(m, { status: 'walkover', is_bye: false });

    const res = await generateSingleEliminationBracket('e1', false);

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/1 match in this event has a result/);
  });

  /**
   * THE LIVE REDRAW THAT HAS REAL CONTENT, and the reason a partial redraw was
   * not built instead of this.
   *
   * An entrant with a first-round BYE withdraws once the event is live. The
   * forfeit sweep cannot settle them: their only open match is the round-two
   * one, whose other slot is still TBD, so forfeitOpenMatchesForEntry counts it
   * `unresolved` and writes nothing (there is nobody to award a walkover to).
   * The event is therefore live, has a withdrawal, and has NO result rows —
   * so the guard permits the redraw, and the redraw is the only thing that can
   * take them out of the bracket.
   *
   * A partial redraw — hold the played matches, reshuffle the rest — could not
   * have done this. It has to preserve the bracket's shape, so it can permute
   * entrants between open slots but cannot remove one; the withdrawn entry
   * would have stayed in the draw with a free pass to round two.
   */
  it('drops an entrant who withdrew from a LIVE event without leaving a result behind', async () => {
    // Five entries: an 8-slot draw, so the top seeds have byes.
    seedField(5);
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    Object.assign(event(), { status: 'live' });
    // The top seed — seeded first, so it is the one holding a bye.
    const bye = byes()[0]!;
    const withdrawing = (bye.participant_a_id ?? bye.participant_b_id) as string;
    Object.assign(participant(withdrawing), { status: 'withdrawn' });
    // No walkover was recorded: this is the state the sweep leaves behind.
    expect(store.db.tournament_matches!.some((m) => m.status === 'walkover')).toBe(false);

    const res = await generateSingleEliminationBracket('e1', false);

    expect(res.ok).toBe(true);
    expect(event().status).toBe('live');
    // Four left, so a 4-slot draw — and the withdrawn entry is nowhere in it.
    const seeded = store.db.tournament_matches!.flatMap((m) => [m.participant_a_id, m.participant_b_id]);
    expect(seeded).not.toContain(withdrawing);
    expect(store.db.tournament_matches!.filter((m) => m.round_number === 1)).toHaveLength(2);
    expect(byes()).toHaveLength(0);
  });

  /**
   * EVERY ENTRANT IS IN THE DRAW, whatever numbers they are carrying.
   *
   * The bug the test above uncovered. Seeds are never renumbered when somebody
   * leaves, and the placement loop looked entrants up BY STORED SEED against
   * getStandardSeedPositions, which only ever emits 1..bracketSize. Withdraw
   * the top seed of a 5-entry event and the survivors are seeds 2,3,4,5 in a
   * 4-slot draw: seed 5 was never looked up and that player disappeared from
   * their own event, seed 1 was looked up and found nothing and left a phantom
   * bye. Nothing anywhere said so — the draw simply had one fewer person in it.
   *
   * The assertion that matters is the FIELD, not the shape: every entry that is
   * still in the event appears exactly once in round one.
   */
  it('puts every remaining entrant in the draw when the seeds have holes in them', async () => {
    seedField(5);
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    // The TOP seed leaves, so the survivors are seeds 2,3,4,5 — every one of
    // them out of range of the 4-slot draw they now belong in except by rank.
    Object.assign(participant('p-0'), { status: 'withdrawn' });

    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);

    const drawn = store.db.tournament_matches!
      .filter((m) => m.round_number === 1)
      .flatMap((m) => [m.participant_a_id, m.participant_b_id])
      .filter((id): id is string => Boolean(id));
    expect(drawn.sort()).toEqual(['p-1', 'p-2', 'p-3', 'p-4']);
    // Four entrants in a 4-slot draw is no byes at all. The phantom bye was the
    // visible symptom of the missing player.
    expect(byes()).toHaveLength(0);
  });

  it('seats an entrant once when two entries share a seed number', async () => {
    // The mirror of the same defect: `.find` returns the first match for both
    // lookups, so one entrant took two slots and another took none. There is no
    // unique index on seed_number in either table and the seed cell is
    // hand-editable, so this is reachable without anything going wrong.
    seedField(4);
    Object.assign(participant('p-2'), { seed_number: 2 });

    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);

    const drawn = store.db.tournament_matches!
      .filter((m) => m.round_number === 1)
      .flatMap((m) => [m.participant_a_id, m.participant_b_id])
      .filter((id): id is string => Boolean(id));
    expect(drawn.sort()).toEqual(['p-0', 'p-1', 'p-2', 'p-3']);
  });

  it('seeds a hand-seeded field exactly where its seed numbers say', async () => {
    // MANUAL SEEDING IS THE ONE DRAW THAT IS NOT DRAWN. An exec who typed every
    // seed in by hand asked for the bracket those numbers describe and has to
    // keep getting it, redraw after redraw — so this is the one case where an
    // exact arrangement is still the right assertion.
    //
    // The standard positions themselves are pinned in draw-randomisation.test.ts
    // against getStandardSeedPositions directly, so exact placement stays
    // nailed down even if what `manual` means ever changes.
    seedField(8);
    Object.assign(event(), { seeding_method: 'manual' });

    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);

    const r1 = round1();
    expect(r1).toHaveLength(4);
    // Standard positions for an 8-draw: 1v8, 4v5 | 2v7, 3v6. Seeds 1 and 2 sit
    // in opposite halves and cannot meet before the final, which is the entire
    // point of seeding and the property a rank/seed mix-up would break.
    expect(r1.map((m) => [m.participant_a_id, m.participant_b_id])).toEqual([
      ['p-0', 'p-7'],
      ['p-3', 'p-4'],
      ['p-1', 'p-6'],
      ['p-2', 'p-5'],
    ]);
    // Said as the property, not just the arrangement: the top two seeds feed
    // different semi-finals.
    expect(halfOf(r1, 'p-0')).not.toBe(halfOf(r1, 'p-1'));

    // And it is still that draw the second time, which is what "manual" means.
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    expect(layout()).toEqual([
      'p-0/p-7', 'p-3/p-4', 'p-1/p-6', 'p-2/p-5',
    ]);
    const audit = store.db.tournament_audit_log!.filter((r) => r.action === 'bracket_generated').at(-1)!;
    expect((audit.details as Row).draw_randomised).toBe(false);
    expect((audit.details as Row).draw_seed).toBeNull();
  });

  /**
   * "REGENERATE DRAW DOESNT CHANGE ANYTHING" — the club owner's report, as a
   * test. It was true: placement was a pure function of the stored seeds
   * against getStandardSeedPositions, so the same field produced a
   * byte-identical bracket however many times the button was pressed. There was
   * nothing to see, and no way to tell that apart from the button being broken.
   */
  it('gives a different draw when an ordinary field is redrawn', async () => {
    seedField(8);
    const seen = new Set<string>();
    for (let i = 0; i < 30; i++) {
      expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
      seen.add(layout().join(' | '));
    }
    // An 8-draw has 48 possible draws (2 for seeds 3-4, 24 for seeds 5-8), so
    // 30 presses landing on one arrangement would take a 48^-29 coincidence.
    expect(seen.size).toBeGreaterThan(1);
  });

  /**
   * THE INVARIANT THE RANDOMISATION IS ALLOWED TO KEEP AND NOTHING ELSE: two
   * entrants of the same seeding tier can never meet before the round their
   * tier implies. Asserted through the real generator here, and over thousands
   * of draws against the placement itself in draw-randomisation.test.ts.
   */
  it('keeps the seeding tiers apart however the draw falls', async () => {
    seedField(8);
    for (let i = 0; i < 30; i++) {
      expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
      const r1 = round1();
      // Seeds 1 and 2 in opposite halves — they cannot meet before the final.
      expect(halfOf(r1, 'p-0')).not.toBe(halfOf(r1, 'p-1'));
      // Seeds 1-4 one per quarter — none of them can meet before the semis. In
      // an 8-draw a quarter IS a first-round match, so this says they are four
      // different matches.
      const quarters = ['p-0', 'p-1', 'p-2', 'p-3'].map((id) => quarterOf(r1, id));
      expect(new Set(quarters).size).toBe(4);
      // Everybody drawn, nobody drawn twice.
      const drawn = r1.flatMap((m) => [m.participant_a_id, m.participant_b_id]);
      expect([...drawn].sort()).toEqual(['p-0', 'p-1', 'p-2', 'p-3', 'p-4', 'p-5', 'p-6', 'p-7']);
    }
  });

  /**
   * BYES STAY WITH THE TOP OF THE FIELD ON EVERY REDRAW.
   *
   * The draw shuffles ENTRANTS inside a tier, not rank slots between positions,
   * and this is the difference. A 5-entry field leaves ranks 6, 7 and 8 of an
   * 8-draw empty; shuffling slots could have moved an empty rank up into the
   * 5-8 band and handed seed 4 a bye while seed 1 played, which is not a draw,
   * it is a favour. Seeds 1 and 2 hold a bye every time, the third goes to one
   * of the 3-4 tier — that one IS the draw's business, because a tier is by
   * definition a set the draw treats as interchangeable — and seed 5 never has
   * one.
   */
  it('leaves the byes with the top of the field on every redraw', async () => {
    seedField(5);
    const thirdByeWentTo = new Set<string>();
    for (let i = 0; i < 30; i++) {
      expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
      const withBye = byes()
        .map((m) => (m.participant_a_id ?? m.participant_b_id) as string)
        .sort();
      expect(withBye).toHaveLength(3);
      expect(withBye).toContain('p-0');
      expect(withBye).toContain('p-1');
      expect(withBye).not.toContain('p-4');
      thirdByeWentTo.add(withBye.find((id) => id !== 'p-0' && id !== 'p-1')!);
    }
    // Only ever a member of the 3-4 tier.
    expect([...thirdByeWentTo].sort().every((id) => id === 'p-2' || id === 'p-3')).toBe(true);
  });

  /**
   * A DRAW THAT CAN BE EXPLAINED. "It was random" is not an answer to a player
   * asking why they landed in the top seed's half, so the seed the draw was
   * made from goes into the bracket_generated audit row — no column, no
   * migration, and re-drawing from it reproduces the identical bracket.
   */
  it('records the seed it drew from, and that seed reproduces the bracket', async () => {
    seedField(8);
    // newDrawSeed is the only entropy in the feature, so pinning Math.random
    // pins the draw — which is exactly the claim being tested.
    const rand = vi.spyOn(Math, 'random').mockReturnValue(0.4242);

    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    const first = layout();
    const audit = store.db.tournament_audit_log!.filter((r) => r.action === 'bracket_generated').at(-1)!;
    const seed = (audit.details as Row).draw_seed;
    expect((audit.details as Row).draw_randomised).toBe(true);
    expect(typeof seed).toBe('number');
    expect(seed).toBe(Math.floor(0.4242 * 4294967296));

    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    expect(layout()).toEqual(first);

    // And an unpinned redraw is free to differ again.
    rand.mockRestore();
  });

  /**
   * THE OPT-OUT HAS TO BE REACHABLE WHEN THE EXEC WANTS IT, and that is after a
   * draw exists — not before.
   *
   * An exec hand-sets every seed, generates, and sees a draw that does not match
   * their numbers. `seeding_method = 'manual'` is the answer, and until now
   * updateTournamentEvent refused ANY update once matches existed: the remedy on
   * offer was "void the matches first", which is the very thing they were trying
   * not to do twice. The seeding method is not a format — nothing about the
   * matches that exist depends on it, and it is read once, by the NEXT draw.
   */
  it('lets the seeding method be switched to manual after a draw exists, and then honours it', async () => {
    seedField(8);
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    Object.assign(event(), { status: 'live' });

    // On its own, past both gates: matches exist and the event is running.
    expect((await updateTournamentEvent('e1', { seeding_method: 'manual' })).ok).toBe(true);
    expect(event().seeding_method).toBe('manual');

    // And every draw from here is the one the seed numbers describe.
    const layouts = new Set<string>();
    for (let i = 0; i < 10; i++) {
      expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
      layouts.add(layout().join(' | '));
    }
    expect([...layouts]).toEqual(['p-0/p-7 | p-3/p-4 | p-1/p-6 | p-2/p-5']);
  });

  it('still refuses a format change once a draw exists, and a bundled one', async () => {
    // The gate the carve-out has to leave standing. A match format the draw has
    // already been played under must not move, and the seeding method must not
    // become a way of smuggling one past — hence "on its own" and not "contains".
    seedField(8);
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);

    const alone = await updateTournamentEvent('e1', { match_format: 'one_game_21' });
    expect(alone.ok).toBe(false);
    expect(alone.ok ? '' : alone.error).toContain('already has a draw');

    const bundled = await updateTournamentEvent('e1', {
      seeding_method: 'manual', match_format: 'one_game_21',
    });
    expect(bundled.ok).toBe(false);
    expect(bundled.ok ? '' : bundled.error).toContain('already has a draw');
    expect(event().seeding_method).toBeUndefined();
    expect(event().match_format).toBe('best_of_3_to_21');
  });

  it('refuses to change how the draw is made once the event is finalised', async () => {
    // A finalised event's draw can never be rebuilt (assertNotFinalised), so a
    // setting that only the next draw would read has no next draw to read it.
    seedField(8);
    Object.assign(event(), { status: 'completed' });

    const res = await updateTournamentEvent('e1', { seeding_method: 'manual' });

    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.error).toContain('finalised');
    expect(event().seeding_method).toBeUndefined();
  });

  /**
   * A POOL-SEEDED DRAW IS NOT REDRAWN, and that is deliberate rather than an
   * oversight. buildFieldFromPool refuses a half-played pool precisely so the
   * bracket matches what everyone just played for; drawing the qualifiers again
   * would put the pool's third finisher into the second seed's half on a coin
   * flip, which is the outcome pool seeding exists to prevent. There is no
   * seeding_method opt-out on that path, so the path itself is the rule.
   */
  it('does not redraw a pool-seeded event', async () => {
    store.db.tournament_events!.push({
      id: 'e0', tournament_id: 't1', status: 'completed', event_type: 'mens_singles',
      format: 'round_robin', match_format: 'best_of_3_to_21', elo_multiplier: 1,
      placement_bonus_enabled: false,
    });
    Object.assign(event(), {
      status: 'checkin', draw_locked: false,
      seeded_from_event_id: 'e0', seed_by: 'wins', max_participants: 4,
    });
    const pool = ['a', 'b', 'c', 'd'];
    store.db.tournament_participants = pool.map((k, i) => ({
      id: `q-${k}`, event_id: 'e0', player_id: `pl-${k}`, elo_before: 1200,
      elo_after: 1200 + (3 - i) * 10, elo_change: null, seed_number: null,
      final_position: null, points: null, status: 'checked_in',
    }));
    let n = 0;
    store.db.tournament_matches = [];
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        store.db.tournament_matches.push({
          id: `pm-${++n}`, event_id: 'e0', status: 'completed', is_bye: false,
          is_third_place: false, round_number: 1, bracket_position: n,
          participant_a_id: `q-${pool[i]}`, participant_b_id: `q-${pool[j]}`,
          winner_participant_id: `q-${pool[i]}`, loser_participant_id: `q-${pool[j]}`,
          winner_to_match_id: null, winner_to_position: null,
          scores: [{ a: 21, b: 10 }, { a: 21, b: 12 }], elo_snapshot: null, notes: null,
        });
      }
    }

    const layouts = new Set<string>();
    for (let i = 0; i < 20; i++) {
      expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
      layouts.add(
        store.db.tournament_matches!
          .filter((m) => m.event_id === 'e1' && m.round_number === 1)
          .sort((a, b) => (a.bracket_position as number) - (b.bracket_position as number))
          .map((m) => `${m.participant_a_id}/${m.participant_b_id}`)
          .join(' | '),
      );
    }
    // One arrangement over twenty draws: the pool's finishing order, every time.
    expect(layouts.size).toBe(1);
    const audit = store.db.tournament_audit_log!.filter((r) => r.action === 'bracket_generated').at(-1)!;
    expect((audit.details as Row).draw_randomised).toBe(false);
    expect((audit.details as Row).draw_seed).toBeNull();
  });

  it('does not treat a VOIDED match as something that was played', async () => {
    // Voiding takes the result and its Elo back off (voidMatch -> reverse
    // snapshot), so a voided match is history that no longer counts. It is the
    // remedy the refusal above points the exec at, and it has to actually work.
    seedField(4);
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    Object.assign(event(), { status: 'live' });
    const m = store.db.tournament_matches!.find((x) => x.round_number === 1)!;
    Object.assign(m, { status: 'voided', is_bye: false });

    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    expect(event().status).toBe('live');
  });

  /**
   * A POOL-SEEDED EVENT'S FIELD ARRIVES AT GENERATION, so regenerating one runs
   * the promotion a second time. buildFieldFromPool inserts a qualifier only
   * when it is not already entered here — `existing`, keyed by player id (or an
   * order-independent pair key) — and the whole point of that lookup is this
   * case. Reading the code says it holds; this makes it a fact, because a
   * duplicate promotion would enter the same person twice, hand them two slots
   * in the draw, and be invisible until somebody counted the entry list.
   */
  it('promotes each pool qualifier ONCE, however many times the draw is redone', async () => {
    // A finished 4-player pool ('e0'), and a bracket that seeds from it ('e1')
    // with nobody entered yet — the shape the feature exists for.
    store.db.tournament_events!.push({
      id: 'e0', tournament_id: 't1', status: 'completed', event_type: 'mens_singles',
      format: 'round_robin', match_format: 'best_of_3_to_21', elo_multiplier: 1,
      placement_bonus_enabled: false,
    });
    Object.assign(event(), {
      status: 'checkin', draw_locked: false,
      seeded_from_event_id: 'e0', seed_by: 'wins', max_participants: 4,
    });
    const pool = ['a', 'b', 'c', 'd'];
    store.db.tournament_participants = pool.map((k, i) => ({
      id: `q-${k}`, event_id: 'e0', player_id: `pl-${k}`, elo_before: 1200,
      elo_after: 1200 + (3 - i) * 10, elo_change: null, seed_number: null,
      final_position: null, points: null, status: 'checked_in',
    }));
    // Every pairing played, decided in entry order so the standings are a
    // strict a > b > c > d. buildFieldFromPool refuses a half-finished pool, so
    // nothing may be left pending.
    let n = 0;
    store.db.tournament_matches = [];
    for (let i = 0; i < pool.length; i++) {
      for (let j = i + 1; j < pool.length; j++) {
        store.db.tournament_matches.push({
          id: `pm-${++n}`, event_id: 'e0', status: 'completed', is_bye: false,
          is_third_place: false, round_number: 1, bracket_position: n,
          participant_a_id: `q-${pool[i]}`, participant_b_id: `q-${pool[j]}`,
          winner_participant_id: `q-${pool[i]}`, loser_participant_id: `q-${pool[j]}`,
          winner_to_match_id: null, winner_to_position: null,
          scores: [{ a: 21, b: 10 }, { a: 21, b: 12 }], elo_snapshot: null, notes: null,
        });
      }
    }

    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    const afterFirst = store.db.tournament_participants!.filter((p) => p.event_id === 'e1');
    expect(afterFirst).toHaveLength(4);
    // Promoted in the pool's finishing order — the whole reason this path skips
    // the Elo re-sort.
    expect(afterFirst.map((p) => p.player_id)).toEqual(['pl-a', 'pl-b', 'pl-c', 'pl-d']);

    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);

    const afterSecond = store.db.tournament_participants!.filter((p) => p.event_id === 'e1');
    // The assertion. Four qualifiers, four entries, twice.
    expect(afterSecond).toHaveLength(4);
    expect(afterSecond.map((p) => p.id).sort()).toEqual(afterFirst.map((p) => p.id).sort());
    // And the redrawn bracket is a real 4-draw over exactly those entries.
    const drawn = store.db.tournament_matches!
      .filter((m) => m.event_id === 'e1' && m.round_number === 1)
      .flatMap((m) => [m.participant_a_id, m.participant_b_id]);
    expect(drawn.filter(Boolean).sort()).toEqual(afterSecond.map((p) => p.id).sort());
  });
});

// ============================================================
// Seeds that skip the first round (00124)
// ============================================================
//
// WHAT THIS SETTING IS, because the name says something the arithmetic cannot
// deliver and a test suite that assumed otherwise would be asserting fiction.
//
// A bracket holds a power of two. A field of E leaves nextPowerOf2(E) - E slots
// empty, and an empty slot facing a real entrant IS a bye — byes are left over,
// not created. getStandardSeedPositions pairs draw-rank r against rank B+1-r, so
// the empty TAIL ranks fall opposite the TOP seeds. The byes therefore already
// go to the top seeds in seed order, which the redraw test above
// ("leaves the byes with the top of the field on every redraw") has asserted
// since long before this feature existed.
//
// And there is no larger bracket to escape into: a round-one match with two
// empty slots is not a match, so B - E <= B/2, so B <= 2E, and the only power of
// two in [E, 2E] besides nextPowerOf2(E) is 2E itself — reachable only when E is
// already a power of two, where it makes EVERY round-one match a bye.
//
// So seed_skip_count places nothing. It is a FLOOR the generator refuses to
// build under, and these tests are about the refusal and about the fact that it
// changed no draw that used to work.
describe('seeds that skip the first round', () => {
  function seedField(n: number) {
    store.db.tournament_matches = [];
    store.db.tournament_participants = Array.from({ length: n }, (_, i) => ({
      id: `p-${i}`, event_id: 'e1', player_id: `pl-${i}`, elo_before: 1500 - i * 10,
      elo_after: null, elo_change: null, seed_number: i + 1,
      final_position: null, points: null, status: 'checked_in',
    }));
    Object.assign(event(), { status: 'checkin', draw_locked: false });
  }
  const byes = () => store.db.tournament_matches!.filter((m) => m.is_bye);
  const withByes = () => byes()
    .map((m) => (m.participant_a_id ?? m.participant_b_id) as string)
    .sort((a, b) => Number(a.slice(2)) - Number(b.slice(2)));

  /**
   * THE CEILING, AS ARITHMETIC, BEFORE ANY OF IT TOUCHES A DATABASE.
   *
   * These numbers are the whole feature: they are what the form shows, what the
   * refusal names, and the reason "exactly N" was not an option. A power-of-two
   * field gives NOBODY a bye — 14 players producing 7 winners plus 2 skippers is
   * 9 entrants for an 8-slot round two — and no setting can change that.
   */
  it('derives the ceiling from the field size and nothing else', () => {
    // Exact powers of two: the field fills the bracket, so there is no spare
    // slot and no bye, at any size.
    for (const exact of [2, 4, 8, 16, 32, 64, 128]) {
      expect(maxFirstRoundByes(exact)).toBe(0);
    }
    // The awkward counts.
    expect(maxFirstRoundByes(12)).toBe(4);    // 16-draw
    expect(maxFirstRoundByes(20)).toBe(12);   // 32-draw
    expect(maxFirstRoundByes(33)).toBe(31);   // 64-draw, one real round-one match
    expect(maxFirstRoundByes(100)).toBe(28);  // the 128-draw from the brief
    expect(maxFirstRoundByes(5)).toBe(3);
    // Below a draw at all. Nothing skips, and nothing throws.
    expect(maxFirstRoundByes(1)).toBe(0);
    expect(maxFirstRoundByes(0)).toBe(0);
    // A ceiling of B/2 - 1 is the most any field can reach, which is what makes
    // 64 a schema bound rather than a real one: reaching it needs 192 entrants.
    expect(maxFirstRoundByes(nextPowerOf2(33) / 2 + 1)).toBe(nextPowerOf2(33) / 2 - 1);
  });

  it('changes nothing at all when it is left at the default', async () => {
    // THE ONE THAT MATTERS MOST. Every event that exists takes 0 from 00124's
    // default, so a draw that worked yesterday has to be byte-identical today.
    // Pinned through Math.random, the only entropy in the feature, so the two
    // draws are comparable at all.
    const rand = vi.spyOn(Math, 'random').mockReturnValue(0.31415);
    seedField(20);

    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    const before = store.db.tournament_matches!
      .map((m) => `${m.round_number}:${m.bracket_position}:${m.participant_a_id}/${m.participant_b_id}:${m.is_bye}`)
      .join('|');
    // 20 entries in a 32-draw: 12 byes, already on the top 12 seeds, with nobody
    // having asked for any of them.
    expect(byes()).toHaveLength(12);

    // Explicitly zero rather than absent — the column is NOT NULL, so this is
    // what every row actually holds.
    Object.assign(event(), { seed_skip_count: 0 });
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    const after = store.db.tournament_matches!
      .map((m) => `${m.round_number}:${m.bracket_position}:${m.participant_a_id}/${m.participant_b_id}:${m.is_bye}`)
      .join('|');

    expect(after).toBe(before);
    rand.mockRestore();
  });

  it('generates when the field can keep the promise, and the promised seeds are the ones with byes', async () => {
    // 12 in a 16-draw is 4 byes; promise 4 and the ceiling is met exactly.
    seedField(12);
    Object.assign(event(), { seed_skip_count: 4 });

    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);

    // The four byes are seeds 1-4, in seed order, and nobody else has one.
    expect(withByes()).toEqual(['p-0', 'p-1', 'p-2', 'p-3']);
    // And they really do enter at round two: a bye is completed with its holder
    // as the winner and already advanced.
    for (const b of byes()) {
      expect(b.status).toBe('completed');
      expect(b.round_number).toBe(1);
      const next = store.db.tournament_matches!.find((m) => m.id === b.winner_to_match_id)!;
      expect(next.round_number).toBe(2);
      expect([next.participant_a_id, next.participant_b_id]).toContain(b.winner_participant_id);
    }
  });

  it('is a FLOOR: a field that forces more byes still generates, and the surplus goes down the seed order', async () => {
    // The reason it is not "exactly N". 20 entrants force 12 byes; an exec who
    // promised the top 4 has kept that promise three times over, and refusing a
    // draw for being too generous would be absurd. The surplus goes down the
    // order to seeds 5, 6, 7 … exactly as it did before this feature existed.
    //
    // "DOWN THE ORDER" MEANS DOWN THE RANKS, NOT DOWN THE SEED NUMBERS, and the
    // difference is the draw. Byes fall on ranks 1..12 of a 32-draw; the tiers
    // are [1],[2],[3,4],[5,8],[9,16],[17,20], so ranks 1-8 are seeds 1-8 every
    // time — those tiers sit wholly inside the byes — while ranks 9-12 are four
    // of the eight entrants of the 9-16 tier, drawn between themselves. A tier
    // is by definition a set the draw treats as interchangeable, which is the
    // same reasoning the redraw test above states for the third bye of a
    // 5-entry field. Seeds 17-20 can never hold one.
    seedField(20);
    Object.assign(event(), { seed_skip_count: 4 });

    for (let i = 0; i < 20; i++) {
      store.db.tournament_matches = [];
      expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);

      const holders = withByes();
      expect(holders).toHaveLength(12);
      // The promise, kept: the top four always skip.
      expect(holders.slice(0, 4)).toEqual(['p-0', 'p-1', 'p-2', 'p-3']);
      // The surplus that the tiers pin exactly.
      expect(holders.slice(0, 8)).toEqual(Array.from({ length: 8 }, (_, k) => `p-${k}`));
      // The four that are the draw's business come from the 9-16 tier and
      // nowhere else — never from the entrants below it.
      const rest = holders.slice(8).map((id) => Number(id.slice(2)));
      expect(rest).toHaveLength(4);
      expect(rest.every((n) => n >= 8 && n <= 15)).toBe(true);
    }
  });

  /**
   * THE PROMISE IS ABOUT SEEDS AND THE BYES ARE ABOUT RANKS, AND UNTIL THIS
   * TEST EXISTED THE GENERATOR ONLY CHECKED THE SECOND.
   *
   * The ceiling check counts byes — nextPowerOf2(E) - E — and stops. It never
   * asked whether the promised seeds are the ones who GET them, and the draw is
   * free to say otherwise: drawWithinTiers shuffles entrants inside their
   * seeding band, so rank r holds some member of r's band rather than seed r.
   * The two agree only when the promise ends on a band boundary.
   *
   * 20 entrants promising 9 is the case a club can actually reach. Bands are
   * [1],[2],[3,4],[5,8],[9,16],[17,20] and the byes are ranks 1-12, so the
   * [9,16] band straddles the bye line: before the fix, seeds 13-16 could take
   * bye ranks 9-12 while four seeds who had been promised a skip played round
   * one. The count check passed the whole time — 9 <= 12.
   *
   * ASSERTED OVER UNPINNED REDRAWS, and asserting TWO things, because "stop
   * shuffling entirely" would satisfy the first on its own. Math.random is left
   * alone so every iteration is a genuinely different draw (the pinned
   * mockReturnValue fixtures elsewhere prove reproducibility, which is the
   * opposite property and useless here).
   */
  it('keeps the promise when it lands mid-tier, without freezing the rest of the draw', async () => {
    seedField(20);
    Object.assign(event(), { seed_skip_count: 9 });

    const surplus = new Set<string>();
    for (let i = 0; i < 40; i++) {
      store.db.tournament_matches = [];
      expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);

      const holders = withByes();
      expect(holders).toHaveLength(12);
      // THE PROMISE. The nine seeds who were promised a skip have one, every
      // single time — not eight of them and a tier-mate.
      expect(holders.slice(0, 9)).toEqual(Array.from({ length: 9 }, (_, k) => `p-${k}`));
      // The three surplus byes are still the draw's business: they come out of
      // what is left of the 9-16 band, ranks 10-12, and never from below it.
      const rest = holders.slice(9).map((id) => Number(id.slice(2)));
      expect(rest).toHaveLength(3);
      expect(rest.every((n) => n >= 9 && n <= 15)).toBe(true);
      surplus.add(rest.join(','));
    }

    // AND THE DRAW IS STILL A DRAW. Reserving the promised prefix cuts one
    // band in two; it does not stop the shuffle, and a fix that did would pass
    // every assertion above.
    expect(surplus.size).toBeGreaterThan(1);
  });

  it('keeps a promise that splits the smallest straddling tier', async () => {
    // The minimal case, and the one the existing redraw test above already
    // showed the mechanism for: a 5-entry field has 3 byes and a [3,4] band, so
    // "the top 3 skip" was accepted and then broken whenever the shuffle put
    // seed 4 at rank 3. That test collects the third bye holder over 30 redraws
    // and finds BOTH p-2 and p-3 — at seed_skip_count 0, which is correct,
    // because a tier is interchangeable until somebody promises otherwise.
    seedField(5);
    Object.assign(event(), { seed_skip_count: 3 });

    for (let i = 0; i < 30; i++) {
      store.db.tournament_matches = [];
      expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
      expect(withByes()).toEqual(['p-0', 'p-1', 'p-2']);
    }
  });

  it('leaves the tier interchangeable again the moment the promise stops at the boundary', async () => {
    // The reserve must bite ONLY where the promise needs it. A promise of 2 on
    // the same 5-entry field ends on a band boundary, so [3,4] is left whole
    // and the third bye is a coin flip exactly as it is at 0 — which is the
    // behaviour the draw was designed for and must not be lost to a fix that
    // over-reserves.
    seedField(5);
    Object.assign(event(), { seed_skip_count: 2 });

    const third = new Set<string>();
    for (let i = 0; i < 30; i++) {
      store.db.tournament_matches = [];
      expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
      const holders = withByes();
      expect(holders.slice(0, 2)).toEqual(['p-0', 'p-1']);
      third.add(holders[2]!);
    }
    expect([...third].sort()).toEqual(['p-2', 'p-3']);
  });

  it('refuses a promise the field cannot keep, and names the number it can', async () => {
    // 33 in a 64-draw gives 31 byes; 40 is past the ceiling. The refusal has to
    // carry the number, because "it did not work" on the morning of a tournament
    // is not something an exec can act on.
    seedField(33);
    Object.assign(event(), { seed_skip_count: 40 });

    const res = await generateSingleEliminationBracket('e1', false);

    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.error).toContain('top 40 seeds');
    expect(res.ok ? '' : res.error).toContain('64-slot draw');
    expect(res.ok ? '' : res.error).toContain('only 31');
    expect(res.ok ? '' : res.error).toContain('31 or fewer');
  });

  it('refuses on a power-of-two field, where no seed can skip at all', async () => {
    // The case the club will hit first, and the one the arithmetic is least
    // forgiving about: 16 entrants fill a 16-draw exactly, so there is not one
    // spare slot to be a bye. The message must say that rather than implying a
    // smaller number would have worked.
    seedField(16);
    Object.assign(event(), { seed_skip_count: 2 });

    const res = await generateSingleEliminationBracket('e1', false);

    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.error).toContain('no byes at all');
    expect(res.ok ? '' : res.error).toContain('Lower "Seeds Skipping Round One" to 0');
  });

  it('refuses BEFORE it writes anything, so a failed generation leaves the draw and the seeds alone', async () => {
    // A refusal that landed after the auto-seed writes or after
    // deletePhaseMatches would leave an exec with a half-changed event and an
    // error on screen. The check sits immediately after the field is read, and
    // this is what says so.
    seedField(16);
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    const drawBefore = store.db.tournament_matches!.map((m) => m.id).sort();
    expect(drawBefore.length).toBeGreaterThan(0);

    Object.assign(event(), { seed_skip_count: 2 });
    const res = await generateSingleEliminationBracket('e1', false);

    expect(res.ok).toBe(false);
    // Every match still there, and the same rows — not deleted and rebuilt.
    expect(store.db.tournament_matches!.map((m) => m.id).sort()).toEqual(drawBefore);
    // No bracket_generated audit row for the attempt that refused.
    expect(store.db.tournament_audit_log!.filter((r) => r.action === 'bracket_generated')).toHaveLength(1);
  });

  it('records the promise next to the byes in the audit row', async () => {
    seedField(12);
    Object.assign(event(), { seed_skip_count: 3 });

    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);

    const audit = store.db.tournament_audit_log!.filter((r) => r.action === 'bracket_generated').at(-1)!;
    expect((audit.details as Row).seed_skip_promised).toBe(3);
    expect((audit.details as Row).byes).toBe(4);
  });

  // ------------------------------------------------------------
  // Setting the number
  // ------------------------------------------------------------

  it('is frozen once a draw exists, and says why rather than ignoring the field', async () => {
    // The same gate that freezes the match format. It is NOT given the
    // seeding_method carve-out: that exemption exists for a setting the next
    // draw reads and this draw does not depend on, whereas the only bracket this
    // number could describe is the one that already exists, whose byes are
    // already dealt.
    seedField(12);
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);

    const res = await updateTournamentEvent('e1', { seed_skip_count: 4 });

    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.error).toContain('already has a draw');
    expect(event().seed_skip_count).toBeUndefined();

    // And it cannot be smuggled past on the back of the one setting that IS
    // exempt — that carve-out is "seeding_method on its own", not "contains".
    const bundled = await updateTournamentEvent('e1', { seeding_method: 'manual', seed_skip_count: 4 });
    expect(bundled.ok).toBe(false);
    expect(bundled.ok ? '' : bundled.error).toContain('already has a draw');
    expect(event().seed_skip_count).toBeUndefined();
  });

  it('accepts the number before a draw exists', async () => {
    seedField(12);

    expect((await updateTournamentEvent('e1', { seed_skip_count: 4 })).ok).toBe(true);
    expect(event().seed_skip_count).toBe(4);
  });

  it('does NOT refuse a number the CURRENT field cannot absorb', async () => {
    // Deliberate, and the same call normalizeGroupShape makes for
    // qualifiers_per_group. The number is set while registration is open — an
    // exec planning a sixty-strong event with three people signed up must not be
    // refused. The generator asks the field-dependent question on the day.
    seedField(3);

    expect((await updateTournamentEvent('e1', { seed_skip_count: 12 })).ok).toBe(true);
    expect(event().seed_skip_count).toBe(12);
  });

  it('refuses a number outside the bounds the schema allows', async () => {
    seedField(12);

    const tooBig = await updateTournamentEvent('e1', { seed_skip_count: 65 });
    expect(tooBig.ok).toBe(false);
    expect(tooBig.ok ? '' : tooBig.error).toContain('between 0 and 64');

    const negative = await updateTournamentEvent('e1', { seed_skip_count: -1 });
    expect(negative.ok).toBe(false);
    expect(negative.ok ? '' : negative.error).toContain('between 0 and 64');

    expect(event().seed_skip_count).toBeUndefined();
  });

  it('refuses a non-zero number on a round robin, which has no first round to skip', async () => {
    seedField(12);
    Object.assign(event(), { format: 'round_robin' });

    const res = await updateTournamentEvent('e1', { seed_skip_count: 2 });

    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.error).toContain('no first round to skip');
    expect(event().seed_skip_count).toBeUndefined();

    // Zero is always fine, on any format — it is what every row already holds.
    expect((await updateTournamentEvent('e1', { seed_skip_count: 0 })).ok).toBe(true);
    expect(event().seed_skip_count).toBe(0);
  });

  /**
   * THE FORM'S OWN PAYLOAD, not a hand-made patch — same reasoning as the
   * seed_by test above. Whether an exec's number reaches the column depends on
   * toFormatPayload and normalizeSeedSkip agreeing about which formats the
   * control means anything on, and that agreement is exactly where the "Rank The
   * Pool By" defect lived.
   */
  it('sends the number the form collected, on the formats that have a bracket', () => {
    for (const format of ['single_elimination', 'pool_to_bracket']) {
      expect(
        toFormatPayload({ ...EMPTY_FORMAT_VALUES, seedSkip: '4' }, format).seed_skip_count,
      ).toBe(4);
    }
    // A round robin has no bracket. The form hides the control there, and the
    // payload sends 0 rather than omitting it — so a number typed on a knockout
    // and then switched away cannot be left behind on the row for 00124's CHECK
    // to reject on save.
    expect(
      toFormatPayload({ ...EMPTY_FORMAT_VALUES, seedSkip: '4' }, 'round_robin').seed_skip_count,
    ).toBe(0);
    // Blank is the default and means nobody skips.
    expect(
      toFormatPayload(EMPTY_FORMAT_VALUES, 'single_elimination').seed_skip_count,
    ).toBe(0);
  });

  it('round-trips the form payload through the server onto the column', async () => {
    seedField(12);

    const res = await updateTournamentEvent(
      'e1',
      toFormatPayload({ ...EMPTY_FORMAT_VALUES, seedSkip: '3' }, 'single_elimination'),
    );

    expect(res.ok).toBe(true);
    expect(event().seed_skip_count).toBe(3);
    // And the draw the exec then generates is the one that number describes.
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    expect(withByes()).toEqual(['p-0', 'p-1', 'p-2', 'p-3']);
  });

  it('works the same for a doubles field, where the seeds live on the pairs', async () => {
    // seed_number is carried by tournament_pairs as well as
    // tournament_participants, and the generator picks a table and treats the
    // rest identically — so the promise has to hold on both.
    store.db.tournament_matches = [];
    store.db.tournament_participants = [];
    store.db.tournament_pairs = Array.from({ length: 12 }, (_, i) => ({
      id: `pr-${i}`, event_id: 'e1', player_a_id: `pl-a${i}`, player_b_id: `pl-b${i}`,
      combined_elo: 3000 - i * 10, seed_number: i + 1, status: 'checked_in',
      final_position: null, points: null,
    }));
    Object.assign(event(), {
      status: 'checkin', draw_locked: false, event_type: 'mens_doubles', seed_skip_count: 4,
    });

    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);

    const holders = byes()
      .map((m) => (m.pair_a_id ?? m.pair_b_id) as string)
      .sort((a, b) => Number(a.slice(3)) - Number(b.slice(3)));
    expect(holders).toEqual(['pr-0', 'pr-1', 'pr-2', 'pr-3']);

    // And a promise the doubles field cannot keep is refused the same way.
    store.db.tournament_matches = [];
    Object.assign(event(), { seed_skip_count: 8 });
    const res = await generateSingleEliminationBracket('e1', false);
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.error).toContain('only 4');
  });
});

// ============================================================
// How hard an event moves ratings
// ============================================================
//
// elo_multiplier was accepted by updateTournamentEvent and sent by NO form, so
// it was set once at creation and then unreachable for the event's whole life.
// Event Settings sends it now. Two things have to hold: an exec can change it
// while the event is still editable, and they cannot change it underneath a
// draw that has already started rating matches.
describe('the event Elo multiplier', () => {
  function editableEvent() {
    store.db.tournament_matches = [];
    store.db.tournament_participants = [];
    Object.assign(event(), { status: 'registration', draw_locked: false, elo_multiplier: 1.25 });
  }

  it('can be changed while the event is still editable', () => {
    editableEvent();
    return updateTournamentEvent('e1', { elo_multiplier: 0.5 }).then((res) => {
      expect(res.ok).toBe(true);
      expect(event().elo_multiplier).toBe(0.5);
    });
  });

  // THE RULING, AS A TEST. The multiplier is read once per RESULT rather than
  // stamped on the draw, so it is tempting to exempt it from the gate the way
  // seeding_method is exempt. It is not exempted: elo_snapshot records the
  // delta and NOT the multiplier that produced it, so an event whose early
  // rounds were rated at 1.25 and whose later ones take 0.5 has no record of
  // which was which — while the console prints the round weights from the
  // event's CURRENT value, so the earlier rounds would display a figure never
  // applied to them.
  it('is frozen once a draw exists, and says why rather than ignoring the field', async () => {
    editableEvent();
    store.db.tournament_matches = [{
      id: 'm1', event_id: 'e1', round_number: 1, match_number: 1, status: 'pending',
      is_bye: false, scores: null, elo_snapshot: null,
    } as Row];

    const res = await updateTournamentEvent('e1', { elo_multiplier: 0.5 });

    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.error).toContain('already has a draw');
    expect(event().elo_multiplier).toBe(1.25);

    // And it cannot ride in on the one setting that IS exempt — that carve-out
    // is "seeding_method on its own", not "contains seeding_method".
    const bundled = await updateTournamentEvent('e1', { seeding_method: 'manual', elo_multiplier: 0.5 });
    expect(bundled.ok).toBe(false);
    expect(event().elo_multiplier).toBe(1.25);
  });

  // The column is DECIMAL(4,2) with NO CHECK constraint, and eventEloMultiplier
  // is `Number(raw) || 1.25` — deliberately faithful to the rating path rather
  // than defensive. Every refusal below is therefore the ONLY thing standing
  // between a typo and a rated draw.
  it('refuses 0, which does not mean what it looks like it means', async () => {
    editableEvent();
    const res = await updateTournamentEvent('e1', { elo_multiplier: 0 });
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.error).toContain('does not make an event unrated');
    expect(event().elo_multiplier).toBe(1.25);
  });

  it('refuses a negative, which would hand every loser rating', async () => {
    editableEvent();
    const res = await updateTournamentEvent('e1', { elo_multiplier: -1 });
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.error).toContain('cannot be negative');
    expect(event().elo_multiplier).toBe(1.25);
  });

  it('refuses a slipped decimal point', async () => {
    editableEvent();
    // 125 for 1.25. The column would store it without complaint and every
    // rating change in the draw would be multiplied by a hundred.
    const res = await updateTournamentEvent('e1', { elo_multiplier: 125 });
    expect(res.ok).toBe(false);
    expect(res.ok ? '' : res.error).toContain('must be between');
    expect(event().elo_multiplier).toBe(1.25);
  });

  it('rounds to the column’s own scale rather than refusing a third decimal', async () => {
    editableEvent();
    expect((await updateTournamentEvent('e1', { elo_multiplier: 1.259 })).ok).toBe(true);
    // DECIMAL(4,2) would round on the way in anyway; rounding here means the
    // number the exec is shown is the number that lands.
    expect(event().elo_multiplier).toBe(1.26);
  });

  it('leaves a stored weight alone when no value is sent', async () => {
    editableEvent();
    Object.assign(event(), { elo_multiplier: 0.75 });

    // The settings dialog omits the key when its box is empty rather than
    // sending NaN, and an omitted key must not reset the column to the default.
    expect((await updateTournamentEvent('e1', { max_participants: 16 })).ok).toBe(true);
    expect(event().elo_multiplier).toBe(0.75);
  });
});

// ============================================================
// Group stage (00106)
// ============================================================
//
// THE PURE HALF IS TESTED WITHOUT A DATABASE (group-draw.test.ts, and
// group-stage.test.ts in shared). What only the generator can be wrong about is
// what it WRITES, and there are exactly two things:
//
//   1. bracket_position. 00081 put a UNIQUE index on
//      (event_id, round_number, bracket_position) WHERE NOT is_third_place, and
//      running the circle method per group means Round 1 of group B is inserted
//      after Round 1 of group A into the same round number. A per-group counter
//      starting at 0 would collide on group B's very first fixture — as a
//      Postgres unique violation, mid-generation, after group A's matches are
//      already in the table, on the day. The inserts here discard their return
//      value (as they did before 00106), so nothing in the code would catch it.
//
//   2. Who plays whom. A group stage where somebody is handed a fixture against
//      another group is not a group stage; it is a broken round robin that
//      still looks plausible on the screen.
//
// Neither is visible to a test of pure functions, so both are asserted here
// against the row store.
describe('generating a group stage', () => {
  function groupField(n: number, groups: number) {
    store.db.tournament_matches = [];
    store.db.tournament_participants = Array.from({ length: n }, (_, i) => ({
      id: `p-${i}`, event_id: 'e1', player_id: `pl-${i}`, elo_before: 1500 - i * 10,
      elo_after: null, elo_change: null, seed_number: i + 1, group_number: null,
      final_position: null, points: null, status: 'checked_in',
    }));
    Object.assign(event(), {
      status: 'checkin', draw_locked: false, format: 'round_robin',
      group_count: groups, qualifiers_per_group: 2,
    });
  }
  const fixtures = () => store.db.tournament_matches!.filter((m) => m.event_id === 'e1');
  const groupOf = (id: string | null) =>
    store.db.tournament_participants!.find((p) => p.id === id)?.group_number ?? null;

  it('plays each group as its own round robin and nothing across groups', async () => {
    // 12 entrants in 4 groups of 3. Each group is 3 fixtures, so 12 in total —
    // against 66 for one flat pool of 12, which is the entire reason the format
    // exists.
    groupField(12, 4);

    expect((await generateRoundRobinMatches('e1')).ok).toBe(true);

    expect(fixtures()).toHaveLength(12);
    for (const m of fixtures()) {
      const a = groupOf(m.participant_a_id as string);
      const b = groupOf(m.participant_b_id as string);
      expect(a).not.toBeNull();
      expect(a).toBe(b);
    }
    // Everybody plays everybody in their own group, exactly once: a group of 3
    // is 3 distinct pairings and each member appears in 2 of them.
    const appearances = new Map<string, number>();
    for (const m of fixtures()) {
      for (const id of [m.participant_a_id, m.participant_b_id] as string[]) {
        appearances.set(id, (appearances.get(id) ?? 0) + 1);
      }
    }
    expect([...appearances.values()]).toEqual(new Array(12).fill(2));
    expect(new Set(fixtures().map((m) => [m.participant_a_id, m.participant_b_id].sort().join('|'))).size).toBe(12);
  });

  it('never repeats a bracket_position within a round, across every group', async () => {
    // 00081's unique index, asserted as the property it enforces. Four groups
    // means four fixtures land in Round 1, and a per-group counter would have
    // given all four position 0.
    groupField(12, 4);

    expect((await generateRoundRobinMatches('e1')).ok).toBe(true);

    const seen = new Set<string>();
    for (const m of fixtures()) {
      const key = `${m.round_number}:${m.bracket_position}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
    // And the match numbers are one sequence over the whole event, not one per
    // group — M7 has to mean one fixture on the scoresheet.
    expect(fixtures().map((m) => m.match_number).sort((a, b) => (a as number) - (b as number)))
      .toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });

  it('deals the field serpentine by seed, so the top seeds are spread out', async () => {
    groupField(8, 4);

    expect((await generateRoundRobinMatches('e1')).ok).toBe(true);

    const assigned = store.db.tournament_participants!.map((p) => p.group_number);
    expect(assigned).toEqual([1, 2, 3, 4, 4, 3, 2, 1]);
  });

  it('keeps a hand-placed entry and only fills the gaps', async () => {
    // THE OVERRIDE HAS TO SURVIVE GENERATE. An exec moved the top seed into
    // group 2; a late entrant has no group at all.
    groupField(8, 2);
    for (const p of store.db.tournament_participants!) p.group_number = 1;
    Object.assign(participant('p-0'), { group_number: 2 });
    Object.assign(participant('p-7'), { group_number: null });

    expect((await generateRoundRobinMatches('e1')).ok).toBe(true);

    expect(participant('p-0').group_number).toBe(2);
    expect(participant('p-1').group_number).toBe(1);
    // Group 2 was the smaller of the two, so the unplaced entry went there.
    expect(participant('p-7').group_number).toBe(2);
  });

  it('refuses a group nobody could play in, and writes nothing on the way out', async () => {
    // Five entrants in four groups: one group would hold a single person, who
    // would be handed no fixtures and then ranked first on a record of nothing.
    groupField(5, 4);

    const res = await generateRoundRobinMatches('e1');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/fewer than 2 entries/);
    // REFUSED BEFORE ANY WRITE. A refusal that had already stamped group
    // numbers onto half the field would leave the event carrying an assignment
    // nobody asked for and no screen explaining it.
    expect(store.db.tournament_participants!.every((p) => p.group_number == null)).toBe(true);
    expect(fixtures()).toHaveLength(0);
  });

  it('leaves a flat round robin exactly as it was', async () => {
    // group_count NULL is every round-robin event that exists today. 5
    // entrants, one pool: 10 fixtures over 5 rounds, positions from 0 in each.
    groupField(5, 4);
    Object.assign(event(), { group_count: null, qualifiers_per_group: null });

    expect((await generateRoundRobinMatches('e1')).ok).toBe(true);

    expect(fixtures()).toHaveLength(10);
    expect(store.db.tournament_participants!.every((p) => p.group_number === null)).toBe(true);
    expect(new Set(fixtures().map((m) => m.round_number))).toEqual(new Set([1, 2, 3, 4, 5]));
    for (const round of [1, 2, 3, 4, 5]) {
      const positions = fixtures().filter((m) => m.round_number === round).map((m) => m.bracket_position);
      expect(positions.sort()).toEqual([0, 1]);
    }
  });

  it('records the group shape in the audit row', async () => {
    groupField(12, 4);

    expect((await generateRoundRobinMatches('e1')).ok).toBe(true);

    const audit = store.db.tournament_audit_log!.filter((r) => r.action === 'round_robin_generated').at(-1)!;
    expect((audit.details as Row).group_count).toBe(4);
    expect((audit.details as Row).group_sizes).toEqual([3, 3, 3, 3]);
    expect((audit.details as Row).matches).toBe(12);
  });
});

// ============================================================
// Group stage -> knockout, end to end
// ============================================================
//
// THE ONE PATH THAT TOUCHES EVERY PIECE. computeRoundRobinStandings partitions
// by group_number and hands back a qualification order; buildFieldFromPool
// promotes the top qualifiers_per_group of each group and carries their group
// and finishing place onto the bracket entries; the generator draws them within
// their qualification tiers and keeps group-mates out of round one. Every one of
// those is unit-tested on its own — and a wrong branch in the join between them
// is still a wrong bracket, and a wrong final_position, on the day.
describe('a knockout seeded from a group stage', () => {
  /**
   * A finished group stage in 'e0': `groups` groups of `perGroup` entrants,
   * every fixture played and decided in entry order, so each group's standings
   * are a strict descending run. 'e1' is the knockout that seeds from it.
   */
  function finishedGroupStage(groups: number, perGroup: number, qualifiers = 2) {
    store.db.tournament_events!.push({
      id: 'e0', tournament_id: 't1', status: 'completed', event_type: 'mens_singles',
      format: 'round_robin', match_format: 'best_of_3_to_21', elo_multiplier: 1,
      placement_bonus_enabled: false, group_count: groups, qualifiers_per_group: qualifiers,
    });
    Object.assign(event(), {
      status: 'checkin', draw_locked: false,
      seeded_from_event_id: 'e0', seed_by: 'wins', max_participants: null,
    });

    store.db.tournament_participants = [];
    store.db.tournament_matches = [];
    let n = 0;
    for (let g = 1; g <= groups; g++) {
      const members = Array.from({ length: perGroup }, (_, i) => `q-g${g}-${i}`);
      for (const [i, id] of members.entries()) {
        store.db.tournament_participants.push({
          id, event_id: 'e0', player_id: `pl-${id}`, elo_before: 1200,
          elo_after: 1200 + (perGroup - i) * 10, elo_change: null, seed_number: null,
          group_number: g, final_position: null, points: null, status: 'checked_in',
        });
      }
      // Everybody in the group plays everybody, earlier entry wins — so member
      // 0 finishes first, member 1 second, and so on. Nothing left pending:
      // buildFieldFromPool refuses a half-finished pool.
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          store.db.tournament_matches.push({
            id: `pm-${++n}`, event_id: 'e0', status: 'completed', is_bye: false,
            is_third_place: false, round_number: 1, bracket_position: n,
            participant_a_id: members[i], participant_b_id: members[j],
            winner_participant_id: members[i], loser_participant_id: members[j],
            winner_to_match_id: null, winner_to_position: null,
            scores: [{ a: 21, b: 10 }, { a: 21, b: 12 }], elo_snapshot: null, notes: null,
          });
        }
      }
    }
  }

  /** Which group of the SOURCE event a promoted bracket entry came out of. */
  const sourceGroupOf = (bracketEntryId: string | null) => {
    const entry = store.db.tournament_participants!.find((p) => p.id === bracketEntryId);
    const source = store.db.tournament_participants!.find(
      (p) => p.event_id === 'e0' && p.player_id === entry?.player_id,
    );
    return (source?.group_number ?? null) as number | null;
  };
  const bracketRound1 = () => store.db.tournament_matches!
    .filter((m) => m.event_id === 'e1' && m.round_number === 1)
    .sort((a, b) => (a.bracket_position as number) - (b.bracket_position as number));

  it('promotes the top two of each group, winners above runners-up', async () => {
    finishedGroupStage(4, 3);

    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);

    const promoted = store.db.tournament_participants!
      .filter((p) => p.event_id === 'e1')
      .sort((a, b) => (a.seed_number as number) - (b.seed_number as number));
    // 4 groups x 2 qualifiers, and NOT the third-placed finishers — the cut is
    // decided by the format, not by max_participants, which is null here.
    expect(promoted).toHaveLength(8);
    expect(promoted.map((p) => p.player_id)).not.toContain('pl-q-g1-2');

    // Seeds 1-4 are the four group winners; 5-8 are the four runners-up. That
    // ordering is the whole reason to run groups rather than one pool.
    const winners = ['pl-q-g1-0', 'pl-q-g2-0', 'pl-q-g3-0', 'pl-q-g4-0'];
    expect(promoted.slice(0, 4).map((p) => p.player_id).sort()).toEqual(winners.sort());
    expect(new Set(promoted.slice(4).map((p) => p.player_id)))
      .toEqual(new Set(['pl-q-g1-1', 'pl-q-g2-1', 'pl-q-g3-1', 'pl-q-g4-1']));
    // One group, one winner: no group may take two places in the top tier.
    expect(new Set(promoted.slice(0, 4).map((p) => sourceGroupOf(p.id as string))).size).toBe(4);
  });

  it('never pairs two entrants from the same group in round one', async () => {
    // Run it repeatedly: the draw is randomised within the qualification tiers,
    // so a constraint that held once could still be luck.
    for (let attempt = 0; attempt < 25; attempt++) {
      store.db.tournament_events = store.db.tournament_events!.filter((e) => e.id === 'e1');
      finishedGroupStage(4, 3);

      expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);

      const r1 = bracketRound1();
      expect(r1).toHaveLength(4);
      for (const m of r1) {
        const a = sourceGroupOf(m.participant_a_id as string);
        const b = sourceGroupOf(m.participant_b_id as string);
        expect(a).not.toBeNull();
        expect(a).not.toBe(b);
      }
      const audit = store.db.tournament_audit_log!.filter((r) => r.action === 'bracket_generated').at(-1)!;
      expect((audit.details as Row).same_group_round_1).toBe('avoided');
      expect((audit.details as Row).source_group_count).toBe(4);
    }
  });

  it('IS drawn, unlike a single-pool seeding, and says so in the audit row', async () => {
    // A single pool's finishing order is a total order everybody played for, so
    // that draw is fixed. Across groups, "which runner-up does the winner of A
    // play" was never asked by anything the groups played — fixing it to the
    // lowest-numbered group would make the bracket a pure function of the group
    // numbering, which is the "regenerate changes nothing" defect again.
    finishedGroupStage(4, 3);
    const layouts = new Set<string>();
    for (let i = 0; i < 20; i++) {
      expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
      layouts.add(bracketRound1().map((m) => `${m.participant_a_id}/${m.participant_b_id}`).join(' | '));
    }
    expect(layouts.size).toBeGreaterThan(1);

    const audit = store.db.tournament_audit_log!.filter((r) => r.action === 'bracket_generated').at(-1)!;
    expect((audit.details as Row).draw_randomised).toBe(true);
    expect((audit.details as Row).draw_seed).toEqual(expect.any(Number));
  });

  it('respects a bracket size smaller than the qualifier count', async () => {
    // 3 groups x 2 = 6 qualifiers into a 4-slot bracket. The two caps compose,
    // and the four who get in are the ones highest in the qualification order —
    // all three group winners, then the best runner-up.
    finishedGroupStage(3, 3);
    Object.assign(event(), { max_participants: 4 });

    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);

    const promoted = store.db.tournament_participants!.filter((p) => p.event_id === 'e1');
    expect(promoted).toHaveLength(4);
    const groupsOfField = promoted.map((p) => sourceGroupOf(p.id as string)).sort();
    // Every group's winner plus one runner-up: one group appears twice.
    expect(groupsOfField).toEqual([1, 1, 2, 3]);
  });

  it('reads the group off tournament_pairs for a doubles group stage', async () => {
    // THE OTHER DISCIPLINE'S BRANCH. computeRoundRobinStandings reads
    // group_number from tournament_pairs for a doubles event and from
    // tournament_participants for a singles one, and only one of those two
    // reads is exercised by everything above. A doubles group stage is a
    // plausible first use of this feature.
    store.db.tournament_events!.push({
      id: 'e0', tournament_id: 't1', status: 'completed', event_type: 'mens_doubles',
      format: 'round_robin', match_format: 'best_of_3_to_21', elo_multiplier: 1,
      placement_bonus_enabled: false, group_count: 2, qualifiers_per_group: 2,
    });
    Object.assign(event(), {
      status: 'checkin', draw_locked: false, event_type: 'mens_doubles',
      seeded_from_event_id: 'e0', seed_by: 'wins', max_participants: null,
    });
    // Doubles reads pairs, not participants — and an unpaired entrant in the
    // BRACKET would block generation, so this list stays empty.
    store.db.tournament_participants = [];
    store.db.tournament_pairs = [];
    store.db.tournament_matches = [];
    let n = 0;
    for (const g of [1, 2]) {
      const members = [0, 1, 2].map((i) => `pair-g${g}-${i}`);
      members.forEach((id, i) => {
        store.db.tournament_pairs!.push({
          id, event_id: 'e0', player1_id: `${id}-a`, player2_id: `${id}-b`,
          pair_name: id, combined_elo: 2400 - i * 10, seed_number: null,
          group_number: g, final_position: null, points: null, status: 'checked_in',
        });
      });
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          store.db.tournament_matches.push({
            id: `dm-${++n}`, event_id: 'e0', status: 'completed', is_bye: false,
            is_third_place: false, round_number: 1, bracket_position: n,
            pair_a_id: members[i], pair_b_id: members[j],
            winner_pair_id: members[i], loser_pair_id: members[j],
            winner_to_match_id: null, winner_to_position: null,
            scores: [{ a: 21, b: 10 }, { a: 21, b: 12 }], elo_snapshot: null, notes: null,
          });
        }
      }
    }

    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);

    const promoted = store.db.tournament_pairs!.filter((p) => p.event_id === 'e1');
    expect(promoted).toHaveLength(4);
    // The group came through: no round-one match pairs two teams from the
    // same group. Both group winners were promoted, and neither is a
    // third-placed team.
    const groupOfPair = (id: string | null) => {
      const here = store.db.tournament_pairs!.find((p) => p.id === id);
      return store.db.tournament_pairs!.find((p) => p.event_id === 'e0' && p.pair_name === here?.pair_name)
        ?.group_number ?? null;
    };
    for (const m of bracketRound1()) {
      expect(groupOfPair(m.pair_a_id as string)).not.toBeNull();
      expect(groupOfPair(m.pair_a_id as string)).not.toBe(groupOfPair(m.pair_b_id as string));
    }
    expect(promoted.map((p) => p.pair_name).sort())
      .toEqual(['pair-g1-0', 'pair-g1-1', 'pair-g2-0', 'pair-g2-1']);
  });

  // ==========================================================
  // F-004, the promotion half (00198)
  // ==========================================================
  //
  // THE DUPLICATE THIS EXISTS TO PREVENT. buildFieldFromPool reads the target
  // field once, passes assertNobodyLeftUnpaired, and then promotes over dozens
  // of round trips. A member's own entry takes the field advisory lock, sees no
  // pair, and writes an unpaired participant row. For a DOUBLES bracket the
  // `existing` map is keyed on pairs only, so that row is invisible to the
  // promotion, which then inserts the same member as half a pair — leaving them
  // both a participant and half a pair, which is the original corruption.
  //
  // Before 00198 the promotion was a direct insert taking no lock, so nothing
  // could refuse it. The check now happens inside the RPC, under the same lock
  // the entry took, which is the only place the answer is stable.
  it('refuses the generation when an entry lands between the field read and the promotion', async () => {
    store.db.tournament_events!.push({
      id: 'e0', tournament_id: 't1', status: 'completed', event_type: 'mens_doubles',
      format: 'round_robin', match_format: 'best_of_3_to_21', elo_multiplier: 1,
      placement_bonus_enabled: false, group_count: 2, qualifiers_per_group: 2,
    });
    Object.assign(event(), {
      status: 'checkin', draw_locked: false, event_type: 'mens_doubles',
      seeded_from_event_id: 'e0', seed_by: 'wins', max_participants: null,
    });
    store.db.tournament_participants = [];
    store.db.tournament_pairs = [];
    store.db.tournament_matches = [];
    let n = 0;
    for (const g of [1, 2]) {
      const members = [0, 1, 2].map((i) => `pair-g${g}-${i}`);
      members.forEach((id, i) => {
        store.db.tournament_pairs!.push({
          id, event_id: 'e0', player1_id: `${id}-a`, player2_id: `${id}-b`,
          pair_name: id, combined_elo: 2400 - i * 10, seed_number: null,
          group_number: g, final_position: null, points: null, status: 'checked_in',
        });
      });
      for (let i = 0; i < members.length; i++) {
        for (let j = i + 1; j < members.length; j++) {
          store.db.tournament_matches.push({
            id: `dm-${++n}`, event_id: 'e0', status: 'completed', is_bye: false,
            is_third_place: false, round_number: 1, bracket_position: n,
            pair_a_id: members[i], pair_b_id: members[j],
            winner_pair_id: members[i], loser_pair_id: members[j],
            winner_to_match_id: null, winner_to_position: null,
            scores: [{ a: 21, b: 10 }, { a: 21, b: 12 }], elo_snapshot: null, notes: null,
          });
        }
      }
    }

    // The other desk's entry, landing in the window — ONCE, so this is the
    // interleaving and not a permanently dirty fixture. `pair-g1-0-a` is a
    // member of the top qualifying pair, so the promotion is about to write him
    // into a pair he is already entered against as an individual.
    let landed = false;
    store.beforePromote = () => {
      if (landed) return;
      landed = true;
      store.db.tournament_participants!.push({
        id: 'late-entry', event_id: 'e1', player_id: 'pair-g1-0-a',
        elo_before: 1200, elo_after: null, elo_change: null, seed_number: null,
        final_position: null, points: null, status: 'registered',
      });
    };

    const res = await generateSingleEliminationBracket('e1', false);

    // REFUSED, and told the exec what to do about it.
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/Press Generate again/i);

    // AND THE FIELD IS NOT CORRUPT. The member is a participant OR half a pair,
    // never both — no pair containing him was written.
    const pairsHere = store.db.tournament_pairs!.filter((p) => p.event_id === 'e1');
    expect(
      pairsHere.some((p) => p.player1_id === 'pair-g1-0-a' || p.player2_id === 'pair-g1-0-a'),
    ).toBe(false);
    // No draw was advertised over the half-built field either.
    expect(store.db.tournament_matches!.filter((m) => m.event_id === 'e1')).toHaveLength(0);
    expect(event().status).toBe('checkin');
  });

  // ==========================================================
  // F-004, the exec's own entry paths (00199)
  // ==========================================================
  //
  // 00196 fenced the PLAYER's entry and 00198 fenced the POOL PROMOTION, but
  // the two doors an exec uses were still a check in one round trip and an
  // insert in another. addParticipantToEvent asks playersAlreadyPaired whether
  // this member is already half of a team, is told no, and inserts — and there
  // is no cross-table unique constraint to catch a pair that landed in between,
  // because the pair lives in tournament_pairs and the entry in
  // tournament_participants. The member ends up in the event TWICE.
  //
  // The check now happens inside add_participants_under_field_lock, under the
  // same advisory lock the pairing path holds while it decides that neither
  // player is spoken for.
  it('refuses an exec entry when a pair for that member lands between the check and the insert', async () => {
    Object.assign(event(), {
      status: 'checkin', draw_locked: false, event_type: 'mens_doubles',
      max_participants: null,
    });
    store.db.tournament_participants = [];
    store.db.tournament_pairs = [];
    store.db.tournament_matches = [];
    store.db.ratings!.push({
      player_id: 'pl-carol', singles_elo: 1100, doubles_elo: 1150,
      singles_provisional: false, doubles_provisional: false, singles_matches_played: 30,
    });

    // The other desk pairs Carol in the window — ONCE, so this is the
    // interleaving and not a fixture that was dirty to begin with. The app's
    // own playersAlreadyPaired ran before this and correctly saw nothing.
    let landed = false;
    store.beforeAdd = () => {
      if (landed) return;
      landed = true;
      store.db.tournament_pairs!.push({
        id: 'late-pair', event_id: 'e1', player1_id: 'pl-carol', player2_id: 'pl-dave',
        pair_name: 'Carol / Dave', combined_elo: 2300, seed_number: null,
        group_number: null, final_position: null, points: null, status: 'registered',
      });
    };

    await expect(addParticipantToEvent('e1', 'pl-carol')).rejects.toThrow(
      /into a team while this was being submitted/i,
    );

    // AND NOTHING LANDED. Carol is half of a pair and nothing else; the entry
    // the exec was mid-way through is simply not there.
    expect(store.db.tournament_participants!.filter((r) => r.player_id === 'pl-carol')).toHaveLength(0);
    expect(store.db.tournament_pairs!.filter((r) => r.event_id === 'e1')).toHaveLength(1);
  });
});

describe('third-place playoff', () => {
  beforeEach(seedFourDraw);

  it('routes each semi-final LOSER into the playoff and each winner into the final', async () => {
    // Guards the whole feature: before loser_to_match_id existed, a match sent
    // only its winner anywhere, so a third-place match could never be filled by
    // playing the bracket — it would sit on TBD/TBD forever and block finalise.
    expect((await enterMatchResult(SF1, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a')).ok).toBe(true);

    expect(match(FINAL).participant_a_id).toBe('p-alice');
    expect(match(THIRD).participant_a_id).toBe('p-bob');
    // One side only, so neither downstream match is claimed READY yet.
    expect(match(THIRD).status).toBe('pending');

    expect((await enterMatchResult(SF2, [{ a: 21, b: 12 }, { a: 21, b: 14 }], 'a')).ok).toBe(true);

    expect(match(FINAL).participant_b_id).toBe('p-cara');
    expect(match(THIRD).participant_b_id).toBe('p-dan');
    expect(match(THIRD).status).toBe('ready');
    expect(match(FINAL).status).toBe('ready');
  });

  it('is rated exactly like any other match', async () => {
    // The decision recorded in brackets.ts. Nothing in the rating path keys off
    // the round, so this asserts no carve-out has crept in: a played playoff
    // moves Elo, the counts and the reliability figure, and leaves a reversible
    // snapshot behind.
    await enterMatchResult(SF1, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    await enterMatchResult(SF2, [{ a: 21, b: 12 }, { a: 21, b: 14 }], 'a');
    // Measured against where losing the semi-final left them, not against the
    // 1000 they started on — both are already down a semi-final's delta.
    const bobBefore = ratingOf('pl-bob');
    const danBefore = ratingOf('pl-dan');
    const played = (p: string) =>
      store.db.ratings!.find((r) => r.player_id === p)!.singles_matches_played as number;
    expect(played('pl-bob')).toBe(31);

    expect((await enterMatchResult(THIRD, [{ a: 21, b: 19 }, { a: 21, b: 18 }], 'a')).ok).toBe(true);

    expect(match(THIRD).elo_snapshot).not.toBeNull();
    expect(snapshotPlayers(THIRD).sort()).toEqual(['pl-bob', 'pl-dan']);
    expect(ratingOf('pl-bob')).toBeGreaterThan(bobBefore);
    expect(ratingOf('pl-dan')).toBeLessThan(danBefore);
    // The statistics and the reliability count move too — a playoff is a match.
    expect(played('pl-bob')).toBe(32);
    expect(store.db.reliability_metrics!.find((r) => r.player_id === 'pl-bob')!.matches_completed).toBe(7);
  });

  it('routes nobody from a BYE semi-final, rather than a phantom entry', async () => {
    // The "an event with byes may not have two real semi-final losers" case. A
    // bye is completed with a winner and NO loser, so advanceLoser has nothing
    // to send. Writing the null through would have blanked the slot the other
    // semi-final had already filled — silently un-filling a real player.
    Object.assign(match(SF2), {
      is_bye: true, status: 'completed', participant_b_id: null,
      winner_participant_id: 'p-cara', loser_participant_id: null,
    });
    await enterMatchResult(SF1, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect(match(THIRD).participant_a_id).toBe('p-bob');
    expect(match(THIRD).participant_b_id).toBeNull();
    // Still 'pending', not 'ready' — 'ready' asserts both sides are known.
    expect(match(THIRD).status).toBe('pending');
  });

  it('refuses to void a semi-final once the playoff has been played', async () => {
    // assertDownstreamUndecided used to look at winner_to_match_id ALONE. With
    // the final still unplayed it would have allowed this void, erasing the
    // semi-final underneath a third-place match that carries a real result and a
    // real Elo delta attributed to its loser.
    await enterMatchResult(SF1, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    await enterMatchResult(SF2, [{ a: 21, b: 12 }, { a: 21, b: 14 }], 'a');
    await enterMatchResult(THIRD, [{ a: 21, b: 19 }, { a: 21, b: 18 }], 'a');

    const res = await voidMatch(SF1, 'Wrong court');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/third-place match already has a result/);
    // Refused before anything moved.
    expect(match(SF1).status).toBe('completed');
    expect(match(SF1).elo_snapshot).not.toBeNull();
  });

  it('clears the playoff slot when a semi-final is voided before it is played', async () => {
    // The other half of the same rule. Voiding used to clear only the winner's
    // slot, so the erased semi-final's loser stayed parked in the playoff — a
    // bracket advertising a match for third between a real player and a result
    // that no longer exists.
    await enterMatchResult(SF1, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    await enterMatchResult(SF2, [{ a: 21, b: 12 }, { a: 21, b: 14 }], 'a');
    expect(match(THIRD).status).toBe('ready');

    expect((await voidMatch(SF1, 'Scores belonged to another match')).ok).toBe(true);

    expect(match(THIRD).participant_a_id).toBeNull();
    expect(match(THIRD).participant_b_id).toBe('p-dan');
    expect(match(THIRD).status).toBe('pending');
    expect(match(FINAL).participant_a_id).toBeNull();
  });

  it('does not evict an entry somebody placed into the playoff by hand', async () => {
    // clearRoutedEntry decides whether to clear from a READ, then clears. The
    // filter on the update is what makes the clear itself safe: between the two,
    // a desk can void the OTHER semi-final and place its replacement by hand into
    // the same slot. Without `.eq(field, entryId)` the void below would null out
    // that placement and the audit row would still claim it cleared its own
    // loser.
    await enterMatchResult(SF1, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    expect(match(THIRD).participant_a_id).toBe('p-bob');
    // Somebody else has since replaced the occupant of that slot.
    match(THIRD).participant_a_id = 'p-cara';

    expect((await voidMatch(SF1, 'Wrong court')).ok).toBe(true);

    expect(match(THIRD).participant_a_id).toBe('p-cara');
    const row = store.db.tournament_audit_log!.find((r) => r.action === 'match_voided')!;
    expect((row.details as Row).cleared_third_place_slot).toBe(false);
  });

  it('clears the playoff slot when a semi-final result is undone', async () => {
    // undoMatchResult shared clearAdvancedEntry with voidMatch, so it had the
    // identical hole: the winner came back out of the final and the loser was
    // left in the playoff.
    await enterMatchResult(SF1, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    expect((await undoMatchResult(SF1)).ok).toBe(true);

    expect(match(THIRD).participant_a_id).toBeNull();
    expect(match(FINAL).participant_a_id).toBeNull();
  });

  it('re-routes the playoff slot when a semi-final winner is corrected', async () => {
    // Flipping a semi-final's winner also flips who plays for third. Writing
    // only the winner slot would have left the new FINALIST also sitting in the
    // playoff, entered in two matches at once.
    await enterMatchResult(SF1, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    expect(match(FINAL).participant_a_id).toBe('p-alice');
    expect(match(THIRD).participant_a_id).toBe('p-bob');

    const res = await editMatchResult(SF1, [{ a: 15, b: 21 }, { a: 17, b: 21 }], 'b', 'Sides transposed on the sheet');

    expect(res.ok).toBe(true);
    expect(match(FINAL).participant_a_id).toBe('p-bob');
    expect(match(THIRD).participant_a_id).toBe('p-alice');
  });

  it('awards 3rd and 4th from the playoff, and never 2nd to its loser', async () => {
    // The highest-risk interaction. The playoff shares round_number with the
    // final, so finalizeEvent's "roundsFromFinal === 0 means the loser is 2nd"
    // rule would hand SECOND place to the player who came fourth, and its
    // champion line — which uses set(), not first-write-wins — would overwrite
    // the actual winner of the event with the winner of the playoff.
    await enterMatchResult(SF1, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    await enterMatchResult(SF2, [{ a: 21, b: 12 }, { a: 21, b: 14 }], 'a');
    await enterMatchResult(FINAL, [{ a: 21, b: 18 }, { a: 21, b: 19 }], 'a');
    await enterMatchResult(THIRD, [{ a: 21, b: 19 }, { a: 21, b: 18 }], 'a');

    await finalizeEvent('e1');

    expect(participant('p-alice').final_position).toBe(1);
    expect(participant('p-cara').final_position).toBe(2);
    expect(participant('p-bob').final_position).toBe(3);
    expect(participant('p-dan').final_position).toBe(4);
    // Points follow the positions: 3rd and 4th both land in the "<= 4" band.
    // 50 vs 40, not 50 and 50. They used to tie, which made the play-off — a
    // best of 3, the same length as the final — worth nothing but a label.
    // 4th stays clear of the quarter-final band (25): it lost a play-off, it
    // did not go out a round earlier.
    expect(participant('p-bob').points).toBe(50);
    expect(participant('p-dan').points).toBe(40);
  });

  it('still gives both semi-final losers joint 3rd when there is no playoff', async () => {
    // The behaviour every existing event depends on. It must not change just
    // because the code now knows what a third-place match is.
    store.db.tournament_matches = store.db.tournament_matches!.filter((m) => m.id !== THIRD);
    for (const id of [SF1, SF2]) {
      Object.assign(match(id), { loser_to_match_id: null, loser_to_position: null });
    }
    await enterMatchResult(SF1, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    await enterMatchResult(SF2, [{ a: 21, b: 12 }, { a: 21, b: 14 }], 'a');
    await enterMatchResult(FINAL, [{ a: 21, b: 18 }, { a: 21, b: 19 }], 'a');

    await finalizeEvent('e1');

    expect(participant('p-bob').final_position).toBe(3);
    expect(participant('p-dan').final_position).toBe(3);
  });
});

// ============================================================
// Admin override — changing an already-resolved result
// ============================================================

describe('changing a resolved result', () => {
  beforeEach(seedFourDraw);

  it('re-rates through the 00078 reversal RPC exactly once, never by hand', async () => {
    // The defect this whole path is fenced against: a second reversal route is
    // how the same delta came off the ladder twice. A correction must clear the
    // snapshot via reverse_tournament_match_rating and then re-apply, so the
    // rating reflects the corrected result ONLY — not the old one, not the sum,
    // and not the old one reversed twice.
    await enterMatchResult(SF1, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    const aliceAfterWin = ratingOf('pl-alice');
    expect(aliceAfterWin).toBeGreaterThan(1000);

    const res = await editMatchResult(SF1, [{ a: 15, b: 21 }, { a: 17, b: 21 }], 'b', 'Winner recorded on the wrong side');
    expect(res.ok).toBe(true);

    // Both started level, so the corrected result is the mirror image: exactly
    // one delta each, the other way round.
    expect(ratingOf('pl-alice')).toBe(2000 - aliceAfterWin);
    expect(ratingOf('pl-bob')).toBe(aliceAfterWin);
    const alice = store.db.ratings!.find((r) => r.player_id === 'pl-alice')!;
    expect(alice.singles_matches_played).toBe(31);
    expect(alice.singles_wins).toBe(0);
    expect(alice.singles_losses).toBe(1);
    expect(store.db.reliability_metrics!.find((r) => r.player_id === 'pl-alice')!.matches_completed).toBe(6);
    // Re-rated, not left bare.
    expect(match(SF1).elo_snapshot).not.toBeNull();
  });

  it('records the old AND the new winner in the audit trail', async () => {
    // Six months on, the audit row is the only thing that says the board ever
    // read differently. Recording only the scores — which is all it used to do —
    // leaves "who was credited with the win" unrecoverable for a walkover, where
    // there is no scoreline at all.
    await enterMatchResult(SF1, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');

    await editMatchResult(SF1, [{ a: 15, b: 21 }, { a: 17, b: 21 }], 'b', 'Scoresheet transcribed backwards');

    const row = store.db.tournament_audit_log!.find((r) => r.action === 'result_edited')!;
    const details = row.details as Row;
    expect(details.old_winner_entry_id).toBe('p-alice');
    expect(details.new_winner_entry_id).toBe('p-bob');
    expect(details.old_loser_entry_id).toBe('p-bob');
    expect(details.new_loser_entry_id).toBe('p-alice');
    expect(details.winner_changed).toBe(true);
    expect(details.reason).toBe('Scoresheet transcribed backwards');
    expect(details.old_scores).toEqual([{ a: 21, b: 15 }, { a: 21, b: 17 }]);
    expect(details.new_scores).toEqual([{ a: 15, b: 21 }, { a: 17, b: 21 }]);
    expect(details.reversed_elo).toBe(true);
  });

  it('refuses without a reason, before anything is reversed', async () => {
    // The override is meant to be explicit. Checking the reason AFTER reversing
    // the rating would leave the match unrated on a refusal — a refusal that
    // changed something is worse than no guard at all.
    await enterMatchResult(SF1, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    const snapshotBefore = match(SF1).elo_snapshot;

    const res = await editMatchResult(SF1, [{ a: 15, b: 21 }, { a: 17, b: 21 }], 'b', '   ');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/has to say why/);
    expect(match(SF1).elo_snapshot).toBe(snapshotBefore);
    expect(match(SF1).winner_participant_id).toBe('p-alice');
  });

  it('refuses on a match that has no result to change', async () => {
    // Without this the correction path was a way to stamp a winner onto a
    // PENDING match: winner/loser were written unconditionally and the re-rate
    // was skipped, leaving a match that reads as decided to every downstream
    // reader while enterMatchResult still considered it playable.
    const res = await editMatchResult(FINAL, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a', 'Nudging it along');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/no result yet/);
    expect(match(FINAL).winner_participant_id).toBeNull();
    expect(match(FINAL).status).toBe('pending');
  });

  it('refuses on a voided match, which is restored rather than edited', async () => {
    await enterMatchResult(SF1, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    await voidMatch(SF1, 'Wrong court');

    const res = await editMatchResult(SF1, [{ a: 15, b: 21 }, { a: 17, b: 21 }], 'b', 'Fixing it');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/voided/);
  });

  it('refuses when the next round has been decided by WALKOVER, not just completed', async () => {
    // The hand-rolled downstream check this replaced tested
    // `status === 'completed'` alone. A late withdrawal settles the next round
    // as a WALKOVER — rated, with a real snapshot — and that shape walked
    // straight through, letting the semi-final be rewritten underneath it.
    await enterMatchResult(SF1, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    await enterMatchResult(SF2, [{ a: 21, b: 12 }, { a: 21, b: 14 }], 'a');
    expect((await enterWalkover(FINAL, 'a', 'Opponent withdrew')).ok).toBe(true);
    expect(match(FINAL).status).toBe('walkover');

    const res = await editMatchResult(SF1, [{ a: 15, b: 21 }, { a: 17, b: 21 }], 'b', 'Sides transposed');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/next match already has a result/);
    expect(match(SF1).winner_participant_id).toBe('p-alice');
    expect(match(SF1).elo_snapshot).not.toBeNull();
  });

  it('returns the refusal as a value rather than throwing it', async () => {
    // Next.js sanitises anything thrown out of a Server Action in a production
    // build, so while editMatchResult threw, every guard above reached the
    // browser as "An error occurred in the Server Components render" — a refusal
    // indistinguishable from a crash, on the one path where the difference
    // decides what the exec does next.
    await expect(
      editMatchResult('no-such-match', [{ a: 21, b: 15 }], 'a', 'Reason'),
    ).resolves.toMatchObject({ ok: false });
  });

  it('refuses on a BYE, which is "completed" but was never played', async () => {
    // A bye passes the has-a-result check — it is status 'completed' with a
    // winner the generator placed there — so without an explicit refusal the
    // override was a way to write a scoreline and a LOSER onto a match with one
    // empty side, and then rate it. voidMatch and setMatchEntry both refuse a
    // bye; this is the third door into the same room.
    Object.assign(match(SF2), {
      is_bye: true, status: 'completed', participant_b_id: null,
      winner_participant_id: 'p-cara', loser_participant_id: null,
    });

    const res = await editMatchResult(SF2, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a', 'Filling it in');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/A bye is not a played match/);
    expect(match(SF2).scores).toBeNull();
    expect(match(SF2).elo_snapshot).toBeNull();
  });

  it('refuses rather than proceeding when the downstream check cannot be read', async () => {
    // The guard used to drop the read's { error }, which left `nextMatch` null
    // and the check silently satisfied — so a transient read failure was a way
    // PAST the one rule standing between a correction and an already-played
    // final. A refusal is recoverable; a wrongly-permitted rewrite is not.
    await enterMatchResult(SF1, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    store.faults.push({
      table: 'tournament_matches', op: 'select', message: 'connection reset',
      when: ({ filters }) => filters.some(([c, v]) => c === 'id' && v === FINAL),
    });

    const res = await editMatchResult(SF1, [{ a: 15, b: 21 }, { a: 17, b: 21 }], 'b', 'Sides transposed');

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/not safe to change this result/);
    // Nothing moved: the rating is still the one the original result applied.
    expect(match(SF1).elo_snapshot).not.toBeNull();
    expect(match(SF1).winner_participant_id).toBe('p-alice');
  });

  it('turns a corrected walkover into a played match instead of leaving it half-one', async () => {
    // Correcting a walkover by typing the real scores used to leave status
    // 'walkover' and walkover_winner 'a' on a row whose winner had just become
    // B — three fields disagreeing about who won, with the bracket rendering
    // "⚠ WALKOVER" over a scoreline.
    await enterWalkover(SF1, 'a', 'Opponent did not appear');
    expect(match(SF1).status).toBe('walkover');

    const res = await editMatchResult(SF1, [{ a: 15, b: 21 }, { a: 17, b: 21 }], 'b', 'They did turn up and lost');

    expect(res.ok).toBe(true);
    expect(match(SF1).status).toBe('completed');
    expect(match(SF1).walkover_winner).toBeNull();
    expect(match(SF1).walkover_reason).toBeNull();
    expect(match(SF1).winner_participant_id).toBe('p-bob');
  });

  it('keeps a scoreless walkover a walkover, and moves the side it was awarded to', async () => {
    // The other direction, and the one the UI could not reach at all while the
    // Save button was gated on a winner derived from the scores: a walkover has
    // no scoreline, so there was nothing to derive.
    await enterWalkover(SF1, 'a', 'Opponent did not appear');

    const res = await editMatchResult(SF1, [], 'b', 'Awarded to the wrong side');

    expect(res.ok).toBe(true);
    expect(match(SF1).status).toBe('walkover');
    expect(match(SF1).walkover_winner).toBe('b');
    expect(match(SF1).winner_participant_id).toBe('p-bob');
    expect(match(SF1).loser_participant_id).toBe('p-alice');
  });

  it('lets a correction be made after the event is finalised', async () => {
    // A wrong result is most often spotted on the results screen, which only
    // exists once the event is completed. assertEventResultsMutable allows
    // 'completed' for exactly this reason, and gating the correction on 'live'
    // would have hidden it where it is most wanted.
    await enterMatchResult(SF1, [{ a: 21, b: 15 }, { a: 21, b: 17 }], 'a');
    await enterMatchResult(SF2, [{ a: 21, b: 12 }, { a: 21, b: 14 }], 'a');
    await enterMatchResult(FINAL, [{ a: 21, b: 18 }, { a: 21, b: 19 }], 'a');
    await enterMatchResult(THIRD, [{ a: 21, b: 19 }, { a: 21, b: 18 }], 'a');
    await finalizeEvent('e1');
    expect(event().status).toBe('completed');

    const res = await editMatchResult(THIRD, [{ a: 19, b: 21 }, { a: 18, b: 21 }], 'b', 'Third-place score reversed');

    expect(res.ok).toBe(true);
    expect(match(THIRD).winner_participant_id).toBe('p-dan');
  });
});

// ============================================================
// One event, two phases (00107)
// ============================================================
//
// The two-event pool→bracket path is exercised by the two describe blocks
// above and is deliberately untouched by any of this. What follows is the
// THIRD format: a round robin and a knockout inside one event row, with the
// matches told apart by `phase`.

describe('a round robin and a knockout in one event', () => {
  function poolToBracketField(n: number, opts: { groups?: number; qualifiers?: number } = {}) {
    store.db.tournament_matches = [];
    store.db.tournament_participants = Array.from({ length: n }, (_, i) => ({
      id: `p-${i}`, event_id: 'e1', player_id: `pl-${i}`, elo_before: 1500 - i * 10,
      elo_after: null, elo_change: null, seed_number: i + 1, group_number: null,
      final_position: null, points: null, status: 'checked_in',
      // Stamped once, at the door, and asserted below to be exactly what it was
      // after the knockout is drawn — "seeding shouldn't require a new checkin".
      checked_in_at: '2026-08-12T09:00:00.000Z', checked_in_by: 'admin-1',
    }));
    store.db.ratings = Array.from({ length: n }, (_, i) => ({
      player_id: `pl-${i}`, singles_elo: 1500 - i * 10, singles_provisional: false, singles_matches_played: 30,
    }));
    store.db.reliability_metrics = Array.from({ length: n }, (_, i) => ({ player_id: `pl-${i}`, matches_completed: 5 }));
    Object.assign(event(), {
      status: 'checkin', draw_locked: false, format: 'pool_to_bracket',
      seed_by: 'wins',
      group_count: opts.groups ?? null,
      qualifiers_per_group: opts.qualifiers ?? (opts.groups ? 2 : 4),
    });
  }

  const matchesIn = (phase: string) =>
    store.db.tournament_matches!.filter((m) => m.event_id === 'e1' && m.phase === phase);

  /** Play out every pool fixture, lower index wins, so the seeding order holds. */
  function playThePool() {
    Object.assign(event(), { status: 'pool_live' });
    for (const m of matchesIn('pool')) {
      const a = m.participant_a_id as string;
      const b = m.participant_b_id as string;
      const aWins = Number(a.slice(2)) < Number(b.slice(2));
      Object.assign(m, {
        status: 'completed',
        winner_participant_id: aWins ? a : b,
        loser_participant_id: aWins ? b : a,
        scores: [{ a: aWins ? 11 : 4, b: aWins ? 4 : 11 }],
      });
    }
  }

  it('generates the POOL first, and labels it', async () => {
    poolToBracketField(6);

    expect((await generateRoundRobinMatches('e1')).ok).toBe(true);

    // 6 entrants, one flat pool: 15 fixtures, every one of them a pool match.
    expect(matchesIn('pool')).toHaveLength(15);
    expect(matchesIn('bracket')).toHaveLength(0);
    expect(event().status).toBe('pool_generated');
  });

  it('refuses to draw the knockout before the pool has been played', async () => {
    poolToBracketField(6);

    // Straight from check-in: there is no pool at all yet.
    const early = await generateSingleEliminationBracket('e1', false);
    expect(early.ok).toBe(false);
    expect(early.ok === false && early.error).toMatch(/round robin/i);

    expect((await generateRoundRobinMatches('e1')).ok).toBe(true);
    Object.assign(event(), { status: 'pool_live' });

    // Pool exists but nothing has been played.
    const halfway = await generateSingleEliminationBracket('e1', false);
    expect(halfway.ok).toBe(false);
    expect(halfway.ok === false && halfway.error).toMatch(/have not been played/i);
    expect(matchesIn('bracket')).toHaveLength(0);
  });

  // THE FAILURE 00107 EXISTS TO PREVENT. Without a phase discriminator the
  // knockout's round 1 position 0 collides with the pool's, as a unique
  // violation part-way through generation on the day.
  it('puts the two phases at the same round and position without colliding', async () => {
    poolToBracketField(6);
    expect((await generateRoundRobinMatches('e1')).ok).toBe(true);
    playThePool();

    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);

    const key = (m: Row) => `${m.round_number}:${m.bracket_position}`;
    const poolKeys = new Set(matchesIn('pool').map(key));
    const bracketKeys = matchesIn('bracket').filter((m) => !m.is_third_place).map(key);
    // They genuinely overlap — that is the point — and each phase is
    // internally unique, which is what the index actually guards.
    expect(bracketKeys.some((k) => poolKeys.has(k))).toBe(true);
    expect(new Set(bracketKeys).size).toBe(bracketKeys.length);
    expect(new Set(matchesIn('pool').map(key)).size).toBe(matchesIn('pool').length);
  });

  // WHERE THE ONE-EVENT FORMAT IS SIMPLER THAN THE TWO-EVENT ONE.
  it('qualifies by re-seeding rows that already exist — nothing is promoted', async () => {
    poolToBracketField(6);
    expect((await generateRoundRobinMatches('e1')).ok).toBe(true);
    playThePool();

    const idsBefore = store.db.tournament_participants!.map((p) => p.id).sort();
    const checkedInBefore = store.db.tournament_participants!.map((p) => p.checked_in_at);

    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);

    // Not one new entry row, and not one new check-in.
    expect(store.db.tournament_participants!.map((p) => p.id).sort()).toEqual(idsBefore);
    expect(store.db.tournament_participants!.map((p) => p.checked_in_at)).toEqual(checkedInBefore);
    // The top 4 of the pool are the field; the other two are not in the draw.
    const drawn = new Set(
      matchesIn('bracket').flatMap((m) => [m.participant_a_id, m.participant_b_id]).filter(Boolean),
    );
    expect(drawn).toEqual(new Set(['p-0', 'p-1', 'p-2', 'p-3']));
  });

  it('keeps the played-out pool when the knockout is drawn, and when it is redrawn', async () => {
    poolToBracketField(6);
    expect((await generateRoundRobinMatches('e1')).ok).toBe(true);
    playThePool();
    const poolIds = matchesIn('pool').map((m) => m.id).sort();

    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);
    expect(matchesIn('pool').map((m) => m.id).sort()).toEqual(poolIds);

    // A REDRAW OF THE KNOCKOUT IS NOT BLOCKED BY THE POOL'S RESULTS, and does
    // not delete them. Unfiltered, assertDrawIsRebuildable would have counted
    // fifteen played pool matches and refused — offering the exec the one
    // remedy (void them) that destroys the round robin they just ran.
    const redraw = await generateSingleEliminationBracket('e1', false);
    expect(redraw.ok).toBe(true);
    expect(matchesIn('pool').map((m) => m.id).sort()).toEqual(poolIds);
    expect(matchesIn('bracket').filter((m) => !m.is_third_place)).toHaveLength(3);
  });

  it('refuses to rebuild the pool once the knockout has been drawn from it', async () => {
    poolToBracketField(6);
    expect((await generateRoundRobinMatches('e1')).ok).toBe(true);
    playThePool();
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);

    const res = await generateRoundRobinMatches('e1');
    expect(res.ok).toBe(false);
    expect(res.ok === false && res.error).toMatch(/knockout has already been drawn/i);
    expect(matchesIn('pool')).toHaveLength(15);
  });

  it('composes with groups, keeping group-mates apart in round one', async () => {
    // 8 entrants, 4 groups of 2, top 1 of each — 4 qualifiers, one semi-final
    // round and a final.
    poolToBracketField(8, { groups: 4, qualifiers: 1 });
    expect((await generateRoundRobinMatches('e1')).ok).toBe(true);
    // A group of 2 is one fixture, so four groups is four pool matches.
    expect(matchesIn('pool')).toHaveLength(4);
    playThePool();

    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);

    const groupOf = (id: string | null) =>
      store.db.tournament_participants!.find((p) => p.id === id)?.group_number ?? null;
    const roundOne = matchesIn('bracket').filter((m) => m.round_number === 1 && !m.is_third_place);
    expect(roundOne).toHaveLength(2);
    for (const m of roundOne) {
      expect(groupOf(m.participant_a_id as string)).not.toBe(groupOf(m.participant_b_id as string));
    }
  });

  // ============================================================
  // The ladder (00108)
  // ============================================================

  it('plays the pool to 11', async () => {
    poolToBracketField(6);
    expect((await generateRoundRobinMatches('e1')).ok).toBe(true);
    for (const m of matchesIn('pool')) {
      expect(m.games_per_match).toBe(1);
      expect(m.points_per_game).toBe(11);
    }
  });

  it('plays the knockout 11s, 15s, 21s, best of 3 — anchored on the final', async () => {
    // 16 entrants in 8 groups of 2, top 1 each: an 8-slot knockout, so
    // quarter-final, semi-final, final.
    poolToBracketField(16, { groups: 8, qualifiers: 1 });
    expect((await generateRoundRobinMatches('e1')).ok).toBe(true);
    playThePool();

    expect((await generateSingleEliminationBracket('e1', true)).ok).toBe(true);

    const shapeOfRound = (r: number) => {
      const m = matchesIn('bracket').find((x) => x.round_number === r && !x.is_third_place)!;
      return { games_per_match: m.games_per_match, points_per_game: m.points_per_game };
    };
    expect(shapeOfRound(1)).toEqual({ games_per_match: 1, points_per_game: 15 }); // quarter-final
    expect(shapeOfRound(2)).toEqual({ games_per_match: 1, points_per_game: 21 }); // semi-final
    expect(shapeOfRound(3)).toEqual({ games_per_match: 3, points_per_game: 21 }); // final

    // The playoff shares round_number with the final and is not in the round
    // sequence, so it needs its own answer — and it is the final's.
    const playoff = matchesIn('bracket').find((m) => m.is_third_place)!;
    expect(playoff.games_per_match).toBe(3);
    expect(playoff.points_per_game).toBe(21);
  });

  it('leaves an ordinary round robin and an ordinary knockout with no shape and no phase', async () => {
    // THE UNTOUCHED-BEHAVIOUR ASSERTION. Both other formats must keep writing
    // matches that carry neither a phase nor a per-round shape, so every one of
    // them resolves to exactly the event shape it resolves to today.
    poolToBracketField(6);
    Object.assign(event(), { format: 'round_robin', group_count: null, qualifiers_per_group: null });
    expect((await generateRoundRobinMatches('e1')).ok).toBe(true);
    for (const m of store.db.tournament_matches!) {
      expect(m.phase ?? null).toBeNull();
      expect(m.games_per_match ?? null).toBeNull();
      expect(m.points_per_game ?? null).toBeNull();
    }
    expect(event().status).toBe('bracket_generated');

    poolToBracketField(4);
    Object.assign(event(), { format: 'single_elimination', group_count: null, qualifiers_per_group: null });
    expect((await generateSingleEliminationBracket('e1', true)).ok).toBe(true);
    for (const m of store.db.tournament_matches!) {
      expect(m.phase ?? null).toBeNull();
      expect(m.games_per_match ?? null).toBeNull();
      expect(m.points_per_game ?? null).toBeNull();
    }
    expect(event().status).toBe('bracket_generated');
  });

  // ============================================================
  // Elo and final_position across both phases
  // ============================================================

  it('rates a pool match at the shorter shape it was actually played to', async () => {
    poolToBracketField(6);
    expect((await generateRoundRobinMatches('e1')).ok).toBe(true);
    Object.assign(event(), { status: 'pool_live' });

    const m = matchesIn('pool')[0]!;
    // eventIsPlaying has to accept pool_live here, or no pool score can ever be
    // recorded — the single condition that would kill the format outright.
    const res = await enterMatchResult(m.id as string, [{ a: 11, b: 4 }], 'a', false);
    expect(res.ok).toBe(true);

    const rated = match(m.id as string);
    expect(rated.status).toBe('completed');
    const snap = rated.elo_snapshot as { entries: Array<{ delta: number }> };
    expect(snap.entries).toHaveLength(2);
    // A game to 11 is weighted (11/21) x 1.0 by derivedFormatWeight, so the
    // delta is well below what the event's best-of-3-to-21 default would give.
    const moved = Math.abs(snap.entries[0]!.delta);
    expect(moved).toBeGreaterThan(0);
    expect(moved).toBeLessThan(18);
  });

  it('finishes the non-qualifiers behind every qualifier, in the pool order', async () => {
    poolToBracketField(6);
    expect((await generateRoundRobinMatches('e1')).ok).toBe(true);
    playThePool();
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);

    // Play the knockout out, lower index wins again. THE SCORELINE FOLLOWS THE
    // ROUND'S OWN SHAPE — the semi-final is one game to 21 and the final is
    // best of 3, so a single game would not clinch the final and the server
    // would (correctly) refuse it. That is the ladder being enforced.
    Object.assign(event(), { status: 'live' });
    for (const round of [1, 2]) {
      for (const m of matchesIn('bracket').filter((x) => x.round_number === round)) {
        const a = m.participant_a_id as string | null;
        const b = m.participant_b_id as string | null;
        if (!a || !b) continue;
        const aWins = Number(a.slice(2)) < Number(b.slice(2));
        const target = (m.points_per_game as number | null) ?? 21;
        const game = { a: aWins ? target : target - 11, b: aWins ? target - 11 : target };
        const needed = Math.floor((((m.games_per_match as number | null) ?? 1)) / 2) + 1;
        const scores = Array.from({ length: needed }, () => game);
        expect((await enterMatchResult(m.id as string, scores, aWins ? 'a' : 'b', false)).ok).toBe(true);
      }
    }

    await finalizeEvent('e1');

    const posOf = (id: string) => participant(id).final_position as number;
    // The bracket decides the top: 1st, 2nd, and joint 3rd for the two beaten
    // semi-finalists.
    expect(posOf('p-0')).toBe(1);
    expect(posOf('p-1')).toBe(2);
    expect(posOf('p-2')).toBe(3);
    expect(posOf('p-3')).toBe(3);
    // EVERY NON-QUALIFIER IS BEHIND EVERY QUALIFIER, and they are ordered by
    // the pool table among themselves. Started from max(assigned) + 1 rather
    // than from the number of qualifiers, so nobody is placed level with
    // somebody who won a knockout match.
    expect(posOf('p-4')).toBe(4);
    expect(posOf('p-5')).toBe(5);
    // Nobody is left without a placing, which is what would happen to the whole
    // pool if the knockout rule ran on its own.
    for (const p of store.db.tournament_participants!) {
      expect(p.final_position).not.toBeNull();
      expect(p.points).toBeGreaterThan(0);
    }
  });

  // ============================================================
  // ONE COLUMN DECIDES BOTH HALVES — the seed_by trap, pinned
  // ============================================================
  //
  // buildFieldFromOwnPool picks the qualifiers by event.seed_by and
  // assignPositionsAndPoints ranks everybody the knockout did not contain by
  // event.seed_by. That they read the SAME column is the whole fix, and nothing
  // asserted it: every pool_to_bracket test above plays a pool whose 'wins'
  // order and 'points' order happen to be identical, so a reader that quietly
  // went back to 'wins' would pass all of them.
  //
  // These two play a pool where the two orders are almost exactly reversed, and
  // run it twice — once by points, once by NULL — so the column, not the tally,
  // is demonstrably what moves the field and the placings.

  /**
   * The two fixtures played as two-game blowouts; every other one is a
   * three-game thriller. See playThePoolOnMargins.
   */
  const POOL_BLOWOUTS = new Set(['0-1', '1-2']);

  /**
   * Play the pool so that WINS ORDER AND POINTS ORDER DISAGREE — at the top of
   * the table AND at the bottom, which is what makes both readers testable.
   *
   * Lower index still wins every fixture, so the wins table is untouched:
   * p-0 5 wins, p-1 4, p-2 3, p-3 2, p-4 1, p-5 0.
   *
   * Only the scorelines differ. A thriller is 11-9, 9-11, 11-9 — 31 points to
   * the winner, 29 to the loser — and a blowout is 11-2, 11-2, so 22 to 4.
   * Everything is a thriller except p-0 v p-1 and p-1 v p-2, which is the shape
   * of a pool where one entrant happens to get two cheap results. Totals:
   *
   *   p-3 149, p-4 147, p-0 146, p-5 145, p-2 126, p-1 119
   *
   * TWO INVERSIONS, BOTH DELIBERATE. The top four by points is
   * {p-3, p-4, p-0, p-5} against {p-0, p-1, p-2, p-3} by wins, so the
   * QUALIFYING reader is pinned; and the two left over rank p-2 ahead of p-1 by
   * points but p-1 ahead of p-2 by wins, so the NON-QUALIFIER reader in
   * finalize.ts is pinned too. Without that second inversion a finalize that
   * quietly went back to 'wins' would still have passed.
   */
  function playThePoolOnMargins() {
    Object.assign(event(), { status: 'pool_live' });
    for (const m of matchesIn('pool')) {
      const a = m.participant_a_id as string;
      const b = m.participant_b_id as string;
      const ai = Number(a.slice(2));
      const bi = Number(b.slice(2));
      const aWins = ai < bi;
      const pair = `${Math.min(ai, bi)}-${Math.max(ai, bi)}`;
      // Winner-perspective games, flipped onto a/b below.
      const games = POOL_BLOWOUTS.has(pair)
        ? [[11, 2], [11, 2]]
        : [[11, 9], [9, 11], [11, 9]];
      Object.assign(m, {
        status: 'completed',
        winner_participant_id: aWins ? a : b,
        loser_participant_id: aWins ? b : a,
        scores: games.map(([w, l]) => (aWins ? { a: w, b: l } : { a: l, b: w })),
      });
    }
  }

  /**
   * Play out a four-strong knockout, lower index winning, to whatever shape the
   * ladder stamped on each round. Returns nothing: these tests care about the
   * non-qualifiers, and assert the qualifiers only as a band.
   */
  async function playTheKnockout() {
    Object.assign(event(), { status: 'live' });
    const rounds = [...new Set(matchesIn('bracket').map((m) => m.round_number as number))].sort((x, y) => x - y);
    for (const round of rounds) {
      for (const m of matchesIn('bracket').filter((x) => x.round_number === round)) {
        const a = m.participant_a_id as string | null;
        const b = m.participant_b_id as string | null;
        if (!a || !b) continue;
        const aWins = Number(a.slice(2)) < Number(b.slice(2));
        const target = (m.points_per_game as number | null) ?? 21;
        const game = { a: aWins ? target : target - 11, b: aWins ? target - 11 : target };
        const needed = Math.floor(((m.games_per_match as number | null) ?? 1) / 2) + 1;
        const scores = Array.from({ length: needed }, () => game);
        expect((await enterMatchResult(m.id as string, scores, aWins ? 'a' : 'b', false)).ok).toBe(true);
      }
    }
  }

  /** Who actually got into the knockout draw. */
  const drawnField = () => new Set(
    matchesIn('bracket').flatMap((m) => [m.participant_a_id, m.participant_b_id]).filter(Boolean),
  );

  it('seeds the knockout AND ranks the non-qualifiers by the same seed_by — points', async () => {
    poolToBracketField(6);
    // The one line under test. Everything else is identical to the 'wins' case
    // below, including the scorelines.
    Object.assign(event(), { seed_by: 'points' });
    expect((await generateRoundRobinMatches('e1')).ok).toBe(true);
    playThePoolOnMargins();
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);

    // WHO QUALIFIED came from the points column: the four highest scorers, which
    // here includes the entrant who lost every match. Under 'wins' this set is
    // p-0..p-3, so this assertion fails outright if the column stops being read.
    expect(drawnField()).toEqual(new Set(['p-3', 'p-4', 'p-0', 'p-5']));

    await playTheKnockout();
    await finalizeEvent('e1');

    const posOf = (id: string) => participant(id).final_position as number;
    // A four-strong draw with no playoff awards 1, 2 and joint 3rd, so every
    // qualifier sits at 3 or better. Asserted as a band rather than by name
    // because the draw shuffles within its seeding tiers.
    for (const id of ['p-3', 'p-4', 'p-0', 'p-5']) {
      expect(posOf(id)).toBeLessThanOrEqual(3);
    }
    // AND THE NON-QUALIFIERS WERE RANKED BY THE SAME COLUMN — the assertion the
    // placement-bonus ledger actually rides on. p-2 (126 points) ahead of p-1
    // (119), both behind every qualifier, starting from max(assigned) + 1.
    // Ranked by WINS this pair is the other way round (p-1 has 4 wins to p-2's
    // 3), so a finalize that stopped reading seed_by fails here.
    expect(posOf('p-2')).toBe(4);
    expect(posOf('p-1')).toBe(5);
    // Placement bonuses key off final_position, so nobody may be left without one.
    for (const p of store.db.tournament_participants!) {
      expect(p.final_position).not.toBeNull();
    }
  });

  it('treats a NULL seed_by as wins end to end, through both readers', async () => {
    poolToBracketField(6);
    // NOT a hypothetical row. createTournamentEvent writes 'wins' here, but any
    // event created before 00107, or by a build whose settings dialog nulled
    // seed_by alongside the pool link, can sit on NULL — that WAS what
    // updateTournamentEvent did on this format until the test below changed it.
    // The coalesce is what has to survive either way.
    //
    // sortStandings' own null handling is unit-tested in @badminton/shared;
    // what is tested HERE is the whole path — a NULL row still qualifies the
    // wins-order field and still ranks the leftovers in wins order, over the
    // very scorelines that produce a different answer under 'points' above.
    Object.assign(event(), { seed_by: null });
    expect((await generateRoundRobinMatches('e1')).ok).toBe(true);
    playThePoolOnMargins();
    expect((await generateSingleEliminationBracket('e1', false)).ok).toBe(true);

    // The wins order, over the very scorelines that gave the points order above.
    expect(drawnField()).toEqual(new Set(['p-0', 'p-1', 'p-2', 'p-3']));

    await playTheKnockout();
    await finalizeEvent('e1');

    const posOf = (id: string) => participant(id).final_position as number;
    for (const id of ['p-0', 'p-1', 'p-2', 'p-3']) {
      expect(posOf(id)).toBeLessThanOrEqual(3);
    }
    expect(posOf('p-4')).toBe(4);
    expect(posOf('p-5')).toBe(5);
  });

  /**
   * THE SETTINGS DIALOG MUST NOT UNDO THE CHOICE IT JUST OFFERED.
   *
   * 'points' is now selectable on a pool_to_bracket event — the form gate was
   * `seededFrom !== ''`, which is false forever on the one format that ranks its
   * OWN pool. Making the control reachable is only half the job: this format has
   * no external pool, so both dialogs blank the pool picker and every save sends
   * `seeded_from_event_id: null`, and updateTournamentEvent's else-branch used to
   * null seed_by alongside it. The exec would have picked "Most points scored",
   * seen "Event updated", and been silently back on wins.
   *
   * So the branch clears the LINK and keeps the CRITERION on this format, which
   * is the same condition createTournamentEvent stores on. Asserted through the
   * real payload shape the dialog sends rather than a hand-made patch, because
   * the bug was entirely in how those two lined up.
   */
  it('keeps a pool_to_bracket event’s seed_by when the settings dialog clears the pool link', async () => {
    poolToBracketField(6);
    expect(event().seed_by).toBe('wins');

    const res = await updateTournamentEvent('e1', {
      ...toFormatPayload(
        { ...EMPTY_FORMAT_VALUES, seedBy: 'points', qualifiersPerGroup: '4' },
        'pool_to_bracket',
      ),
      max_participants: null,
    });

    expect(res.ok).toBe(true);
    // The link is still cleared — this format may never carry one.
    expect(event().seeded_from_event_id ?? null).toBeNull();
    // ...and the criterion survived the clearing.
    expect(event().seed_by).toBe('points');
  });

  it('still drops seed_by on a format that has no pool to rank', async () => {
    // The other half of the same branch, so the fix above cannot be read as
    // "always keep it". A plain round robin PRODUCES standings and never
    // consumes any: finalize.ts ranks it by wins because several brackets may
    // seed off it with different criteria. A criterion left behind here would be
    // read as a choice nobody made if a pool link were added later.
    poolToBracketField(6);
    Object.assign(event(), { format: 'round_robin' });

    const res = await updateTournamentEvent('e1', {
      ...toFormatPayload({ ...EMPTY_FORMAT_VALUES, seedBy: 'points' }, 'round_robin'),
      max_participants: null,
    });

    expect(res.ok).toBe(true);
    expect(event().seed_by).toBeNull();
  });

  // ============================================================
  // Setting what a round is played to (00108)
  // ============================================================

  it('sets a whole round at once, and refuses one that has a result', async () => {
    poolToBracketField(6);
    expect((await generateRoundRobinMatches('e1')).ok).toBe(true);

    const roundOne = () => matchesIn('pool').filter((m) => m.round_number === 1);
    expect(roundOne().length).toBeGreaterThan(1);

    const set = await setRoundMatchShape('e1', { phase: 'pool', roundNumber: 1 }, { games_per_match: 1, points_per_game: 15 });
    expect(set.ok).toBe(true);
    for (const m of roundOne()) {
      expect(m.games_per_match).toBe(1);
      expect(m.points_per_game).toBe(15);
    }
    // ...and only that round.
    for (const m of matchesIn('pool').filter((m) => m.round_number === 2)) {
      expect(m.points_per_game).toBe(11);
    }

    // Clearing puts the columns back to NULL rather than writing the event's
    // current numbers out, so the round keeps following the event afterwards.
    expect((await setRoundMatchShape('e1', { phase: 'pool', roundNumber: 1 }, null)).ok).toBe(true);
    for (const m of roundOne()) {
      expect(m.games_per_match ?? null).toBeNull();
      expect(m.points_per_game ?? null).toBeNull();
    }

    // A ROUND WITH A RESULT IS REFUSED. Changing it would re-judge a recorded
    // score and re-weight the rating it already earned, both silently.
    Object.assign(roundOne()[0]!, { status: 'completed' });
    const refused = await setRoundMatchShape('e1', { phase: 'pool', roundNumber: 1 }, { games_per_match: 1, points_per_game: 21 });
    expect(refused.ok).toBe(false);
    expect(refused.ok === false && refused.error).toMatch(/already ha[sv]e? a result/i);
  });

  it('addresses the third-place playoff separately from the final', async () => {
    poolToBracketField(8, { groups: 4, qualifiers: 1 });
    expect((await generateRoundRobinMatches('e1')).ok).toBe(true);
    playThePool();
    expect((await generateSingleEliminationBracket('e1', true)).ok).toBe(true);

    const finalRound = Math.max(...matchesIn('bracket').map((m) => m.round_number as number));
    expect((await setRoundMatchShape('e1', { phase: 'bracket', roundNumber: null, thirdPlace: true }, { games_per_match: 1, points_per_game: 15 })).ok).toBe(true);

    const playoff = matchesIn('bracket').find((m) => m.is_third_place)!;
    const theFinal = matchesIn('bracket').find((m) => m.round_number === finalRound && !m.is_third_place)!;
    expect(playoff.points_per_game).toBe(15);
    // The final shares its round_number with the playoff and must NOT have
    // moved — matching on the number alone would have swept it in.
    expect(theFinal.points_per_game).toBe(21);
    expect(theFinal.games_per_match).toBe(3);
  });
});


// ---------------------------------------------------------------------------
// AUTO-SEED
// ---------------------------------------------------------------------------
// Nothing covered this action at all, and it was changed twice: the per-entrant
// updates now run together rather than one awaiting the next, and their results
// are checked instead of discarded. Both are invisible to a suite that never
// calls it, so the suite called it.
describe('auto-seeding by rating', () => {
  function field(elos: Array<number | null>, statuses: string[] = []) {
    store.db.tournament_matches = [];
    store.db.tournament_participants = elos.map((elo, i) => ({
      id: `p-${i}`, event_id: 'e1', player_id: `pl-${i}`, elo_before: elo,
      elo_after: null, elo_change: null, seed_number: null,
      final_position: null, points: null, status: statuses[i] ?? 'checked_in',
    }));
    Object.assign(event(), { status: 'registration', draw_locked: false });
  }
  const seeds = () => store.db.tournament_participants!
    .map((p) => [p.id, p.seed_number] as const)
    .sort((a, b) => String(a[0]).localeCompare(String(b[0])));

  it('numbers the field from the strongest down', async () => {
    field([1200, 1400, 1300]);
    await autoSeedEventByElo('e1');
    // p-1 (1400) then p-2 (1300) then p-0 (1200) — the seed is a RANK, not the
    // row order the field happened to be read in.
    expect(seeds()).toEqual([['p-0', 3], ['p-1', 1], ['p-2', 2]]);
  });

  it('leaves withdrawn entrants out, so the seeds stay contiguous', async () => {
    field([1400, 1300, 1200], ['checked_in', 'withdrawn', 'checked_in']);
    await autoSeedEventByElo('e1');
    // 1 and 2, not 1 and 3: a withdrawal must not leave a hole for the draw to
    // place a bye against.
    expect(seeds()).toEqual([['p-0', 1], ['p-1', null], ['p-2', 2]]);
  });

  it('puts an unrated entrant last rather than first', async () => {
    field([1200, null, 1400]);
    await autoSeedEventByElo('e1');
    expect(seeds()).toEqual([['p-0', 2], ['p-1', 3], ['p-2', 1]]);
  });

  it('SEEDS NOBODY when the write fails, rather than some of the field', async () => {
    field([1400, 1300, 1200]);
    // THE FAILURE MODE THIS ASSERTS CHANGED SHAPE IN 00209, and the assertion
    // moved with it rather than being deleted.
    //
    // Originally every update's result was discarded, so a failure returned
    // success and left a field where one entrant kept no seed while the others
    // were renumbered around them. That was fixed by checking N writes and
    // refusing if any failed. 00209 removed the N writes: seeding is now one
    // statement inside the field lock, so there is no partial state left to
    // detect — the guarantee is stronger and it is structural.
    //
    // What still has to hold is what the exec sees: a failure must refuse
    // loudly and leave every seed exactly as it was.
    store.faults.push({
      table: 'tournament_participants',
      op: 'update',
      message: 'connection reset',
      when: ({ filters }) => filters.some(([col]) => col === 'event_id'),
    });
    await expect(autoSeedEventByElo('e1')).rejects.toThrow(/connection reset/);
    expect(seeds()).toEqual([['p-0', null], ['p-1', null], ['p-2', null]]);
  });

  it('refuses on a locked draw', async () => {
    field([1400, 1300]);
    Object.assign(event(), { draw_locked: true });
    await expect(autoSeedEventByElo('e1')).rejects.toThrow(/locked/i);
  });

  it('refuses once the event has left registration, which nothing enforced before', async () => {
    // The console has always gated every seed control on
    // `status === 'registration' && !drawLocked` (participant-controls.ts), but
    // the server action checked only draw_locked — so the status half of its
    // own rule had no server-side enforcement at all and a stale tab or a
    // direct call could reseed a live event underneath its own bracket. 00209's
    // fence is where that rule finally exists.
    field([1400, 1300, 1200]);
    Object.assign(event(), { status: 'live' });
    await expect(autoSeedEventByElo('e1')).rejects.toThrow(/moved to "live"/);
    expect(seeds()).toEqual([['p-0', null], ['p-1', null], ['p-2', null]]);
  });
});
