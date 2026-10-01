'use server';

// A TEAM'S CATEGORY in a staged event (00272): what the stage's head starts
// read for it. Set by the organiser on the participants tab.
//
// Once the team has played (or walked over, or been walked over) a match with
// head starts, its category is fixed: that score was judged by the starts the
// old category gave, and changing it would leave a result nobody can check.
// Until then a change is re-snapshotted onto the team's unplayed matches.

import { createAdminClient } from '../supabase-server';
import { logAudit } from '../audit';
import { runAction, type ActionResult } from '../action-result';
import { ExpectedError, isDoublesEvent, parseFormatConfig } from '@badminton/shared';
import {
  requireCapability,
  revalidateEventPaths,
  assertTournamentNotSuspended,
  mustWrite,
  refreshStagedHandicaps,
} from './_internal';

const MIGRATION_MISSING = 'Run migration 00272 first';

function isSchemaMissing(error: { code?: string } | null): boolean {
  return !!error && ['42703', 'PGRST204'].includes(error.code ?? '');
}

/** Set (or clear, with null) the category of one team in a staged event. */
export async function setPairCategory(
  pairId: string,
  category: string | null,
): Promise<ActionResult<{ changed: boolean; rehandicapped: number }>> {
  return runAction(() => setPairCategoryImpl(pairId, category));
}

async function setPairCategoryImpl(pairId: unknown, category: unknown) {
  const admin = await requireCapability('tournaments.draw.seed.set.write');
  const adminClient = createAdminClient();

  if (typeof pairId !== 'string' || pairId.length === 0) throw new ExpectedError('That team is no longer in this event.');
  if (category != null && typeof category !== 'string') throw new ExpectedError('Choose a category from the list.');
  const next = typeof category === 'string' && category.trim() !== '' ? category.trim() : null;

  const { data: pair, error: pairError } = await adminClient.from('tournament_pairs')
    .select('id, event_id, pair_name, team_category')
    .eq('id', pairId)
    .maybeSingle();
  if (isSchemaMissing(pairError)) throw new ExpectedError(MIGRATION_MISSING);
  if (pairError) throw new Error(`Could not read the team: ${pairError.message}`);
  if (!pair) throw new ExpectedError('That team is no longer in this event.');

  const { data: event, error: eventError } = await adminClient.from('tournament_events')
    .select('*').eq('id', pair.event_id).maybeSingle();
  if (eventError) throw new Error(`Could not read the event: ${eventError.message}`);
  if (!event) throw new Error('Event not found');
  if (event.format !== 'staged' || !isDoublesEvent(event.event_type)) {
    throw new ExpectedError('A category applies to teams in a staged doubles event only.');
  }
  if (event.draw_locked) throw new ExpectedError('Draw is locked. Unlock it before making changes.');
  if (event.status === 'completed') throw new ExpectedError('This event has been finalised, so its teams cannot change.');
  await assertTournamentNotSuspended(adminClient, event.tournament_id);

  const cfg = parseFormatConfig(event.format_config);
  if (!cfg) throw new ExpectedError('This event\'s stages are not set out correctly. Fix them in the event settings first.');
  if (next !== null && !cfg.categories.some((c) => c.key === next)) {
    throw new ExpectedError(`"${next}" is not a category of this event.`);
  }

  const from = (pair.team_category as string | null) ?? null;
  if (from === next) return { changed: false, rehandicapped: 0 };

  const { data: rows, error: matchError } = await adminClient.from('tournament_matches')
    .select('id, stage, status, is_bye, pair_a_id, pair_b_id')
    .eq('event_id', event.id)
    .not('stage', 'is', null);
  if (matchError) throw new Error(`Could not read the event's matches: ${matchError.message}`);
  const own = (rows ?? []).filter((m) => m.pair_a_id === pairId || m.pair_b_id === pairId);
  const handicapped = (stage: number | null) => stage != null && cfg.stages[stage - 1]?.scoring.handicap === true;

  if (own.some((m) => handicapped(m.stage) && (m.status === 'live' || m.status === 'completed') && !m.is_bye)) {
    throw new ExpectedError(`${pair.pair_name ?? 'This team'} has already played with head starts, so its category is fixed.`);
  }

  await mustWrite(
    'Setting the team\'s category',
    adminClient.from('tournament_pairs').update({ team_category: next }).eq('id', pairId).select('id'),
  );

  const open = own.filter((m) => handicapped(m.stage) && (m.status === 'pending' || m.status === 'ready'));
  for (const m of open) {
    await refreshStagedHandicaps(adminClient, m.id, true, { onlyOpen: true });
  }

  await logAudit(adminClient, {
    tournament_id: event.tournament_id,
    event_id: event.id,
    action: 'pair_category_changed',
    performed_by: admin.id,
    details: { pair_id: pairId, from, to: next, rehandicapped: open.length },
  });

  revalidateEventPaths(event.tournament_id, event.id);
  return { changed: true, rehandicapped: open.length };
}
