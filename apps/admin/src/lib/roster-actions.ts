// Which buttons a roster row shows, decided by the tab you are looking at.
//
// The list used to show Edit / Ban / Remove on every tab, which is how an
// INACTIVE account ended up with no way back and a SUSPENDED one was offered
// "Ban". The club owner asked for the actions to match the tab instead:
//
//   Inactive        Edit, Restore
//   Suspended       Edit, Unban
//   Needs attention Edit, Recreational, Competitive
//   Recreational    Edit, Ban, Inactive
//   Competitive     Edit, Ban, Inactive
//
// Three columns are being conflated whenever this gets it wrong, so keep them
// apart:
//
//   is_banned    set by banPlayer, cleared by reinstatePlayer. "Unban".
//   status       competitive | recreational | suspended | pending_approval.
//   active_flag  "inactive". Cleared by removePlayer and nightly by the
//                mark-inactive-players edge function. NOT a status value.
//
// A pure function, deliberately: it is the one part of this feature that can be
// checked without a database, a browser or a session.

// ---------------------------------------------------------------------------

/** Tabs on /players. Anything unrecognised falls back to the roster tabs. */
export type RosterTab = 'competitive' | 'recreational' | 'attention' | 'suspended' | 'inactive';

export type RosterAction =
  | { kind: 'edit' }
  /** banPlayer — sets is_banned. */
  | { kind: 'ban' }
  /** reinstatePlayer — clears is_banned (and records the fee, for an admin). */
  | { kind: 'unban' }
  /** updatePlayer { active_flag: true, status } — back onto the active roster. */
  | { kind: 'restore' }
  /** updatePlayer { active_flag: false } — off the active roster, status untouched. */
  | { kind: 'inactive' }
  /** approvePlayer (pending) / updatePlayer (anything else) into a division. */
  | { kind: 'assign'; status: 'recreational' | 'competitive' };

/** Only the flag that changes which action applies — everything else is display. */
export interface RosterRowState {
  is_banned?: boolean | null;
}

/**
 * Two tabs list rows that reached them by different routes, so the flag decides:
 *
 *  - Suspended is `status = 'suspended' OR is_banned` — a member who was
 *    suspended without ever being banned needs their status put back, not a ban
 *    lifted that was never applied (reinstatePlayer would file a
 *    reinstatement_fees row for a ban that does not exist).
 *  - Competitive/Recreational list by status, so a banned member still appears
 *    there. Offering "Ban" to someone already banned is the bug in miniature.
 */
export function rosterActionsFor(tab: string, player: RosterRowState): RosterAction[] {
  switch (tab) {
    case 'inactive':
      return [{ kind: 'edit' }, { kind: 'restore' }];
    case 'suspended':
      return [{ kind: 'edit' }, player.is_banned ? { kind: 'unban' } : { kind: 'restore' }];
    case 'attention':
      return [
        { kind: 'edit' },
        { kind: 'assign', status: 'recreational' },
        { kind: 'assign', status: 'competitive' },
      ];
    default:
      return [
        { kind: 'edit' },
        player.is_banned ? { kind: 'unban' } : { kind: 'ban' },
        { kind: 'inactive' },
      ];
  }
}

/** Stable React key — 'assign' appears twice in the same row. */
export function rosterActionKey(action: RosterAction): string {
  return action.kind === 'assign' ? `assign-${action.status}` : action.kind;
}
