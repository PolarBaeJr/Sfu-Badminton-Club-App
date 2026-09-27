// Which group of the club someone belongs to.
//
// Independent of `role` and `is_exec`: an exec is still an internal member, and
// promoting someone to exec must not silently change which events they can
// enter. All three can be set at once.
//
// THE STORED COLUMN IS NOT THE WHOLE ANSWER ANY MORE. "internal is when a person
// has paid for membership fees, externals is anyone who is not paying our club
// fees, so without fees they would be unable to join our internal tournaments"
// is the club owner's definition, and players.membership_type is something a
// member can pick for themselves in Discord (00221). So at entry the group is
// DERIVED, by entryMembership below, from the stored value plus this season's
// dues; enter_tournament_event applies the same rule in SQL (00260).

export const MEMBERSHIP_TYPES = [
  {
    value: 'internal',
    label: 'Internal',
    description: "Paid this season's club fee, or exempt from it.",
  },
  {
    value: 'alumni',
    label: 'Alumni',
    description: 'Former member. May enter events that admit alumni.',
  },
  {
    value: 'external',
    label: 'External',
    description: "Has not paid this season's club fee. Only events explicitly open to externals.",
  },
] as const;

export type MembershipType = (typeof MEMBERSHIP_TYPES)[number]['value'];

export const ALL_MEMBERSHIP_TYPES: MembershipType[] = MEMBERSHIP_TYPES.map((m) => m.value);

export function formatMembershipType(value: string | null | undefined): string {
  return MEMBERSHIP_TYPES.find((m) => m.value === value)?.label ?? 'Internal';
}

/**
 * May this member register for an event with these allowed groups?
 *
 * Fails OPEN on a missing/empty allow-list, deliberately. Every tournament
 * created before this feature existed has no value, and treating that as
 * "nobody may enter" would bar the whole roster from events they can currently
 * join. The database default covers new rows; this covers anything read before
 * the migration lands, or a row fetched without the column selected.
 */
export function isMembershipAllowed(
  membership: string | null | undefined,
  allowed: readonly string[] | null | undefined,
): boolean {
  if (!allowed || allowed.length === 0) return true;
  // A player row predating the column reads as internal, matching the column
  // default — never as the most restricted group.
  return allowed.includes(membership ?? 'internal');
}

function allowedLabels(allowed: readonly string[] | null | undefined): string[] {
  return (allowed ?? [])
    .map((a) => MEMBERSHIP_TYPES.find((m) => m.value === a)?.label)
    .filter((l): l is (typeof MEMBERSHIP_TYPES)[number]['label'] => Boolean(l));
}

/** Why a registration was refused, phrased for the person being refused. */
export function membershipRefusalMessage(
  allowed: readonly string[] | null | undefined,
): string {
  const labels = allowedLabels(allowed);
  if (labels.length === 0) return 'This event is not open to your membership type.';
  return `This event is open to ${labels.join(' and ')} members only.`;
}

/**
 * The refusal for somebody who would be Internal if this season's club fee
 * were paid. Says what Internal means and what to do, because "Internal members
 * only" to a member who believes they are one reads as a bug.
 */
export function membershipUnpaidMessage(
  allowed: readonly string[] | null | undefined,
  /** False when the Membership page is switched off, so there is nowhere to pay. */
  payOnline = true,
): string {
  const labels = allowedLabels(allowed);
  const who = labels.length > 0 ? labels.join(' and ') : 'Internal';
  return (
    `This event is open to ${who} members only, and Internal means this season's club fee is paid. ` +
    (payOnline ? 'Pay it on the Membership page, then enter.' : 'Ask an exec to record your club fee.')
  );
}

/** is_exec or fee_exempt: the two exemptions every fee surface applies. */
export function isFeeExempt(
  p: { is_exec?: boolean | null; fee_exempt?: boolean | null } | null | undefined,
): boolean {
  return Boolean(p?.is_exec || p?.fee_exempt);
}

/** What entryMembership decides from. */
export interface EntryMembershipFacts {
  /** players.membership_type. Null or unrecognised reads as internal. */
  stored: string | null | undefined;
  /** isFeeExempt: an exec or a fee-exempt member. */
  exempt: boolean;
  /**
   * A dues row for this member and the entry's season with paid_at set. A
   * waived row counts: the club chose to excuse the fee.
   */
  paid: boolean;
  /** Whether there is a season to have paid for at all. */
  hasSeason: boolean;
}

function storedMembership(value: string | null | undefined): MembershipType {
  return ALL_MEMBERSHIP_TYPES.includes(value as MembershipType) ? (value as MembershipType) : 'internal';
}

/**
 * The group a member ENTERS as, which is not always the group stored on them.
 *
 *   exempt                      internal
 *   paid this season's dues     internal
 *   no season to pay for        the stored value, unchanged
 *   otherwise                   alumni stays alumni; everyone else is external
 *
 * No season falls back to the stored value because there is nothing anybody
 * could have paid; refusing the whole roster between terms would be the
 * failure, not the rule. Alumni stays alumni because the owner's definition
 * is about who pays club fees, and alumni are a separate group the club
 * already prices and admits on its own.
 *
 * enter_tournament_event applies the same table through entry_membership_rule
 * (00260), and ENTRY_MEMBERSHIP_CASES below is what keeps the two identical.
 */
export function entryMembership(f: EntryMembershipFacts): MembershipType {
  if (f.exempt || f.paid) return 'internal';
  const stored = storedMembership(f.stored);
  if (!f.hasSeason) return stored;
  return stored === 'alumni' ? 'alumni' : 'external';
}

export type MembershipScreen =
  | { ok: true; effective: MembershipType }
  | {
      ok: false;
      effective: MembershipType;
      reason: 'membership_unpaid' | 'membership_not_allowed';
      message: string;
    };

/**
 * May this member enter an event with these allowed groups, and if not, why.
 *
 * 'membership_unpaid' is the one refusal paying would fix: the event admits
 * Internal, there is a season, and the member is neither paid nor exempt. Every
 * other refusal is 'membership_not_allowed', including a paid member at an
 * alumni-only event, because paying cannot help there.
 *
 * Fails open on a missing or empty allow-list, exactly as isMembershipAllowed.
 */
export function screenMembershipEntry(
  facts: EntryMembershipFacts,
  allowed: readonly string[] | null | undefined,
): MembershipScreen {
  const effective = entryMembership(facts);
  if (!allowed || allowed.length === 0 || allowed.includes(effective)) {
    return { ok: true, effective };
  }
  if (allowed.includes('internal') && facts.hasSeason && !facts.paid && !facts.exempt) {
    return { ok: false, effective, reason: 'membership_unpaid', message: membershipUnpaidMessage(allowed) };
  }
  return { ok: false, effective, reason: 'membership_not_allowed', message: membershipRefusalMessage(allowed) };
}

/**
 * The whole rule as data: stored x exempt x paid x hasSeason, 24 rows.
 *
 * Written out rather than generated, so it states the rule instead of
 * restating the implementation. entry-membership-migration.test.ts compares
 * it to the VALUES list 00260's $proof$ block runs against the SQL function,
 * so the TypeScript and the database cannot drift apart silently.
 */
export const ENTRY_MEMBERSHIP_CASES: ReadonlyArray<{
  stored: MembershipType;
  exempt: boolean;
  paid: boolean;
  hasSeason: boolean;
  expected: MembershipType;
}> = [
  { stored: 'internal', exempt: false, paid: false, hasSeason: false, expected: 'internal' },
  { stored: 'internal', exempt: false, paid: false, hasSeason: true, expected: 'external' },
  { stored: 'internal', exempt: false, paid: true, hasSeason: false, expected: 'internal' },
  { stored: 'internal', exempt: false, paid: true, hasSeason: true, expected: 'internal' },
  { stored: 'internal', exempt: true, paid: false, hasSeason: false, expected: 'internal' },
  { stored: 'internal', exempt: true, paid: false, hasSeason: true, expected: 'internal' },
  { stored: 'internal', exempt: true, paid: true, hasSeason: false, expected: 'internal' },
  { stored: 'internal', exempt: true, paid: true, hasSeason: true, expected: 'internal' },
  { stored: 'alumni', exempt: false, paid: false, hasSeason: false, expected: 'alumni' },
  { stored: 'alumni', exempt: false, paid: false, hasSeason: true, expected: 'alumni' },
  { stored: 'alumni', exempt: false, paid: true, hasSeason: false, expected: 'internal' },
  { stored: 'alumni', exempt: false, paid: true, hasSeason: true, expected: 'internal' },
  { stored: 'alumni', exempt: true, paid: false, hasSeason: false, expected: 'internal' },
  { stored: 'alumni', exempt: true, paid: false, hasSeason: true, expected: 'internal' },
  { stored: 'alumni', exempt: true, paid: true, hasSeason: false, expected: 'internal' },
  { stored: 'alumni', exempt: true, paid: true, hasSeason: true, expected: 'internal' },
  { stored: 'external', exempt: false, paid: false, hasSeason: false, expected: 'external' },
  { stored: 'external', exempt: false, paid: false, hasSeason: true, expected: 'external' },
  { stored: 'external', exempt: false, paid: true, hasSeason: false, expected: 'internal' },
  { stored: 'external', exempt: false, paid: true, hasSeason: true, expected: 'internal' },
  { stored: 'external', exempt: true, paid: false, hasSeason: false, expected: 'internal' },
  { stored: 'external', exempt: true, paid: false, hasSeason: true, expected: 'internal' },
  { stored: 'external', exempt: true, paid: true, hasSeason: false, expected: 'internal' },
  { stored: 'external', exempt: true, paid: true, hasSeason: true, expected: 'internal' },
];
