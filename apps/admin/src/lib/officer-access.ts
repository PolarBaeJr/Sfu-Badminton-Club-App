// WHO CAN DO THE DANGEROUS THINGS, counted over real capability data.
//
// The /accounts access card answers one question — "if something went wrong
// tonight, how many people could have done it?" — and it has to answer it from
// the same sets the gates read, never from role names. `is_exec` stopped being
// an answer to "can this person ban somebody" the day permissions became
// composable: a restricted exec may hold `players.read` and nothing else, and
// an admin holds everything by LEVEL without a stored set at all. Only
// effectiveCapabilities() knows the difference, so only it is asked.
//
// Pure and dependency-free apart from the vocabulary, so the page's headline
// figures can be tested without a database or a React tree.
import {
  accessLevelFor,
  effectiveCapabilities,
  isInGoodStanding,
  permissionsOf,
  type AccessLevel,
  type Capability,
  type PermissionsInput,
} from './permissions';
// AccessLevelInput and StandingInput are not among the types ./permissions
// re-exports, and widening that barrel for two type-only names would touch a
// module the edge middleware pulls in. Deep import, same as permission-editor
// does for CAPABILITY_GATES below.
import type {
  AccessLevelInput,
  StandingInput,
} from '@badminton/shared/src/utils/access-level';
import { CAPABILITY_GATES } from '@badminton/shared/src/utils/capability-gates';

/** Everything the summary needs off a player row. */
export type OfficerInput = AccessLevelInput & StandingInput & PermissionsInput;

// ONE CAPABILITY PER ROW, and that is the rule rather than a shortcut.
//
// The mockup asked for "CAN TOUCH MONEY", which is a judgement about which of
// the eighteen `fees.*` capabilities count as touching money — a judgement that
// drifts silently the moment a nineteenth is added, and drifts in the direction
// of under-reporting. A row that names exactly one capability cannot drift: the
// figure beside it is the size of the set that holds that string, and the
// vocabulary is a closed union so a rename is a compile error here.
//
// Chosen as the five acts an officer would most want a count of before handing
// somebody the console — the two that rewrite a member's record, the one that
// takes their money, the one that removes them, and the one that hands out the
// other four.
export const DANGEROUS_CAPABILITIES: readonly Capability[] = [
  'players.update.write',
  'players.ban.write',
  'players.remove.write',
  'fees.clubfees.markpaid.write',
  'permissions.write',
];

// The capability whose count is promoted into the card's headline. Banning is
// the act the club asked about first and the only one on this list that a
// member notices the same evening.
export const HEADLINE_CAPABILITY: Capability = 'players.ban.write';

export type AccessCountRow = {
  capability: Capability;
  /** CAPABILITY_GATES' own wording — never a second phrasing of the same act. */
  label: string;
  count: number;
};

export type OfficerAccessSummary = {
  /** Everyone holding a console level, whether or not they can sign in. */
  total: number;
  /** Level AND standing — the people who could act right now. */
  active: number;
  /** total - active. Non-zero means the counts below exclude somebody. */
  withheld: number;
  headline: number;
  rows: AccessCountRow[];
};

/**
 * The counts behind ACCESS RIGHT NOW.
 *
 * STANDING IS PART OF THE QUESTION. A banned exec still resolves to the exec
 * level — accessLevelFor deliberately ignores standing — but
 * getAuthenticatedConsolePlayer refuses them at the door, so counting them
 * among the people who "can ban a member" would overstate the club's exposure
 * by naming somebody the console will not let in. They stay in `total`, and
 * `withheld` is what lets the card say so rather than quietly differing from
 * the table beside it.
 */
export function officerAccessSummary(officers: readonly OfficerInput[]): OfficerAccessSummary {
  const sets = officers
    .filter((person) => isInGoodStanding(person))
    .map((person) => effectiveCapabilities(
      accessLevelFor(person),
      permissionsOf(accessLevelFor(person), person),
    ));

  const rows = DANGEROUS_CAPABILITIES.map((capability) => ({
    capability,
    label: CAPABILITY_GATES[capability].label,
    count: sets.filter((set) => set.has(capability)).length,
  }));

  return {
    total: officers.length,
    active: sets.length,
    withheld: officers.length - sets.length,
    headline: sets.filter((set) => set.has(HEADLINE_CAPABILITY)).length,
    rows,
  };
}

/** The level a row resolves to, or null — re-exported so pages never re-derive it. */
export function officerLevel(person: OfficerInput): AccessLevel | null {
  return accessLevelFor(person);
}

// ---------------------------------------------------------------------------
// WHICH AUDIT ROWS ARE ACCESS CHANGES
// ---------------------------------------------------------------------------
// Two actions change who can do what, and they write two different action
// types, because only one of them is a capability change:
//
//   setPlayerPermissions  → 'player_permissions_changed', always an access change.
//   setConsoleAccess      → composes updatePlayer(), so it writes
//                           'player_updated' — the SAME type as renaming a
//                           member or fixing their email.
//
// So `player_updated` cannot be taken wholesale. It is filtered on whether the
// new value touched one of the three hard-floor columns, which is exactly what
// setConsoleAccess writes through fromRoleValue() and what nothing else in the
// console is allowed to write. Done in TypeScript over a fetched page of rows
// rather than as a PostgREST `new_value->>is_exec` filter: a filter PostgREST
// refuses comes back as `data: null` with the error unread, which renders as
// "no access changes yet" — the silent-nothing-happened failure this codebase
// keeps writing comments about.
const CONSOLE_LEVEL_COLUMNS = ['role', 'is_exec', 'is_trainer'] as const;

export type AuditRowShape = {
  action_type: string;
  new_value?: unknown;
};

export function isAccessChange(log: AuditRowShape): boolean {
  if (log.action_type === 'player_permissions_changed') return true;
  // A roster claim deciding what a pre-added row's privileges become IS an
  // access change, and its absence here is most of why the 2026-08-15 incident
  // went unnoticed for a day: the claim wrote its audit row faithfully, and this
  // card — the one screen that exists to answer "who was given what, and when" —
  // filtered it out before it was ever examined. Both the current action type
  // (00132) and the one it replaces are listed, so the history stays readable.
  if (
    log.action_type === 'roster_claim_privileges_reviewed'
    || log.action_type === 'roster_row_claimed_privileges_stripped'
  ) return true;
  // The roster dialog's is_exec toggle goes through updatePlayerFlags, which
  // writes `player_flags_updated` (fees.ts:43) rather than `player_updated`.
  // Without this line, GRANTING somebody exec from the roster was as invisible
  // on this card as the claim taking it away was — the same failure in the
  // opposite direction, and the reason the same column test runs for both.
  if (log.action_type !== 'player_updated' && log.action_type !== 'player_flags_updated') return false;
  const next = log.new_value;
  if (typeof next !== 'object' || next === null) return false;
  return CONSOLE_LEVEL_COLUMNS.some((column) => column in (next as Record<string, unknown>));
}

/** The action types worth fetching before `isAccessChange` narrows them. */
export const ACCESS_CHANGE_ACTION_TYPES = [
  'player_permissions_changed',
  'player_updated',
  'player_flags_updated',
  'roster_claim_privileges_reviewed',
  'roster_row_claimed_privileges_stripped',
] as const;

/**
 * How many capabilities a permission change added and removed.
 *
 * The stored triple does not answer "what did this do" — a role is a name whose
 * contents live in code — so setPlayerPermissions snapshots the RESOLVED set on
 * both sides, and its own comment calls that "the only thing in this row that
 * cannot go stale". This reads it back.
 *
 * Returns null for a row that has no resolved sets, which is every
 * `player_updated` row and any permissions row written before that snapshot
 * existed. A null renders as nothing rather than as "0 added, 0 removed" — the
 * two are not the same claim.
 */
export function capabilityDelta(
  oldValue: unknown,
  newValue: unknown,
): { added: number; removed: number } | null {
  const before = effectiveList(oldValue);
  const after = effectiveList(newValue);
  if (before === null || after === null) return null;
  const had = new Set(before);
  const has = new Set(after);
  return {
    added: after.filter((capability) => !had.has(capability)).length,
    removed: before.filter((capability) => !has.has(capability)).length,
  };
}

function effectiveList(value: unknown): string[] | null {
  if (typeof value !== 'object' || value === null) return null;
  const effective = (value as Record<string, unknown>).effective;
  if (!Array.isArray(effective)) return null;
  return effective.filter((entry): entry is string => typeof entry === 'string');
}
