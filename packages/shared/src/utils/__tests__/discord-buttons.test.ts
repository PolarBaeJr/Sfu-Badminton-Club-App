import { describe, it, expect } from 'vitest';
import { DISCORD_BUTTON_SETS, isDiscordButtonSet } from '../discord-buttons';

// THE CONSOLE'S HALF OF A TRIPWIRE WITH TWO HALVES.
//
// apps/bot cannot import this module: it has zero production dependencies, so
// the real buttons in apps/bot/src/commands.ts are a second copy of these
// literals. A tripwire on only one side catches a change to that side and
// misses the other, which is how the two Elo weight tables ended up disagreeing
// with nothing failing. The other half is in apps/bot/src/__tests__/guide.test.ts.
//
// THE TABLES BELOW ARE WRITTEN OUT RATHER THAN READ OFF THE MODULE, for the
// reason a tripwire exists at all: a table derived from the thing it is pinning
// agrees with any change to it.

/** What each set's buttons say, in order. */
const LABELS: Record<string, string[]> = {
  guide: ['Connect my account', 'Report a bug', 'Send feedback'],
  link: ['Connect my account'],
  bug: ['Report a bug'],
  feedback: ['Send feedback'],
};

/**
 * The style of each of those buttons, in the same order.
 *
 * A NARROW SET REPEATS THE STYLE THE BUTTON HAS INSIDE `guide`, which is why
 * `link` is 1 and the other two are 2: they are the same buttons in a shorter
 * row, not new ones. The bot's half asserts the same subset property against
 * the payload it actually builds.
 */
const STYLES: Record<string, number[]> = {
  guide: [1, 2, 2],
  link: [1],
  bug: [2],
  feedback: [2],
};

describe('DISCORD_BUTTON_SETS', () => {
  it('offers exactly the names the CHECK in 00228 allows', () => {
    // A name the column refuses would be an option in the picker that throws
    // when used. The ORDER is the picker's option order as well.
    expect(Object.keys(DISCORD_BUTTON_SETS)).toEqual(['guide', 'link', 'bug', 'feedback']);
  });

  it('says what each set buttons say, in the order the bot builds them', () => {
    for (const [name, labels] of Object.entries(LABELS)) {
      expect(
        DISCORD_BUTTON_SETS[name as keyof typeof DISCORD_BUTTON_SETS].buttons,
        `${name}: these labels are also in componentsForButtonSet() in ` +
          'apps/bot/src/commands.ts: change both or neither',
      ).toEqual(labels);
    }
  });

  it('colours every set the way the bot builds it, primary then secondary', () => {
    for (const [name, styles] of Object.entries(STYLES)) {
      expect(DISCORD_BUTTON_SETS[name as keyof typeof DISCORD_BUTTON_SETS].styles).toEqual(styles);
    }
  });

  it('gives every button a style, and never the one that cannot be clicked', () => {
    // Style 5 is the LINK style and cannot appear here at all: it carries a url
    // instead of a custom_id, which would publish a credential to the channel.
    for (const set of Object.values(DISCORD_BUTTON_SETS)) {
      expect(set.styles).toHaveLength(set.buttons.length);
      for (const style of set.styles) {
        expect([1, 2]).toContain(style);
        expect(style).not.toBe(5);
      }
    }
  });

  it('describes every set in the club words, not the column name', () => {
    for (const set of Object.values(DISCORD_BUTTON_SETS)) {
      expect(set.optionLabel.length).toBeGreaterThan(0);
      // Its own labels, so the picker's helper line names the buttons the
      // message will really carry rather than the three it might have.
      for (const label of set.buttons) {
        expect(set.description).toContain(label);
      }
    }
  });
});

describe('isDiscordButtonSet', () => {
  it('admits every known name and refuses everything else', () => {
    expect(isDiscordButtonSet('guide')).toBe(true);
    expect(isDiscordButtonSet('link')).toBe(true);
    expect(isDiscordButtonSet('bug')).toBe(true);
    expect(isDiscordButtonSet('feedback')).toBe(true);
    expect(isDiscordButtonSet('nope')).toBe(false);
    expect(isDiscordButtonSet('')).toBe(false);
    expect(isDiscordButtonSet(null)).toBe(false);
    expect(isDiscordButtonSet(undefined)).toBe(false);
    expect(isDiscordButtonSet(1)).toBe(false);
    // A server action is an HTTP endpoint, so an object is a shape a caller can
    // send where a name belongs.
    expect(isDiscordButtonSet({ guide: true })).toBe(false);
  });

  it('does not admit a name inherited from Object.prototype', () => {
    // `in` walks the prototype chain, so this is the one input the guard's
    // implementation could plausibly get wrong.
    expect(isDiscordButtonSet('toString')).toBe(false);
    expect(isDiscordButtonSet('constructor')).toBe(false);
  });
});
