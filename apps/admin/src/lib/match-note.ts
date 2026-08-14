// THE EXEC'S OWN WORDS ABOUT A MATCH, AND WHO MAY SEE THEM.
//
// A plain module rather than helpers inside lib/actions/matches.ts, for the
// reason lib/audit-reason.ts gives for existing: action files are 'use server'
// and may only export async functions, so a predicate or a constant declared
// there can neither be shared with the page nor unit-tested. Both halves of
// this file are shared — the page reads notes, the actions write them — and
// both are tested.
//
// WHAT MOVED, AND WHY. The note used to be `matches.admin_note`, a column on a
// table whose SELECT policy is `USING (TRUE)` with no column grant against it,
// which made it readable by every signed-in member and — since 00114 published
// `matches` — streamable to every Realtime subscriber. Migration 00117 moves it
// to `match_admin_notes`, which holds no grant for `authenticated`, has RLS on
// with no policy, and is deliberately absent from `supabase_realtime`. See that
// file for why a column-grant revoke could not have done this job.

import { permits, type AccessLevel, type Capability, type Permissions } from './permissions';
// The missing-table predicate, shared with 00118's four tables so the two
// modules cannot drift on the one question they must agree about.
import { isMissingTableError } from './private-notes';
// TYPE-ONLY, and it has to stay that way. supabase-server.ts reaches for
// next/headers and the passkey cookie machinery at import time; a value import
// here would drag all of it into the unit tests, which have no request to read
// cookies from. `import type` is erased entirely.
import type { createAdminClient } from './supabase-server';

/** The table 00117 creates. Named once so the actions and the page agree. */
export const MATCH_ADMIN_NOTE_TABLE = 'match_admin_notes';

// WHO MAY READ A NOTE: WHOEVER MAY AUTHOR ONE.
//
// Three console actions write this text, each behind its own capability —
// adminCreateMatch (the "Admin Note (optional)" box on the entry form),
// voidMatch and convertMatchToCasual (the reason each records). No single
// capability covers all three, so gating the READ on any one of them would
// leave an exec who wrote a note unable to read it back: a void-only officer
// would type a reason into the void dialog and then find the ledger silent
// about it.
//
// `matches.page` was the obvious alternative and is wrong. It is the LEDGER
// READ — held by anyone allowed merely to look at the club's results, and in
// EXEC_BASELINE terms a strictly wider audience than the three writes. Reusing
// it would hand the notes back to roughly the population this change exists to
// exclude.
//
// NO NEW CAPABILITY. A new string is a vocabulary migration (the CHECK
// constraints on players.permission_grants / permission_revokes and
// permission_baselines.capabilities enumerate every legal value), plus a place
// in EDITOR_OFFERABLE, plus a decision about each baseline — all to re-answer a
// question these three strings already answer. 00117's header states the same
// reasoning from the database's side.
export const MATCH_NOTE_READ_CAPABILITIES: readonly Capability[] = [
  'matches.create.write',
  'matches.void.write',
  'matches.convert.write',
];

/**
 * May this viewer read match admin notes?
 *
 * A UNION, which is the one place in this console that ORs capabilities
 * together. That is deliberate rather than sloppy: the rule being expressed is
 * "you may read what you may write", and the thing written has three writers.
 * An admin passes before any set is consulted — permits() short-circuits on the
 * level.
 */
export function canReadMatchNotes(level: AccessLevel | null, permissions: Permissions): boolean {
  if (level === null) return false;
  return MATCH_NOTE_READ_CAPABILITIES.some((c) => permits(level, permissions, c));
}

/**
 * "PostgREST/Postgres has never heard of this table."
 *
 * The one failure a read or a write of `match_admin_notes` is allowed to shrug
 * off, because 00117 is applied by hand and this console is routinely deployed
 * ahead of it.
 *
 * THIS IS A DIFFERENT FAMILY FROM 00116's, and copying that predicate would
 * have missed it. `isUnknownColumnError` in lib/actions/sessions.ts swallows
 * PGRST204 and 42703 — a missing COLUMN on a table that exists. Here the whole
 * TABLE is absent, which PostgREST answers out of its schema cache as PGRST205
 * ("Could not find the table 'public.match_admin_notes' in the schema cache"),
 * or as PGRST202 on a client whose reader predates that code, and which
 * Postgres itself raises as 42P01 (undefined_table) if the statement gets past
 * the cache.
 *
 * EVERYTHING ELSE IS RETHROWN, and that is the point of naming codes at all. A
 * blanket catch would mean that once 00117 is applied a genuine failure — a
 * constraint, a connection, a permission — still ends in a green "Match
 * created" toast, and the exec walks away believing a note was recorded that
 * was not. That is the same fiction this feature exists to prevent, arriving
 * through the console instead of through the database.
 *
 * THE BODY MOVED TO lib/private-notes.ts WITH 00118, which needed the identical
 * question asked about four more tables. This stays as the name the /matches
 * call sites already use, bound to this table; the parameterised version is the
 * one thing the two modules genuinely must not answer differently, so there is
 * only one of it. Behaviour is unchanged — the general form takes the table
 * name that the message backstop used to hard-code.
 */
export function isMissingNoteTableError(
  error: { code?: string | null; message?: string | null } | null | undefined,
): boolean {
  return isMissingTableError(error, MATCH_ADMIN_NOTE_TABLE);
}

/** One match's note, as the ledger renders it. */
export interface MatchNote {
  match_id: string;
  note: string;
}

/**
 * The notes for the matches on screen, keyed by match id.
 *
 * Returns an EMPTY MAP for a database without the table, so /matches renders
 * normally when the console is deployed ahead of 00117 — the ledger's job is
 * the ledger, and a missing optional annotation must not empty it. Any other
 * error is thrown, where the page's own error handling can see it.
 *
 * The caller is responsible for the capability check. It is not done in here on
 * purpose: this takes a Supabase client, and a function that both authorises
 * and fetches invites a call site that passes the check it wants.
 */
export async function fetchMatchNotes(
  // THE CLIENT'S OWN TYPE, not a structural "anything with .from()". A minimal
  // shape reads better and does not compile: assigning the real client to it
  // makes tsc walk PostgREST's generic query builder and give up with "Type
  // instantiation is excessively deep and possibly infinite" — at the call
  // site, in a file that has nothing to do with this. Naming the type it
  // already is makes the check an identity. The tests pass a stub through
  // `as never`, which is the honest way to say "this is a fake".
  client: ReturnType<typeof createAdminClient>,
  matchIds: string[],
): Promise<Map<string, string>> {
  if (matchIds.length === 0) return new Map();

  const { data, error } = await client
    .from(MATCH_ADMIN_NOTE_TABLE)
    .select('match_id, note')
    .in('match_id', matchIds);

  if (error) {
    if (isMissingNoteTableError(error)) return new Map();
    throw new Error(error.message ?? 'Failed to read match notes');
  }

  const rows = (data ?? []) as MatchNote[];
  return new Map(rows.map((row) => [row.match_id, row.note]));
}
