// WHAT CONSOLE ACCESS SOMEBODY HAS, as one question with four answers, and the
// translation between that answer and the three columns that store it.
//
// ONE MAPPING, TWO SCREENS. This began inside the player Edit dialog and moved
// here when /permissions grew a console-access control of its own: two places
// that both turn "Admin" into a role and two booleans is two places that can
// disagree about what Admin means, and a disagreement there is a privilege bug
// rather than a rendering one.
//
// NOT a 'use server' module and deliberately free of any Supabase, Next or React
// import — a server action and a client component both import it, which is the
// same rule ./player-field-access.ts states for itself.
//
// This module does NOT write anything and is not a boundary. The three columns
// it names are the hard floor in ./player-field-access.ts, refused to anyone
// below admin under all circumstances and reachable by no capability; the write
// goes through updatePlayer(), which is where that floor is enforced.
import { accessLevelFor, type AccessLevel } from '@badminton/shared/src/utils/access-level';

/** The four answers, in the order they are offered. */
export type ExecRole = 'none' | 'executive' | 'trainer' | 'admin';

// ONE question — what console access does this person have — instead of a
// role select, an is_exec flag and a trainer switch that had to be combined in
// the reader's head. "Admin + Executive" is gone because admin already outranks
// exec everywhere (accessLevelFor resolves the highest level held, and
// atLeast() orders admin > exec > trainer), so the pair was never a distinct
// state — only a way to get it wrong.
export const EXEC_ROLE_OPTIONS: { value: ExecRole; label: string }[] = [
  { value: 'none', label: 'None — ordinary member' },
  { value: 'executive', label: 'Executive' },
  { value: 'trainer', label: 'Varsity trainer' },
  { value: 'admin', label: 'Admin' },
];

export function toRoleValue(role: string, isExec: boolean, isTrainer: boolean): ExecRole {
  if (role === 'admin') return 'admin';
  if (isExec) return 'executive';
  if (isTrainer) return 'trainer';
  return 'none';
}

// Admin implies is_exec: an admin already has every exec power, and the club's
// admin sits on the exec team, so they belong on the public /exec page too.
export function fromRoleValue(v: ExecRole): { role: 'player' | 'admin'; is_exec: boolean; is_trainer: boolean } {
  switch (v) {
    case 'admin':     return { role: 'admin',  is_exec: true,  is_trainer: false };
    case 'executive': return { role: 'player', is_exec: true,  is_trainer: false };
    case 'trainer':   return { role: 'player', is_exec: false, is_trainer: true };
    default:          return { role: 'player', is_exec: false, is_trainer: false };
  }
}

/**
 * The same four answers, for a caller holding the LEVEL a row resolved to rather
 * than the three raw columns — which is what /permissions has, because it builds
 * its rows through accessLevelFor().
 *
 * DERIVED RATHER THAN WRITTEN OUT, and that is the whole reason it is three
 * lines of search instead of a switch. A fourth hand-written mapping between
 * these four states and the level ladder is a fourth thing that can disagree
 * about what Admin means; running fromRoleValue() through accessLevelFor() makes
 * this the inverse of the mapping above by construction, so it cannot drift from
 * it even if either one is edited.
 *
 * Falls back to 'none' — the answer that hands out nothing — for a level the
 * four cannot produce.
 */
export function accessForLevel(level: AccessLevel | null): ExecRole {
  return EXEC_ROLE_OPTIONS.find((o) => accessLevelFor(fromRoleValue(o.value)) === level)?.value
    ?? 'none';
}
