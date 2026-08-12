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
// ------------------------------------------------------------
// AND FIVE MORE, FOR THE DOUBLES POOL (00102)
// ------------------------------------------------------------
// A doubles event now holds BOTH kinds of entry: pairs that have been formed,
// and people who entered without a partner and are waiting to be given one.
// That is two more things to add, two more things to take away, and a pairing
// step in between — and they are NOT the same keys as the four above, because
// an unpaired entrant is a tournament_participants row:
//
//   Enter alone      tournaments.draw.participants.add.write
//                    (addParticipantsToEvent — the same action singles uses)
//   Remove unpaired  tournaments.draw.participants.remove.write
//   Pair two people  tournaments.draw.pairs.add.write     (addPairToEvent)
//   Unpair a team    tournaments.draw.pairs.remove.write  (unpairEntry)
//   Half withdrew    tournaments.draw.exit.write          (withdrawPairMember)
//
// The last one is exit.write and not remove.write on purpose: it takes somebody
// OUT of the event and leaves a withdrawn row behind, which is the same thing
// the other three withdrawal actions do and the same key they ask for.
//
// So a doubles event asks BOTH the pairs.* keys and the participants.* keys of
// its viewer, where before it asked only the pairs ones. The event page's
// `allPlayers` fetch has to widen to match, or the picker behind "enter alone"
// is empty for a holder of participants.add.write who lacks pairs.add.write.
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
  /**
   * participants.add.write — entering somebody in a DOUBLES event without a
   * partner. In a singles event this is the same question as `add`; in a
   * doubles event it is a different key from the one `add` asks.
   */
  soloAdd: boolean;
  /** participants.remove.write — deleting an unpaired entrant's row. */
  soloRemove: boolean;
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
  /** "Add without a partner", in a doubles event. */
  addSolo: boolean;
  /** Delete an unpaired entrant's row, before a draw exists. */
  removeSolo: boolean;
  /** Put two unpaired entrants together. */
  pair: boolean;
  /** Split a formed pair back into two unpaired entrants. */
  unpair: boolean;
  /** One half of a formed pair has pulled out; the other returns to the pool. */
  withdrawMember: boolean;
  /**
   * Replace one half of a formed pair with somebody from the pool.
   *
   * BOTH pair keys, because swapPairMember asks for both: a swap is a removal
   * and an addition fused, and gating it on one would make it the way a holder
   * of that one does the other's job. Nothing is widened — anybody who could
   * already unpair and re-pair can do it in a single step, and nobody else can.
   */
  swapMember: boolean;
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

  // THE POOL STAYS EDITABLE THROUGH CHECK-IN, and `open` deliberately does not.
  //
  // Check-in is exactly when the club finds out who turned up without a partner
  // — that is the whole situation this feature exists for — so refusing to pair
  // people at the door would leave the loose entrants in the pool until the
  // draw refused to generate. The server actions already accept both statuses
  // (addPairToEvent, unpairEntry and withdrawPairMember all take
  // 'registration' or 'checkin'), so this is the buttons agreeing with the
  // actions rather than the actions being relaxed to suit the buttons.
  //
  // Adding and removing entries stay on `open`, unchanged: they are the same
  // two affordances singles has and moving them would change who fits in an
  // event that is already at check-in.
  const pairingOpen = (event.status === 'registration' || event.status === 'checkin') && !event.drawLocked;

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
    addSolo: open && can.soloAdd,
    removeSolo: open && can.soloRemove,
    pair: pairingOpen && can.add,
    unpair: pairingOpen && can.remove,
    withdrawMember: pairingOpen && can.exit,
    swapMember: pairingOpen && can.add && can.remove,
  };
}
