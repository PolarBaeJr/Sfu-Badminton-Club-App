import { describe, it, expect } from 'vitest';
import { DISCORD_BUTTON_SETS, isDiscordButtonSet } from '../discord-buttons';

// THE CONSOLE'S HALF OF A TRIPWIRE WITH TWO HALVES.
//
// apps/bot cannot import this module: it has zero production dependencies, so
// the real buttons in apps/bot/src/commands.ts are a second copy of these
// literals. A tripwire on only one side catches a change to that side and
// misses the other, which is how the two Elo weight tables ended up disagreeing
// with nothing failing. The other half is in apps/bot/src/__tests__/guide.test.ts.

describe('DISCORD_BUTTON_SETS', () => {
  it('offers exactly the names the CHECK in 00227 allows', () => {
    // A name the column refuses would be a switch that throws when used.
    expect(Object.keys(DISCORD_BUTTON_SETS)).toEqual(['guide']);
  });

  it('says what the buttons say, in the order the bot builds them', () => {
    expect(DISCORD_BUTTON_SETS.guide.buttons).toEqual([
      'Connect my account',
      'Report a bug',
      'Send feedback',
    ]);
  });

  it('colours them the way guideComponents does, primary then secondary', () => {
    // Style 5 is the LINK style and cannot appear here at all: it carries a url
    // instead of a custom_id, which would publish a credential to the channel.
    expect(DISCORD_BUTTON_SETS.guide.styles).toEqual([1, 2, 2]);
    expect(DISCORD_BUTTON_SETS.guide.styles).not.toContain(5);
  });

  it('describes the set in the club words, not the column name', () => {
    const { switchLabel, switchDescription } = DISCORD_BUTTON_SETS.guide;
    expect(switchLabel.length).toBeGreaterThan(0);
    for (const label of DISCORD_BUTTON_SETS.guide.buttons) {
      expect(switchDescription).toContain(label);
    }
  });
});

describe('isDiscordButtonSet', () => {
  it('admits a known name and refuses everything else', () => {
    expect(isDiscordButtonSet('guide')).toBe(true);
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
