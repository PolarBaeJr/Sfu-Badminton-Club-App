import { describe, it, expect } from 'vitest';
import {
  participantControls,
  type DrawCapabilities,
  type ParticipantControls,
} from '../participant-controls';

// THE PARTICIPANTS TAB OFFERED ITS CONTROLS TO EVERYBODY WHO COULD SEE THE PAGE.
//
// `canModify` was `event.status === 'registration'` and nothing else, so Add,
// Auto-Seed and Clear Seeds rendered for any viewer the event page admitted and
// the server action refused on click. These tests are the pair to that refusal:
// the button now has to agree with the action about who may press it, and the
// status rule it already had has to survive intact.

const NOBODY: DrawCapabilities = {
  add: false,
  remove: false,
  seedSet: false,
  seedAuto: false,
  seedClear: false,
  exit: false,
};

const EVERYTHING: DrawCapabilities = {
  add: true,
  remove: true,
  seedSet: true,
  seedAuto: true,
  seedClear: true,
  exit: true,
};

const only = (key: keyof DrawCapabilities): DrawCapabilities => ({ ...NOBODY, [key]: true });

const shown = (c: ParticipantControls) =>
  (Object.keys(c) as Array<keyof ParticipantControls>).filter((k) => c[k]).sort();

const registration = { status: 'registration', drawLocked: false };
const drawn = { status: 'bracket_generated', drawLocked: true };

describe('participantControls — capability, not just status', () => {
  it('offers nothing at all to a viewer holding none of the six', () => {
    // The whole bug, in one assertion. This viewer could open the event page,
    // and got the full control bar.
    expect(shown(participantControls(registration, NOBODY))).toEqual([]);
    expect(shown(participantControls(drawn, NOBODY))).toEqual([]);
    expect(shown(participantControls({ status: 'live', drawLocked: false }, NOBODY))).toEqual([]);
  });

  it('offers the whole bar during registration to somebody who holds it all', () => {
    const c = participantControls(registration, EVERYTHING);

    expect(c.add).toBe(true);
    expect(c.autoSeed).toBe(true);
    expect(c.clearSeeds).toBe(true);
    expect(c.editSeed).toBe(true);
    expect(c.remove).toBe(true);
    // No draw yet, so there is nothing to withdraw FROM.
    expect(c.withdraw).toBe(false);
  });

  it('does not let one capability stand in for another', () => {
    // A seeding desk without the roster, and a roster desk without the seeds.
    // The six actions ask six different questions, so the six buttons do too.
    expect(shown(participantControls(registration, only('add')))).toEqual(['add']);
    expect(shown(participantControls(registration, only('seedAuto')))).toEqual(['autoSeed']);
    expect(shown(participantControls(registration, only('seedClear')))).toEqual(['clearSeeds']);
    expect(shown(participantControls(registration, only('seedSet')))).toEqual(['editSeed']);
  });

  it('keeps the status condition — both have to hold', () => {
    // Holding everything is not a way past a locked draw or a live event.
    const locked = participantControls({ status: 'registration', drawLocked: true }, EVERYTHING);
    expect(locked.add).toBe(false);
    expect(locked.autoSeed).toBe(false);
    expect(locked.clearSeeds).toBe(false);
    expect(locked.editSeed).toBe(false);
    expect(locked.remove).toBe(false);

    const live = participantControls({ status: 'live', drawLocked: false }, EVERYTHING);
    expect(live.add).toBe(false);
    expect(live.editSeed).toBe(false);
    expect(live.remove).toBe(false);
  });

  it('offers Withdraw only once a draw exists, and never after the event is over', () => {
    for (const status of ['bracket_generated', 'live']) {
      expect(participantControls({ status, drawLocked: false }, EVERYTHING).withdraw).toBe(true);
    }
    for (const status of ['registration', 'checkin', 'completed']) {
      expect(participantControls({ status, drawLocked: false }, EVERYTHING).withdraw).toBe(false);
    }
  });

  it('never offers Remove and Withdraw at the same time', () => {
    // Remove deletes the entry outright and is only safe before a draw; withdraw
    // forfeits the matches they are seeded into. Offering both would mean one
    // bracket could take two different exits for the same player.
    for (const status of ['registration', 'checkin', 'bracket_generated', 'live', 'completed']) {
      for (const drawLocked of [true, false]) {
        const c = participantControls({ status, drawLocked }, EVERYTHING);
        expect(c.remove && c.withdraw).toBe(false);
      }
    }
  });

  it('draws the Actions column only when a row actually has an action', () => {
    // A column headed "Actions" whose every cell is empty is the same dead
    // invitation one row up.
    expect(participantControls(registration, only('remove')).actionsColumn).toBe(true);
    expect(participantControls(drawn, only('exit')).actionsColumn).toBe(true);

    // Holds the seeding capabilities and neither row action.
    const seedsOnly = { ...NOBODY, seedSet: true, seedAuto: true, seedClear: true };
    expect(participantControls(registration, seedsOnly).actionsColumn).toBe(false);
    // Holds remove, but the draw is locked, so the rows have nothing to offer.
    expect(
      participantControls({ status: 'registration', drawLocked: true }, only('remove')).actionsColumn,
    ).toBe(false);
  });

  it('lets the draw lock freeze the list without touching the withdrawal path', () => {
    // draw_locked is the event's own switch, not a permission — and a locked
    // draw is exactly when a withdrawal is the only coherent exit left.
    expect(participantControls(drawn, EVERYTHING).withdraw).toBe(true);
    expect(participantControls(drawn, EVERYTHING).remove).toBe(false);
  });

  it('says nothing about a status it has never heard of', () => {
    // A migration adding a sixth event status must not open a control by
    // default. Every branch here is an allow-list.
    expect(shown(participantControls({ status: 'archived', drawLocked: false }, EVERYTHING))).toEqual(
      [],
    );
  });
});
