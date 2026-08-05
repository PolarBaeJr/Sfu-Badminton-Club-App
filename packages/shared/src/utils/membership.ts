// Which group of the club someone belongs to.
//
// Independent of `role` and `is_exec`: an exec is still an internal member, and
// promoting someone to exec must not silently change which events they can
// enter. All three can be set at once.

export const MEMBERSHIP_TYPES = [
  {
    value: 'internal',
    label: 'Internal',
    description: 'Current club member.',
  },
  {
    value: 'alumni',
    label: 'Alumni',
    description: 'Former member. May enter events that admit alumni.',
  },
  {
    value: 'external',
    label: 'External',
    description: 'Not a club member. Only events explicitly open to externals.',
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

/** Why a registration was refused, phrased for the person being refused. */
export function membershipRefusalMessage(
  allowed: readonly string[] | null | undefined,
): string {
  const labels = (allowed ?? [])
    .map((a) => MEMBERSHIP_TYPES.find((m) => m.value === a)?.label)
    .filter(Boolean);
  if (labels.length === 0) return 'This event is not open to your membership type.';
  return `This event is open to ${labels.join(' and ')} members only.`;
}
