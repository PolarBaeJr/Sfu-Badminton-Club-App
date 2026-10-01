'use server';

// A TOURNAMENT'S COURTS (00273): adding, renaming, ordering and switching them
// off. The desk picks from these, a staged draw's court labels must name them,
// and the database refuses two live matches on one court.
//
// Courts are never deleted, only deactivated, so a finished match keeps the
// court it was played on. Every courtId below is a client-controlled POST
// field, so each action reads the court back and works on the tournament it
// actually belongs to.

import * as Sentry from '@sentry/nextjs';
import { revalidatePath } from 'next/cache';
import {
  COURTS_ADD_MAX,
  ExpectedError,
  courtKey,
  courtLabel,
  courtLabelIssues,
  courtsInOrder,
  type TournamentCourt,
} from '@badminton/shared';
import { createAdminClient } from '../supabase-server';
import { logAudit } from '../audit';
import { runAction, type ActionResult } from '../action-result';
import { COURTS_MIGRATION_MISSING, isCourtsSchemaMissing, readTournamentCourts } from '../tournament-courts';
import { requireCapability, assertTournamentNotSuspended } from './_internal';

type AdminClient = ReturnType<typeof createAdminClient>;

const CAPABILITY = 'tournaments.manage.update.write';

async function courtsOrRefuse(adminClient: AdminClient, tournamentId: string): Promise<TournamentCourt[]> {
  const courts = await readTournamentCourts(adminClient, tournamentId);
  if (courts === null) throw new ExpectedError(COURTS_MIGRATION_MISSING);
  return courts;
}

/** The court, and the tournament it really belongs to. */
async function readCourt(adminClient: AdminClient, courtId: string): Promise<TournamentCourt & { tournament_id: string }> {
  const { data, error } = await adminClient
    .from('tournament_courts')
    .select('id, tournament_id, label, sort_order, active, notes')
    .eq('id', courtId)
    .maybeSingle();
  if (isCourtsSchemaMissing(error)) throw new ExpectedError(COURTS_MIGRATION_MISSING);
  if (error) throw new Error(`Could not read the court: ${error.message}`);
  if (!data) throw new ExpectedError('Court not found');
  return data;
}

function refuseIssues(issues: string[]): void {
  if (issues.length > 0) throw new ExpectedError(issues.join(' '));
}

// The label backstop index (tournament_courts_label_key) answering a race the
// app-side check could not see.
function duplicateRefusal(label: string): ExpectedError {
  return new ExpectedError(`There is already a court called ${courtLabel(label) ?? label}.`);
}

/** The tournament page, and every event page, whose desk lists these courts. */
async function revalidateCourtPaths(adminClient: AdminClient, tournamentId: string): Promise<void> {
  revalidatePath(`/tournaments/${tournamentId}`);
  const { data } = await adminClient.from('tournament_events').select('id').eq('tournament_id', tournamentId);
  for (const ev of data ?? []) revalidatePath(`/tournaments/${tournamentId}/events/${ev.id}`);
}

export async function addTournamentCourts(tournamentId: string, labels: string[]): Promise<ActionResult<void>> {
  return runAction(async () => { await addTournamentCourtsImpl(tournamentId, labels); });
}

async function addTournamentCourtsImpl(tournamentId: string, labels: string[]) {
  const admin = await requireCapability(CAPABILITY);
  const adminClient = createAdminClient();
  await assertTournamentNotSuspended(adminClient, tournamentId);

  const wanted = labels.map((l) => l.trim());
  if (wanted.length === 0) throw new ExpectedError('Name at least one court.');
  if (wanted.length > COURTS_ADD_MAX) throw new ExpectedError(`Add at most ${COURTS_ADD_MAX} courts at a time.`);

  const courts = await courtsOrRefuse(adminClient, tournamentId);
  refuseIssues(courtLabelIssues(wanted, courts.map((c) => c.label)));

  const start = courts.reduce((n, c) => Math.max(n, c.sort_order), 0) + 1;
  const { data: added, error } = await adminClient
    .from('tournament_courts')
    .insert(wanted.map((label, i) => ({ tournament_id: tournamentId, label, sort_order: start + i })))
    .select('id, label');
  if (error?.code === '23505') throw new ExpectedError('One of those courts was added by somebody else just now. Reload and try again.');
  if (isCourtsSchemaMissing(error)) throw new ExpectedError(COURTS_MIGRATION_MISSING);
  if (error) {
    Sentry.captureException(error);
    throw new Error(`Could not add the courts: ${error.message}`);
  }

  await logAudit(adminClient, {
    tournament_id: tournamentId,
    action: 'court_added',
    performed_by: admin.id,
    details: { courts: (added ?? []).map((c) => ({ id: c.id, label: c.label })) },
  });
  await revalidateCourtPaths(adminClient, tournamentId);
}

export async function renameTournamentCourt(courtId: string, label: string): Promise<ActionResult<void>> {
  return runAction(async () => { await renameTournamentCourtImpl(courtId, label); });
}

async function renameTournamentCourtImpl(courtId: string, label: string) {
  const admin = await requireCapability(CAPABILITY);
  const adminClient = createAdminClient();
  const court = await readCourt(adminClient, courtId);
  await assertTournamentNotSuspended(adminClient, court.tournament_id);

  const next = label.trim();
  if (next === court.label) return;
  const courts = await courtsOrRefuse(adminClient, court.tournament_id);
  refuseIssues(courtLabelIssues([next], courts.filter((c) => c.id !== courtId).map((c) => c.label)));

  // Guarded on the label we read, so two renames at once cannot both land and
  // the audit's previous label is the one that was replaced. The rename reaches
  // the unfinished matches on this court by trigger (tournament_courts_label_sync).
  const { data: updated, error } = await adminClient
    .from('tournament_courts')
    .update({ label: next, updated_at: new Date().toISOString() })
    .eq('id', courtId)
    .eq('label', court.label)
    .select('id')
    .maybeSingle();
  if (error?.code === '23505') throw duplicateRefusal(next);
  if (error) {
    Sentry.captureException(error);
    throw new Error(`Could not rename the court: ${error.message}`);
  }
  if (!updated) throw new ExpectedError('Somebody else changed this court just now. Reload and try again.');

  await logAudit(adminClient, {
    tournament_id: court.tournament_id,
    action: 'court_renamed',
    performed_by: admin.id,
    details: { court_id: courtId, previous_label: court.label, label: next },
  });
  await revalidateCourtPaths(adminClient, court.tournament_id);
}

export async function moveTournamentCourt(courtId: string, direction: 'up' | 'down'): Promise<ActionResult<void>> {
  return runAction(async () => { await moveTournamentCourtImpl(courtId, direction); });
}

async function moveTournamentCourtImpl(courtId: string, direction: 'up' | 'down') {
  const admin = await requireCapability(CAPABILITY);
  const adminClient = createAdminClient();
  const court = await readCourt(adminClient, courtId);
  await assertTournamentNotSuspended(adminClient, court.tournament_id);

  const order = courtsInOrder(await courtsOrRefuse(adminClient, court.tournament_id));
  const at = order.findIndex((c) => c.id === courtId);
  const to = direction === 'up' ? at - 1 : at + 1;
  if (at < 0 || to < 0 || to >= order.length) return;
  [order[at], order[to]] = [order[to]!, order[at]!];

  // Renumbered 1..n rather than swapped, so courts added with the same order
  // number still move one place at a time.
  const moved = order.map((c, i) => ({ c, sort_order: i + 1 })).filter(({ c, sort_order }) => c.sort_order !== sort_order);
  for (const { c, sort_order } of moved) {
    const { error } = await adminClient.from('tournament_courts').update({ sort_order }).eq('id', c.id);
    if (error) {
      Sentry.captureException(error);
      throw new Error(`Could not reorder the courts: ${error.message}`);
    }
  }

  await logAudit(adminClient, {
    tournament_id: court.tournament_id,
    action: 'court_reordered',
    performed_by: admin.id,
    details: { court_id: courtId, direction, order: order.map((c) => c.label) },
  });
  await revalidateCourtPaths(adminClient, court.tournament_id);
}

export async function setTournamentCourtActive(courtId: string, active: boolean): Promise<ActionResult<void>> {
  return runAction(async () => { await setTournamentCourtActiveImpl(courtId, active); });
}

async function setTournamentCourtActiveImpl(courtId: string, active: boolean) {
  const admin = await requireCapability(CAPABILITY);
  const adminClient = createAdminClient();
  const court = await readCourt(adminClient, courtId);
  await assertTournamentNotSuspended(adminClient, court.tournament_id);
  if (court.active === active) return;

  // Matches already on the court keep it; an inactive court is only taken off
  // the desk's list and out of new draws.
  const { error } = await adminClient
    .from('tournament_courts')
    .update({ active, updated_at: new Date().toISOString() })
    .eq('id', courtId);
  if (error) {
    Sentry.captureException(error);
    throw new Error(`Could not change the court: ${error.message}`);
  }

  await logAudit(adminClient, {
    tournament_id: court.tournament_id,
    action: active ? 'court_reactivated' : 'court_deactivated',
    performed_by: admin.id,
    details: { court_id: courtId, label: court.label },
  });
  await revalidateCourtPaths(adminClient, court.tournament_id);
}

const LINK_CHUNK = 200;

/**
 * "Add the courts already used": one court per distinct court typed on the
 * tournament's unfinished matches, then those matches linked to it. Linking
 * rewrites each match's text to the court's label by trigger, so "Court 3" and
 * "3" on two matches both read as the one label afterwards.
 */
export async function importCourtsFromMatches(tournamentId: string): Promise<ActionResult<void>> {
  return runAction(async () => { await importCourtsFromMatchesImpl(tournamentId); });
}

async function importCourtsFromMatchesImpl(tournamentId: string) {
  const admin = await requireCapability(CAPABILITY);
  const adminClient = createAdminClient();
  await assertTournamentNotSuspended(adminClient, tournamentId);

  const courts = await courtsOrRefuse(adminClient, tournamentId);
  if (courts.length > 0) throw new ExpectedError('This tournament already has courts. Add any others by name.');

  const { data: matches, error: readError } = await adminClient
    .from('tournament_matches')
    .select('id, court, tournament_events!inner(tournament_id)')
    .eq('tournament_events.tournament_id', tournamentId)
    .in('status', ['pending', 'ready', 'live'])
    .not('court', 'is', null);
  if (readError) throw new Error(`Could not read the courts already in use: ${readError.message}`);

  type Used = { label: string; ids: string[] };
  const byKey = new Map<string, Used>();
  for (const m of (matches ?? []) as Array<{ id: string; court: string | null }>) {
    const key = courtKey(m.court);
    if (!key) continue;
    const entry: Used = byKey.get(key) ?? { label: (m.court ?? '').trim(), ids: [] };
    entry.ids.push(m.id);
    byKey.set(key, entry);
  }
  const usable = [...byKey.values()].filter((e) => courtLabelIssues([e.label]).length === 0);
  const skipped = [...byKey.values()].filter((e) => courtLabelIssues([e.label]).length > 0).map((e) => e.label);
  if (usable.length === 0) {
    throw new ExpectedError(skipped.length > 0
      ? `No court could be added: ${skipped.join(', ')} ${skipped.length === 1 ? 'is' : 'are'} longer than a court name may be.`
      : 'No unfinished match has a court yet.');
  }
  if (usable.length > COURTS_ADD_MAX) throw new ExpectedError(`More than ${COURTS_ADD_MAX} different courts are in use, so add them by name.`);

  const { data: added, error } = await adminClient
    .from('tournament_courts')
    .insert(usable.map((e, i) => ({ tournament_id: tournamentId, label: e.label, sort_order: i + 1 })))
    .select('id, label');
  if (error?.code === '23505') throw new ExpectedError('Somebody added courts just now. Reload and try again.');
  if (isCourtsSchemaMissing(error)) throw new ExpectedError(COURTS_MIGRATION_MISSING);
  if (error) {
    Sentry.captureException(error);
    throw new Error(`Could not add the courts: ${error.message}`);
  }

  const idOf = new Map((added ?? []).map((c) => [courtKey(c.label), c.id]));
  const clashes: string[] = [];
  let linked = 0;
  for (const e of usable) {
    const courtId = idOf.get(courtKey(e.label));
    if (!courtId) continue;
    for (let i = 0; i < e.ids.length; i += LINK_CHUNK) {
      const { data, error: linkError } = await adminClient
        .from('tournament_matches')
        .update({ court_id: courtId, updated_at: new Date().toISOString() })
        .in('id', e.ids.slice(i, i + LINK_CHUNK))
        .select('id');
      // Two matches already live on this court: the one-live-per-court index
      // refuses linking them. The court stays; its matches stay on the text.
      if (linkError?.code === '23505') { clashes.push(e.label); break; }
      if (linkError) {
        Sentry.captureException(linkError);
        throw new Error(`The courts were added, but linking their matches failed: ${linkError.message}`);
      }
      linked += data?.length ?? 0;
    }
  }

  await logAudit(adminClient, {
    tournament_id: tournamentId,
    action: 'courts_imported',
    performed_by: admin.id,
    details: {
      courts: (added ?? []).map((c) => ({ id: c.id, label: c.label })),
      matches_linked: linked,
      skipped,
      not_linked: clashes,
    },
  });
  await revalidateCourtPaths(adminClient, tournamentId);

  // Said after the work is saved, as a refusal so the editor shows it.
  const notes: string[] = [];
  if (clashes.length > 0) {
    notes.push(`${clashes.map((l) => courtLabel(l) ?? l).join(', ')} ${clashes.length === 1 ? 'has' : 'have'} two matches on court at once, so ${clashes.length === 1 ? 'its' : 'their'} matches were left as typed. Finish or take one off court, then set the court again at the desk.`);
  }
  if (skipped.length > 0) {
    notes.push(`${skipped.join(', ')} ${skipped.length === 1 ? 'is' : 'are'} longer than a court name may be, so ${skipped.length === 1 ? 'it was' : 'they were'} not added.`);
  }
  if (notes.length > 0) throw new ExpectedError(`The courts were added. ${notes.join(' ')}`);
}
