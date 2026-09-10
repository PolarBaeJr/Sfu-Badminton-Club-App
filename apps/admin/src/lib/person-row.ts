// THE ROW THE PERMISSION EDITOR LISTS, AND THE TWO BUILDERS THAT MAKE ONE.
//
// A PURE MODULE RATHER THAN A MAPPING INSIDE A PAGE, for the reason
// console-access-offer.ts gives for itself: vitest in this app runs
// `environment: 'node'` (apps/admin/vitest.config.ts), so a mapping left in a
// page or in a component is a mapping with no test. Nothing here imports React,
// Next or Supabase, which is what lets a test call it at all.
//
// IT EXISTS BECAUSE THERE ARE TWO CALLERS NOW. The editor is embedded on
// /players/[id] as well as hosted on /permissions, and each of them builds the
// same row out of a different select — one that names six columns, one that is
// `select('*')`. Two copies of the mapping would be two places a field can be
// forgotten, and the field that gets forgotten is an optional one: it arrives as
// `undefined` where the editor reads a list, and `undefined.length` is the whole
// screen rather than one wrong row.
import {
  accessLevelFor,
  isBuiltinPermissionRole,
  isCapability,
  isInGoodStanding,
  type AccessLevel,
  type Capability,
  type CustomBaseline,
} from '@/lib/permissions';

export interface PersonRow {
  id: string;
  name: string;
  email: string | null;
  title: string | null;
  // NULL is an ordinary member — somebody with no console access at all. They
  // are listed because giving them some is what this page is for, and their
  // three permission columns are empty by construction: no level means no gate
  // is ever reached, so nothing stored would be consulted.
  level: AccessLevel | null;
  // Standing, not level. A banned or deactivated executive still holds the
  // level and still cannot get through the front door, and a screen describing
  // access nobody has is worse than one that says so.
  canSignIn: boolean;
  role: string | null;
  grants: string[];
  revokes: string[];
  /**
   * Which custom baseline these grants were copied from, or null for a set
   * somebody picked by hand. PROVENANCE, never authority: the resolver does not
   * know the table exists, and clearing this takes nothing away.
   */
  baselineId: string | null;
}

/**
 * As much of a `players` row as personRowFrom reads, spelled out here rather
 * than taken from the generated types: createAdminClient() carries no `Database`
 * generic, so a select result arrives untyped and no shape is imposed on it from
 * anywhere else.
 *
 * EVERY FIELD BUT THE ID IS OPTIONAL, and that is the point of the type rather
 * than an omission in it. The /permissions "others" select fetches six columns —
 * no role, no level flags, no permission columns at all — so a required field
 * would be a compile error on the narrow caller and a promise the wide one keeps
 * only by accident.
 *
 * The level and standing fields are typed rather than left loose because they
 * have to satisfy accessLevelFor() and isInGoodStanding() structurally. Those
 * two declare their own input types, but @/lib/permissions does not re-export
 * them, and spelling six fields out here is better than reaching past the one
 * module this app takes these answers from.
 */
export interface PersonSourceRow {
  id: string;
  full_name?: string | null;
  email?: string | null;
  exec_title?: string | null;
  role?: string | null;
  is_exec?: boolean | null;
  is_trainer?: boolean | null;
  is_banned?: boolean | null;
  status?: string | null;
  active_flag?: boolean | null;
  permission_role?: string | null;
  permission_grants?: string[] | null;
  permission_revokes?: string[] | null;
  permission_baseline_id?: string | null;
}

/**
 * ONE BUILDER FOR BOTH POPULATIONS, and accessLevelFor() is what makes that
 * possible: it returns null for a row with no level markers, which is exactly
 * what an ordinary member's row should read as. A second builder for "the people
 * with no console access" would be a second answer to what a level is.
 *
 * THE DELTAS ARE NOT FILTERED THROUGH THIS BUILD'S VOCABULARY, deliberately, and
 * this is the one line worth reading twice. draftOf() in permission-batch.ts
 * filters them, and isDirty() compares that filtered draft against the row AS
 * STORED — so the raw strings have to survive this far or the comparison has
 * nothing to notice. Filtering here would also quietly shrink the `N custom`
 * badge for anybody carrying a capability the code no longer knows.
 */
export function personRowFrom(row: PersonSourceRow): PersonRow {
  return {
    id: row.id,
    name: row.full_name ?? row.email ?? 'Unnamed',
    email: row.email ?? null,
    title: row.exec_title ?? null,
    level: accessLevelFor(row),
    canSignIn: isInGoodStanding(row),
    role: row.permission_role ?? null,
    grants: row.permission_grants ?? [],
    revokes: row.permission_revokes ?? [],
    baselineId: row.permission_baseline_id ?? null,
  };
}

/** As much of a `permission_baselines` row as customBaselinesFrom reads. */
export interface BaselineSourceRow {
  id: string;
  name: string;
  capabilities?: string[] | null;
  builtin_role?: string | null;
}

/**
 * A baseline as both of its readers want one. `CustomBaseline` is what the
 * editor's picker takes; the mutable `capabilities` is what BaselineRow
 * (baseline-manager.tsx) declares, and widening it back to readonly at the
 * editor's call site costs nothing.
 */
export type BaselineOption = Omit<CustomBaseline, 'capabilities'> & {
  capabilities: Capability[];
};

/**
 * The club's own baselines, FILTERED THROUGH THIS BUILD'S VOCABULARY on the way
 * in exactly as a stored delta is: a string the code no longer knows resolves to
 * nothing, and a baseline offering one would promise a capability the app cannot
 * deliver. Every reader then sees the same list.
 *
 * NO HOLDER COUNT, and that is why this is separate from the mapping on
 * /permissions rather than the whole of it. The count is a question about
 * populations — how many people an edit would reach — and it is only ever asked
 * by the baseline manager, which has those populations in hand. The editor picks
 * baselines; it does not manage them.
 */
export function customBaselinesFrom(rows: BaselineSourceRow[]): BaselineOption[] {
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    capabilities: (row.capabilities ?? []).filter(isCapability),
    builtinRole: isBuiltinPermissionRole(row.builtin_role) ? row.builtin_role : null,
  }));
}
