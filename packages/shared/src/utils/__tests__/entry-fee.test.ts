import { describe, it, expect } from 'vitest';
import { ensureEntryFees } from '../entry-fee';

// A small PostgREST-shaped store. Only the four verbs ensureEntryFees uses.
type Row = Record<string, unknown>;

function makeClient(db: Record<string, Row[]>, opts: { rejectOn?: string } = {}) {
  const inserts: Row[] = [];
  const client = {
    inserts,
    from(table: string) {
      if (opts.rejectOn === table) {
        // A client-level failure — a dropped socket, not a PostgREST error
        // object. This is the shape that used to escape as a rejected promise.
        throw new Error('connection reset');
      }
      const filters: [string, unknown][] = [];
      let inFilter: [string, unknown[]] | null = null;
      let payload: Row[] | null = null;
      const chain: Record<string, unknown> = {
        select: () => chain,
        eq: (c: string, v: unknown) => { filters.push([c, v]); return chain; },
        in: (c: string, v: unknown[]) => { inFilter = [c, v]; return chain; },
        insert: (p: Row | Row[]) => { payload = Array.isArray(p) ? p : [p]; return chain; },
        maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
        then: (resolve: (v: unknown) => unknown) => {
          if (payload) {
            for (const row of payload) {
              const clash = (db.club_fees ?? []).some(
                (r) =>
                  r.fee_type === 'tournament' &&
                  r.tournament_id === row.tournament_id &&
                  r.player_id === row.player_id,
              );
              if (clash) return resolve({ data: null, error: { code: '23505', message: 'dup' } });
              inserts.push(row);
              (db.club_fees ??= []).push(row);
            }
            return resolve({ data: payload, error: null });
          }
          return resolve({ data: rows(), error: null });
        },
      };
      const rows = () =>
        (db[table] ?? []).filter(
          (r) =>
            filters.every(([c, v]) => r[c] === v) &&
            (!inFilter || inFilter[1].includes(r[inFilter[0]])),
        );
      return chain;
    },
  };
  return client;
}

const T = 'tournament-1';
const seed = () => ({
  tournaments: [{ id: T, season_id: 'season-1' }],
  tournament_fee_tiers: [
    { id: 'internal', tournament_id: T, name: 'Member', amount_cents: 1000, is_default: true, sort_order: 0, applies_to: ['internal'] },
    { id: 'guest', tournament_id: T, name: 'Guest', amount_cents: 2500, is_default: false, sort_order: 1, applies_to: ['alumni', 'external'] },
  ],
  players: [
    { id: 'p-internal', membership_type: 'internal', is_exec: false, fee_exempt: false },
    { id: 'p-alumni', membership_type: 'alumni', is_exec: false, fee_exempt: false },
    { id: 'p-exec', membership_type: 'internal', is_exec: true, fee_exempt: false },
    { id: 'p-exempt', membership_type: 'internal', is_exec: false, fee_exempt: true },
  ],
  club_fees: [] as Row[],
});

describe('ensureEntryFees', () => {
  it('prices each entrant off their own membership, in one call', async () => {
    const db = seed();
    const client = makeClient(db);
    await ensureEntryFees(client as never, T, ['p-internal', 'p-alumni']);

    const byPlayer = new Map(client.inserts.map((r) => [r.player_id, r]));
    expect(byPlayer.get('p-internal')?.amount_cents).toBe(1000);
    expect(byPlayer.get('p-alumni')?.amount_cents).toBe(2500);
    // Tagged, seasoned and UNPAID — the row is a liability until an exec
    // records the money, and season income counts only paid rows.
    for (const row of client.inserts) {
      expect(row.fee_type).toBe('tournament');
      expect(row.season_id).toBe('season-1');
      expect(row.paid_at).toBeNull();
    }
  });

  // The club owner's rule, stated as a test: an entry fee is a fact about the
  // day somebody entered, and re-pricing recorded money is how a ledger stops
  // reconciling.
  it('does not re-price an entry when the member changes membership group', async () => {
    const db = seed();
    await ensureEntryFees(makeClient(db) as never, T, ['p-internal']);
    expect(db.club_fees[0]!.amount_cents).toBe(1000);

    // The exec moves them to alumni, and they enter a second event of the same
    // tournament. Nothing about the money they already owe may move.
    db.players.find((p) => p.id === 'p-internal')!.membership_type = 'alumni';
    const second = makeClient(db);
    const results = await ensureEntryFees(second as never, T, ['p-internal']);

    expect(second.inserts).toHaveLength(0);
    expect(results[0]!.created).toBe(false);
    expect(db.club_fees).toHaveLength(1);
    expect(db.club_fees[0]!.amount_cents).toBe(1000);
  });

  // One fee per TOURNAMENT, not per event — the same reason the second call
  // above writes nothing.
  it('bills an exec or a fee-exempt member nothing at all', async () => {
    const db = seed();
    const client = makeClient(db);
    await ensureEntryFees(client as never, T, ['p-exec', 'p-exempt']);
    // Not "a row with amount 0": a debt no fee screen in the app will show is
    // worse than no debt, because nobody can settle it.
    expect(client.inserts).toHaveLength(0);
  });

  it('records an entry with no price rather than refusing it', async () => {
    // Every tier names a group, none names this one, and there is no default.
    const db = seed();
    db.tournament_fee_tiers = [
      { id: 'guest', tournament_id: T, name: 'Guest', amount_cents: 2500, is_default: false, sort_order: 0, applies_to: ['external'] },
    ];
    const client = makeClient(db);
    const results = await ensureEntryFees(client as never, T, ['p-internal']);

    expect(client.inserts).toHaveLength(1);
    // null, not 0. "The club has not said what this costs" is a different
    // statement from "this is free", and every screen renders it as TBD.
    expect(client.inserts[0]!.amount_cents).toBeNull();
    expect(client.inserts[0]!.tier_id).toBeNull();
    expect(results[0]!.created).toBe(true);
  });

  it('NEVER throws into the registration, whatever the database does', async () => {
    // The participant row is already committed by the time this runs. A
    // rejection here would tell a member they are not entered when they are.
    const db = seed();
    await expect(
      ensureEntryFees(makeClient(db, { rejectOn: 'tournament_fee_tiers' }) as never, T, ['p-internal']),
    ).resolves.toEqual([]);
    expect(db.club_fees).toHaveLength(0);
  });

  it('treats a racing duplicate as a success, not a failure', async () => {
    const db = seed();
    db.club_fees.push({ fee_type: 'tournament', tournament_id: T, player_id: 'p-alumni', amount_cents: 2500 });
    const client = makeClient(db);
    // p-alumni's row appeared between the read and the insert. p-internal's
    // must still land — one conflicting row must not take the others with it.
    const results = await ensureEntryFees(client as never, T, ['p-internal', 'p-alumni']);

    expect(results.find((r) => r.playerId === 'p-internal')?.created).toBe(true);
    expect(db.club_fees.filter((r) => r.player_id === 'p-alumni')).toHaveLength(1);
  });
});

// ===========================================================================
// THE DOUBLES POOL (00102) — entering alone, then being paired
// ===========================================================================
// A doubles event now takes entrants who arrive without a partner. They are
// invoiced when they ENTER, and pairing them later must not invoice them a
// second time.
//
// It cannot, and not because addPairToEvent checks: the row is keyed on
// (tournament_id, player_id) by club_fees_tournament_player_key, so the row a
// solo entry creates IS the row a later pairing would write. Double-invoicing a
// promoted entrant is not something the code avoids — it is something the
// schema makes unreachable. These tests are that claim, executed.

describe('ensureEntryFees across a doubles promotion', () => {
  it('invoices a solo entrant at entry, and NOT AGAIN when they are paired', async () => {
    const db = seed();

    // 1. Two people enter the doubles event separately, with no partner.
    const soloA = makeClient(db);
    await ensureEntryFees(soloA as never, T, ['p-internal']);
    const soloB = makeClient(db);
    await ensureEntryFees(soloB as never, T, ['p-alumni']);
    expect(db.club_fees).toHaveLength(2);

    // 2. An exec pairs them. addPairToEvent calls ensureEntryFees for both
    //    halves exactly as it always has — it has no idea whether this is a
    //    promotion or a fresh team, and does not need one.
    const pairing = makeClient(db);
    const results = await ensureEntryFees(pairing as never, T, ['p-internal', 'p-alumni']);

    expect(pairing.inserts).toHaveLength(0);
    expect(db.club_fees).toHaveLength(2);
    for (const r of results) expect(r.created).toBe(false);
    // And nothing was re-priced on the way through.
    expect(db.club_fees.find((r) => r.player_id === 'p-internal')?.amount_cents).toBe(1000);
    expect(db.club_fees.find((r) => r.player_id === 'p-alumni')?.amount_cents).toBe(2500);
  });

  it('invoices only the half who had not entered, when one of the two is new', async () => {
    const db = seed();
    await ensureEntryFees(makeClient(db) as never, T, ['p-internal']);

    // The exec pairs the waiting member with somebody who was not in the event
    // at all. One new row, not two.
    const pairing = makeClient(db);
    await ensureEntryFees(pairing as never, T, ['p-internal', 'p-alumni']);

    expect(pairing.inserts).toHaveLength(1);
    expect(pairing.inserts[0]!.player_id).toBe('p-alumni');
    expect(db.club_fees).toHaveLength(2);
  });

  it('invoices nobody when one half of a team is SWAPPED for another entrant', async () => {
    // 00103: the incoming player has to be in the waiting list already, which is
    // precisely what makes this free — they were charged when they entered it.
    // The outgoing player keeps their row, because withdrawing does not refund
    // and being replaced is not even a withdrawal.
    const db = seed();
    await ensureEntryFees(makeClient(db) as never, T, ['p-internal', 'p-alumni']);
    expect(db.club_fees).toHaveLength(2);
    const before = JSON.stringify(db.club_fees);

    // swapPairMember calls this for the incoming half, exactly as
    // addPairToEvent does — so that the guarantee is stated where a future edit
    // would break it rather than only in a comment.
    const swap = makeClient(db);
    const results = await ensureEntryFees(swap as never, T, ['p-alumni']);

    expect(swap.inserts).toHaveLength(0);
    expect(results[0]!.created).toBe(false);
    expect(JSON.stringify(db.club_fees)).toBe(before);
  });

  it('leaves both fees standing when the pair is split up again', async () => {
    // Withdrawing does not refund, and unpairing is not even a withdrawal.
    // unpairEntry and withdrawPairMember touch club_fees at all — they do not
    // call this function — so the assertion is that the ledger is untouched by
    // anything the split does.
    const db = seed();
    await ensureEntryFees(makeClient(db) as never, T, ['p-internal', 'p-alumni']);
    const before = JSON.stringify(db.club_fees);

    // The partner who is left goes back into the pool. If any future edit adds
    // an ensureEntryFees call to that path, this still has to hold.
    const after = makeClient(db);
    await ensureEntryFees(after as never, T, ['p-alumni']);

    expect(after.inserts).toHaveLength(0);
    expect(JSON.stringify(db.club_fees)).toBe(before);
  });
});
