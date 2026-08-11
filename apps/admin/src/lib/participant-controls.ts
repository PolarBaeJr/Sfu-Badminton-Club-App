// WHICH CONTROLS THE PARTICIPANTS TAB OFFERS.
//
// The tab used to decide this with one boolean — `event.status === 'registration'`
// — and no capability test at all. Add, Auto-Seed and Clear Seeds therefore
// rendered for anybody the event page admitted, and the server action refused on
// click. Since a sibling gated the page's FETCHES per capability, the picker
// behind Add was already empty for a non-holder, so what was on screen was a
// dead button rather than a hole: the refusal was real, the invitation was not.
//
// Six controls, six capabilities, and they are NOT interchangeable. The club can
// hand somebody the seeding desk without the roster, or the power to withdraw a
// player mid-event without the power to delete one before it starts — which is
// exactly why the actions ask six different questions:
//
//   Add          tournaments.draw.participants.add.write    (singles)
//                tournaments.draw.pairs.add.write           (doubles)
//   Remove       tournaments.draw.participants.remove.write (singles)
//                tournaments.draw.pairs.remove.write        (doubles)
//   Seed cell    tournaments.draw.seed.set.write
//   Auto-Seed    tournaments.draw.seed.auto.write
//   Clear Seeds  tournaments.draw.seed.clear.write
//   Withdraw     tournaments.draw.exit.write
//
// (tournament-actions/participants.ts and .../seeding.ts — transcribed from the
// requireCapability call at the top of each, not inferred from the names.)
//
// THE STATUS CONDITION STAYS. Both have to hold: a capability does not let
// anyone add to a locked draw, and being in `registration` does not let anyone
// without the capability do anything. Deciding it here rather than inline in the
// client component is what makes it testable — the component cannot be rendered
// in a unit test, and this is the part with the rules in it.

/** What the viewer may DO, one flag per server action behind a control. */
export interface DrawCapabilities {
  /** pairs.add.write for a doubles event, participants.add.write otherwise. */
  add: boolean;
  /** pairs.remove.write for a doubles event, participants.remove.write otherwise. */
  remove: boolean;
  /** seed.set.write — the click-to-edit seed cell. */
  seedSet: boolean;
  /** seed.auto.write */
  seedAuto: boolean;
  /** seed.clear.write */
  seedClear: boolean;
  /** exit.write — withdrawing an entry that is already in a draw. */
  exit: boolean;
}

export interface ParticipantControls {
  add: boolean;
  autoSeed: boolean;
  clearSeeds: boolean;
  /** The seed cell, and the "(click to edit)" hint in the column header. */
  editSeed: boolean;
  remove: boolean;
  withdraw: boolean;
  /**
   * Whether the Actions column is drawn at all. It follows the two row controls
   * and nothing else — a column headed "Actions" whose every cell is empty is
   * the same dead invitation one row up.
   */
  actionsColumn: boolean;
}

/**
 * `drawLocked` is the event's own switch, not a permission: once the draw is
 * locked the entry list is frozen for everybody, however much access they hold.
 *
 * A draw exists from `bracket_generated` onward (eventHasDraw in
 * packages/shared), which is why remove and withdraw can never both be offered:
 * remove is a registration-only affordance and withdraw only appears once there
 * is a bracket to forfeit into. Duplicated as a literal set here rather than
 * imported so this module stays free of anything a test would have to mock —
 * the assertion that the two never overlap is in the test file.
 */
const DRAWN_STATUSES = new Set<string>(['bracket_generated', 'live', 'completed']);

export function participantControls(
  event: { status: string; drawLocked: boolean },
  can: DrawCapabilities,
): ParticipantControls {
  // The entry list is open for editing: still taking registrations, and not
  // frozen. Three separate capabilities sit on top of this one condition.
  const open = event.status === 'registration' && !event.drawLocked;

  // A completed event is history. Withdrawing from it would forfeit matches
  // that already have results.
  const exitable = DRAWN_STATUSES.has(event.status) && event.status !== 'completed';

  const remove = open && can.remove;
  const withdraw = exitable && can.exit;

  return {
    add: open && can.add,
    autoSeed: open && can.seedAuto,
    clearSeeds: open && can.seedClear,
    editSeed: open && can.seedSet,
    remove,
    withdraw,
    actionsColumn: remove || withdraw,
  };
}
