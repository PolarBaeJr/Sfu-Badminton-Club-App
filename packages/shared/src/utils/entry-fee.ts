// Entering a tournament puts what you owe for it on the club's fee ledger.
//
// "tournament entry actually writes into club fees under the type of fee as
// 'tournaments' … so we can see things" — the club owner. Before this, a fee
// row only appeared when an exec marked one PAID, which meant the club's answer
// to "who owes us money for this event" was a list nobody had written down.
//
// ONE IMPLEMENTATION FOR FOUR CALLERS. A member registers themselves (player
// app), and an exec adds one, several, or a doubles pair (admin app). Four
// registration paths that each priced entries their own way would produce four
// prices, and the one thing a fee ledger has to be is consistent.

import type { SupabaseClient } from '@supabase/supabase-js';
import { selectFeeTier, type PricingTier } from './fee-tiers';

export interface EntryFeeResult {
  playerId: string;
  /** True when this call created the row; false when one already existed. */
  created: boolean;
  amountCents: number | null;
  tierId: string | null;
}

/**
 * Make sure every named player has an entry-fee row for this tournament.
 *
 * PER TOURNAMENT, NOT PER EVENT. club_fees_tournament_player_key (00094) keys
 * the row on (tournament_id, player_id), which is the shape tournament_fees
 * always had: a member entering singles, doubles and mixed at one tournament
 * pays one entry fee. So this is called on every registration and is a no-op
 * on all but the first.
 *
 * NEVER OVERWRITES AN EXISTING ROW. That is what makes the club owner's second
 * rule true — "changing someone's membership_type does not re-price an entry
 * they have already made". The price is a fact about the day they entered; a
 * ledger whose recorded amounts move underneath it stops reconciling, and
 * somebody who was charged $25 and later reads $15 has been told the club
 * cannot count. Re-pricing is an exec editing the row, visibly.
 *
 * NEVER THROWS INTO THE REGISTRATION. The caller is mid-registration and the
 * participant row is already written; failing here would leave a member
 * unregistered because a price list was incomplete, or — worse — registered
 * with an error on screen. "Never refuse an entry because no tier matched" was
 * the explicit instruction, and a failed WRITE deserves the same treatment as
 * a failed match: the entry stands, and the missing fee row is visible on the
 * tournament's fees page as a member with nothing recorded, which is exactly
 * what an exec is looking at that page to find.
 */
export async function ensureEntryFees(
  supabase: SupabaseClient,
  tournamentId: string,
  playerIds: readonly string[],
): Promise<EntryFeeResult[]> {
  // THE "NEVER THROWS" ABOVE, ENFORCED BY CODE RATHER THAN BY THE COMMENT.
  //
  // The body checks `.error` on every query, but a client-level failure — the
  // socket dropping, a fetch rejecting — rejects the promise instead, and that
  // rejection would propagate out of a registration that has ALREADY written
  // the participant row. The member would be entered and told they were not.
  // The whole contract of this function is that it cannot do that, so the
  // guarantee lives here.
  try {
    return await ensureEntryFeesImpl(supabase, tournamentId, playerIds);
  } catch {
    return [];
  }
}

async function ensureEntryFeesImpl(
  supabase: SupabaseClient,
  tournamentId: string,
  playerIds: readonly string[],
): Promise<EntryFeeResult[]> {
  const unique = [...new Set(playerIds)].filter(Boolean);
  if (unique.length === 0) return [];

  const [tournamentRes, tiersRes, playersRes, existingRes] = await Promise.all([
    // The season the money counts toward, stamped on at entry rather than
    // joined at read time. See the header of admin's season-income.ts.
    supabase.from('tournaments').select('season_id').eq('id', tournamentId).maybeSingle(),
    supabase
      .from('tournament_fee_tiers')
      .select('id, name, amount_cents, is_default, sort_order, applies_to')
      .eq('tournament_id', tournamentId),
    supabase.from('players').select('id, membership_type, is_exec, fee_exempt').in('id', unique),
    supabase
      .from('club_fees')
      .select('player_id')
      .eq('tournament_id', tournamentId)
      .eq('fee_type', 'tournament')
      .in('player_id', unique),
  ]);

  // A read that failed is not a read that found nothing. Bailing out leaves the
  // registration intact and the fee row missing — recoverable — whereas
  // proceeding on empty data would price everybody at nothing, which looks
  // exactly like a deliberate free event.
  //
  // tournamentRes is in the list because a failed read there would leave
  // season_id null on a tournament that HAS a season — a paid fee attached to
  // no season is money that shows on the member's row, is individually
  // correct, and is absent from every season's income permanently (00069).
  if (tournamentRes.error || tiersRes.error || playersRes.error || existingRes.error) return [];

  const tiers = (tiersRes.data ?? []) as PricingTier[];
  const already = new Set((existingRes.data ?? []).map((r) => r.player_id as string));
  const seasonId = (tournamentRes.data as { season_id: string | null } | null)?.season_id ?? null;

  const rows: Record<string, unknown>[] = [];
  const results: EntryFeeResult[] = [];

  for (const player of (playersRes.data ?? []) as {
    id: string;
    membership_type: string | null;
    is_exec: boolean | null;
    fee_exempt: boolean | null;
  }[]) {
    // THE SAME TWO EXEMPTIONS EVERY FEE SURFACE APPLIES. /admin/fees, the
    // tournament fee roster and the member's own /fees screen all exclude
    // is_exec and fee_exempt from entry fees; filing a row for them would put
    // a debt on the ledger that all three of those screens then refuse to
    // show — money owed that nobody can see or settle.
    if (player.is_exec || player.fee_exempt) continue;
    if (already.has(player.id)) {
      results.push({ playerId: player.id, created: false, amountCents: null, tierId: null });
      continue;
    }

    const match = selectFeeTier(player.membership_type, tiers);
    rows.push({
      fee_type: 'tournament',
      tournament_id: tournamentId,
      player_id: player.id,
      season_id: seasonId,
      tier_id: match?.tier.id ?? null,
      // Null when nothing priced this entry. Every screen renders that as
      // 'TBD' already, which is the honest reading: the club has not said what
      // this costs. It is NOT zero — telling a member they owe nothing for an
      // event they will be asked to pay for at the door is the failure the
      // player-app money helper was written to avoid.
      amount_cents: match?.tier.amount_cents ?? null,
      // Unpaid. The row is a liability until an exec records the money, and
      // season income counts only rows with paid_at set.
      paid_at: null,
    });
    results.push({
      playerId: player.id,
      created: true,
      amountCents: match?.tier.amount_cents ?? null,
      tierId: match?.tier.id ?? null,
    });
  }

  if (rows.length === 0) return results;

  // A PLAIN INSERT, AND NOT AN UPSERT. club_fees_tournament_player_key is a
  // PARTIAL unique index (… WHERE fee_type = 'tournament'); PostgREST emits
  // ON CONFLICT (cols) with no index predicate, and Postgres cannot infer a
  // partial index from that — an upsert here fails outright with 42P10 rather
  // than doing what it looks like it does.
  //
  // The read above already skipped everyone who has a row, so a conflict only
  // happens in a genuine race: two events entered at once, or the two halves of
  // a pair added in parallel. 23505 then means "somebody else wrote exactly the
  // row I was about to write", which is a success in every way that matters.
  const { error } = await supabase.from('club_fees').insert(rows);
  if (!error) return results;
  if (error.code !== '23505') return results.map((r) => ({ ...r, created: false }));

  // One conflicting row must not take fifteen good ones with it — a bulk
  // "add these players to the event" would otherwise leave most of the entries
  // unbilled because one of them was already billed. Retry singly and keep
  // whatever lands.
  const settled = await Promise.all(
    rows.map(async (row) => {
      const { error: rowError } = await supabase.from('club_fees').insert(row);
      return { playerId: row.player_id as string, ok: !rowError };
    }),
  );
  const wrote = new Set(settled.filter((s) => s.ok).map((s) => s.playerId));
  return results.map((r) => (r.created && !wrote.has(r.playerId) ? { ...r, created: false } : r));
}
