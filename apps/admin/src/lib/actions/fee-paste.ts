'use server';

// "Paste a list" on /fees, the read half. Writes nothing: marking goes through
// bulkMarkFeesPaid and keeping a named payment through bulkAddManualFees, each
// a loop over the single-record action with its own gate.

import { createAdminClient } from '../supabase-server';
import { parseOrThrow, feePastePreviewSchema, unwrap, unwrapMaybe, ExpectedError } from '@badminton/shared';
import { runAction, type ActionResult } from '../action-result';
import {
  matchPastedPayers,
  parsePastedPayers,
  toFeePastePreview,
  type FeePastePreview,
  type PasteRosterPlayer,
} from '../fee-paste';
import { requireCapability } from './_shared';

const PAGE = 1000;

/**
 * Who a pasted list is, against the season it applies to.
 *
 * EVERY READ IS CHECKED FOR ITS ERROR, and that is the point of this function
 * rather than a detail of it. A PostgREST read that fails arrives as an empty
 * list, and an empty roster makes every line on the paste "not found", which an
 * exec would then reasonably keep as a named payment apiece.
 */
export async function previewFeePaste(input: unknown): Promise<ActionResult<FeePastePreview>> {
  return runAction(async () => {
    const { season_id, text } = parseOrThrow(feePastePreviewSchema, input);
    await requireCapability('fees.clubfees.read');
    const adminClient = createAdminClient();

    const season = unwrapMaybe<{ id: string; name: string; competitive_fee_cents: number; recreational_fee_cents: number }>(
      await adminClient
        .from('seasons')
        .select('id, name, competitive_fee_cents, recreational_fee_cents')
        .eq('id', season_id)
        .maybeSingle(),
      'FEE-105',
    );
    if (!season) throw new ExpectedError('That season no longer exists. Reload the page and try again.');

    // Paged, because the default row cap would otherwise cut the roster short
    // and report whoever sorted past it as not found.
    const players: PasteRosterPlayer[] = [];
    for (let from = 0; ; from += PAGE) {
      const page = unwrap(
        await adminClient
          .from('players')
          .select('id, full_name, first_name, last_name, display_name, email, status, is_exec, fee_exempt, deletion_requested_at')
          .not('email', 'like', '%@deleted.invalid')
          .order('id')
          .range(from, from + PAGE - 1),
        'FEE-105',
      );
      players.push(...page);
      if (page.length < PAGE) break;
    }

    const dues = unwrap(
      await adminClient
        .from('club_fees')
        .select('player_id, manual_name, manual_email, paid_at, method, amount_cents')
        .eq('season_id', season.id)
        // Dues only: the same permission boundary the /fees roster query draws.
        // Reinstatements and entry fees share this table.
        .eq('fee_type', 'dues'),
      'FEE-105',
    );

    const match = matchPastedPayers(parsePastedPayers(text), players, dues);
    return toFeePastePreview(
      {
        id: season.id,
        name: season.name,
        competitiveFeeCents: season.competitive_fee_cents,
        recreationalFeeCents: season.recreational_fee_cents,
      },
      match,
    );
  });
}
