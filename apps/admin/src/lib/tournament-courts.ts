// A TOURNAMENT'S COURTS, READ (00273). Server side only, and NOT 'use server':
// these are reads the pages and the actions share, not actions themselves.
//
// Every read here degrades to null on a database older than 00273, so a page
// renders and an action keeps the free-text path until the migration is run.

import { courtKey, courtsInOrder, type TournamentCourt } from '@badminton/shared';
import type { createAdminClient } from './supabase-server';

type AdminClient = ReturnType<typeof createAdminClient>;

export const COURTS_MIGRATION_MISSING = 'Run migration 00273 first';

/** The table or the court_id column is not there yet. */
export function isCourtsSchemaMissing(error: { code?: string | null } | null | undefined): boolean {
  return !!error && ['PGRST205', '42P01', '42703', 'PGRST204'].includes(error.code ?? '');
}

/** The tournament's courts in order, inactive ones included; null before 00273. */
export async function readTournamentCourts(client: AdminClient, tournamentId: string): Promise<TournamentCourt[] | null> {
  const { data, error } = await client
    .from('tournament_courts')
    .select('id, label, sort_order, active, notes')
    .eq('tournament_id', tournamentId);
  if (isCourtsSchemaMissing(error)) return null;
  if (error) throw new Error(`Could not read this tournament's courts: ${error.message}`);
  return courtsInOrder(data ?? []);
}

export interface LiveCourtUse {
  id: string;
  event_id: string;
  court: string | null;
  court_id: string | null;
}

/**
 * Every live match in the tournament, across all its events, with its court.
 * A court is busy whichever event's match is on it. Null before 00273.
 */
export async function readLiveCourtUse(client: AdminClient, tournamentId: string): Promise<LiveCourtUse[] | null> {
  const { data, error } = await client
    .from('tournament_matches')
    .select('id, event_id, court, court_id, tournament_events!inner(tournament_id)')
    .eq('tournament_events.tournament_id', tournamentId)
    .eq('status', 'live');
  if (isCourtsSchemaMissing(error)) return null;
  if (error) throw new Error(`Could not read which courts are in use: ${error.message}`);
  return (data ?? []).map((m) => ({ id: m.id, event_id: m.event_id, court: m.court, court_id: m.court_id }));
}

/**
 * The distinct courts already typed on this tournament's unfinished matches,
 * one label per courtKey, in the order first seen. What "Add the courts
 * already used" would create.
 */
export async function readUsedCourtLabels(client: AdminClient, tournamentId: string): Promise<string[]> {
  const { data, error } = await client
    .from('tournament_matches')
    .select('court, tournament_events!inner(tournament_id)')
    .eq('tournament_events.tournament_id', tournamentId)
    .in('status', ['pending', 'ready', 'live'])
    .not('court', 'is', null);
  if (error) throw new Error(`Could not read the courts already in use: ${error.message}`);
  const labels = new Map<string, string>();
  for (const m of data ?? []) {
    const key = courtKey(m.court);
    if (key && !labels.has(key)) labels.set(key, (m.court ?? '').trim());
  }
  return [...labels.values()];
}
