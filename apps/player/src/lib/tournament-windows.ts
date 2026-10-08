import type { SupabaseClient } from '@supabase/supabase-js';
import {
  effectiveWindows,
  windowState,
  type EntryWindow,
  type WindowColumns,
} from '@badminton/shared';

/**
 * The registration and check-in windows (00276), read ON THEIR OWN.
 *
 * Images update before migrations run, so these columns can be missing. They
 * are never added to an existing select or embed: a missing column there
 * fails the whole read and takes the page (or the entry path) with it. A
 * separate read that comes back 42703 / PGRST204 is "no windows", which is
 * exactly the behaviour before 00276. Any other error is a real failure and
 * throws, because an unread window is not an open one.
 *
 * NOT 'use server': every export of such a module is a public action.
 */

const WINDOW_COLUMNS = 'id, registration_opens_at, registration_closes_at, checkin_opens_at, checkin_closes_at';

export interface EntryWindows {
  events: Map<string, WindowColumns>;
  tournaments: Map<string, WindowColumns>;
}

function isColumnMissing(error: { code?: string } | null): boolean {
  return !!error && ['42703', 'PGRST204'].includes(error.code ?? '');
}

export async function loadEntryWindows(
  client: SupabaseClient,
  { eventIds = [], tournamentIds = [] }: { eventIds?: string[]; tournamentIds?: string[] },
): Promise<EntryWindows> {
  const events = new Map<string, WindowColumns>();
  const tournaments = new Map<string, WindowColumns>();
  const ev = [...new Set(eventIds)];
  const tn = [...new Set(tournamentIds)];

  const [eventRes, tournamentRes] = await Promise.all([
    ev.length > 0 ? client.from('tournament_events').select(WINDOW_COLUMNS).in('id', ev) : null,
    tn.length > 0 ? client.from('tournaments').select(WINDOW_COLUMNS).in('id', tn) : null,
  ]);

  for (const [res, into] of [[eventRes, events], [tournamentRes, tournaments]] as const) {
    if (!res) continue;
    if (res.error) {
      if (isColumnMissing(res.error)) return { events: new Map(), tournaments: new Map() };
      throw new Error(`Could not read the entry windows: ${res.error.message}`);
    }
    for (const row of (res.data ?? []) as Array<WindowColumns & { id: string }>) into.set(row.id, row);
  }
  return { events, tournaments };
}

/** One event's effective windows, out of a loaded set. */
export function windowsFor(
  loaded: EntryWindows,
  eventId: string,
  tournamentId: string,
): { registration: EntryWindow; checkin: EntryWindow } {
  return effectiveWindows({ event: loaded.events.get(eventId), tournament: loaded.tournaments.get(tournamentId) });
}

/**
 * What a QR scan does with an entry whose event is in check-in, by the
 * check-in window: claim it, report it pending (not open yet, nothing to act
 * on), or refuse it (closed, the desk is the remedy).
 */
export function classifyScanWindow(window: EntryWindow, now: Date): 'claim' | 'pending' | 'refused' {
  const state = windowState(window.opens_at, window.closes_at, now);
  if (state === 'not_open_yet') return 'pending';
  if (state === 'closed') return 'refused';
  return 'claim';
}
