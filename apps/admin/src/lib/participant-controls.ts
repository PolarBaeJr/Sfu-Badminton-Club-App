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
  /**
   * tournaments.draw.generate.write — building the draw, and rebuilding it.
   *
   * Transcribed from the requireCapability call at the top of BOTH generators
   * (tournament-actions/brackets.ts — generateSingleEliminationBracketImpl and
   * generateRoundRobinMatchesImpl). Regenerating is not a second act needing a
   * second key: it is the same action, called again, on an event that already
   * has a draw. Minting a key for it would have handed the club a distinction
   * — "may draw, may not redraw" — that neither generator could enforce, since
   * both have deleted and rebuilt since they were written.
   */
  generate: boolean;
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
  /**
   * Pair the WHOLE waiting list in one press.
   *
   * DELIBERATELY THE SAME GATE AS `pair`, and it is a separate field only so
   * the tab does not have to know that. Auto pair is the same act in bulk — it
   * calls the same server action once per pair — so it asks the same capability
   * and obeys the same statuses. A key of its own would let the club hand out
   * "may pair six people" separately from "may pair two", which is not a
   * distinction anybody has asked for and not one the actions could enforce.
   */
  autoPair: boolean;
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

  // REMOVAL EXTENDS THROUGH CHECK-IN, and nothing else does.
  //
  // Removal used to stop where `open` stops, and withdrawal only begins once a
  // draw exists — so an event at `checkin` offered no way to take anybody out
  // at all, while the status transitions are forward-only so there was no way
  // back to registration either. The owner hit exactly that: one entrant to
  // remove, fewer than two checked in, and the event stuck.
  //
  // Only removal moves. Adding an entrant after check-in has opened is a
  // different act with a different answer, and seeding stays where it was —
  // check-in is when a club learns who turned up, which makes it the moment
  // somebody has to come OUT, not the moment to let more in.
  const removalOpen =
    (event.status === 'registration' || event.status === 'checkin') && !event.drawLocked;
  const remove = removalOpen && can.remove;
  const withdraw = exitable && can.exit;
  // One expression, two controls: see ParticipantControls.autoPair.
  const pair = pairingOpen && can.add;

  return {
    add: open && can.add,
    autoSeed: open && can.seedAuto,
    clearSeeds: open && can.seedClear,
    editSeed: open && can.seedSet,
    remove,
    withdraw,
    actionsColumn: remove || withdraw,
    addSolo: open && can.soloAdd,
    removeSolo: removalOpen && can.soloRemove,
    pair,
    autoPair: pair,
    unpair: pairingOpen && can.remove,
    withdrawMember: pairingOpen && can.exit,
    swapMember: pairingOpen && can.add && can.remove,
  };
}

// ============================================================
// Regenerate draw
// ============================================================

/** Whether the header offers "Regenerate draw", and why it is greyed if it is. */
export interface RegenerateDrawControl {
  /** Render the button at all. */
  show: boolean;
  /**
   * Rendered but not pressable, and this says why. `null` means pressable.
   * A greyed button with no reason sends an exec hunting for what is missing.
   */
  blockedReason: string | null;
}

/**
 * WHY THERE WAS NO WAY BACK.
 *
 * EventHeader drove the event through one primary button —
 * registration -> "Open Check-In" -> checkin -> "Generate Bracket" ->
 * bracket_generated -> "Start Tournament" -> live -> "Finalize Tournament" —
 * and nothing moved an event backwards, so "Generate Bracket" could be pressed
 * exactly once in an event's life. The club owner hit it on staging: "once the
 * bracket is generated theres no way to regenerate a bracket."
 *
 * The ACTION was always regenerable. Both generators open with
 * `delete().eq('event_id', eventId)` and rebuild from the current field, and
 * both already refuse the two cases that must be refused — a result has been
 * entered, or the draw is locked. This was a missing door, not a missing room.
 *
 * ------------------------------------------------------------
 * AND `live` TOO, WHICH THIS FILE USED TO ARGUE AGAINST
 * ------------------------------------------------------------
 * The argument that stood here was: going live runs forfeitOutOfEventEntries,
 * which records real walkovers for anyone who withdrew after the draw was
 * published, so a live event "has had a single withdrawal or a single result"
 * and the action would refuse — and a destructive button that usually refuses
 * teaches the exec that the console guesses.
 *
 * It was wrong about the frequency, and the owner walked straight into the gap
 * it left: they pressed "Start Tournament", the Regenerate button vanished, and
 * there was no way back. On staging today four events sit at `live` and three
 * of them have NOTHING played — the go-live sweep only records a walkover when
 * somebody has actually withdrawn, and most events go live with the field they
 * drew with. The common live event is redrawable, not the rare one.
 *
 * THE GUARD IS THE AUTHORITY, NOT THE STATUS. `live` does not mean "something
 * has been played" — it means the exec pressed a button. What has been played
 * is a property of the match rows, and assertNoResultsEntered reads exactly
 * that, counting walkovers and disputed results and refusing to count byes.
 * `playedMatches` below is the same question asked on the page (isPlayedMatch,
 * packages/shared) so the button can grey itself and SAY the number rather than
 * refusing after the click — one definition, asked in two places, and the
 * server's answer is still the one that decides.
 *
 * WHAT MADE IT SAFE TO OFFER is not in this file: the generators used to end
 * with an unconditional `status: 'bracket_generated'` write, which from a live
 * event would have quietly sent it backwards a step. See statusAfterDraw in
 * tournament-actions/brackets.ts. Flipping this status check without that fix
 * would have been the whole bug.
 *
 * NOT `completed`. assertNotFinalised refuses it outright and nothing here
 * should suggest otherwise: final positions, tournament points and placement
 * bonuses were awarded off the current draw and no redraw can take them back.
 *
 * NOT via `checkin`. The other shape was to send the event backwards so the
 * existing Generate button became reachable. It costs more than it looks:
 * setEventStatus's transition table is forward-only
 * (registration -> checkin -> bracket_generated -> live -> completed), so it
 * would mean widening the state machine and spending a SECOND capability
 * (status.write) on an act that already has one. And it buys less than it looks
 * — participantControls above keeps `add`, `remove`, `editSeed` and `autoSeed`
 * on `registration`, so an event dropped back to `checkin` still cannot take a
 * new entry or be re-seeded by hand.
 *
 * ------------------------------------------------------------
 * A LOCKED DRAW — AND A PLAYED ONE — ARE SHOWN, NOT HIDDEN
 * ------------------------------------------------------------
 * draw_locked is the event's own switch and the generators refuse on it. The
 * Unlock Draw button sits in the same row and the "Draw Locked" badge is on
 * screen, so the honest thing is a greyed button naming the lock — hiding it
 * would look identical to not holding the capability, which is the one thing
 * this module exists to keep distinct. A draw with results already in it is
 * greyed for the same reason and named the same way.
 */
const REDRAWABLE_STATUSES = new Set<string>(['bracket_generated', 'live']);

export function regenerateDrawControl(
  event: {
    status: string;
    drawLocked: boolean;
    /**
     * Matches with a real result — isPlayedMatch, so byes are NOT counted.
     * Optional so a caller that has not got the figure gets the old behaviour
     * (offer it, let the server refuse) rather than a silently wrong greying.
     */
    playedMatches?: number;
  },
  can: DrawCapabilities,
): RegenerateDrawControl {
  if (!REDRAWABLE_STATUSES.has(event.status) || !can.generate) {
    return { show: false, blockedReason: null };
  }
  // The lock is named first: it is the one the exec can undo from this same row.
  if (event.drawLocked) {
    return { show: true, blockedReason: 'Unlock the draw before redrawing it' };
  }
  const played = event.playedMatches ?? 0;
  if (played > 0) {
    return {
      show: true,
      blockedReason: `${played} match${played === 1 ? ' has' : 'es have'} been played — void ${played === 1 ? 'it' : 'them'} first`,
    };
  }
  return { show: true, blockedReason: null };
}
