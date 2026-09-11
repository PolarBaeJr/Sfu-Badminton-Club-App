// The button sets a console-queued Discord message is allowed to carry.
//
// A NAME, NEVER A PAYLOAD. `discord_outbox.button_set` holds one word and its
// CHECK in 00228 allows exactly the four keys below. The insert path is a server
// action, so every field on it is a client-controlled POST field: a column
// holding component JSON would be a way to make the club's bot post an
// arbitrary Discord payload. The buttons themselves live in `GUIDE_BUTTONS` in
// apps/bot/src/commands.ts and a name resolves to them in
// componentsForButtonSet(), beside the handlers that answer them, so a button
// that exists is a button something responds to.
//
// EACH GUIDE IS ABOUT ONE TASK, which is why there are four sets rather than
// one. `guide` is the whole row that /guidepost posts; `link`, `bug` and
// `feedback` are each ONE BUTTON OF THAT SAME ROW, with the same label, the same
// style and the same custom_id. So a narrow set adds no new button and needs no
// new handler: the message about connecting an account carries the button for
// connecting an account and nothing else.
//
// THE BOT CANNOT IMPORT THIS FILE. apps/bot has zero production dependencies
// on purpose, so it keeps its own copy of the literals and BOTH SIDES PIN THEM
// IN A TEST naming the other file. That argument is written out in full at
// packages/shared/src/utils/discord-embed.ts:20-26 for the four embed colours,
// and it is the same argument here: a tripwire on only one side catches a
// change to that side and misses the other.
//
// So what this module holds is the CONSOLE's vocabulary: which names are
// offerable, what to call them on screen, and what the buttons say, so the
// preview can draw them without knowing any Discord JSON.

/**
 * Every set the console may name, and everything the console knows about it.
 *
 * `as const` rather than a `Record<string, ...>` annotation, which is the
 * opposite of ANNOUNCEMENT_EMBED_COLORS next door and deliberately so: the keys
 * ARE the allowlist here, and a `Record<string, ...>` would widen
 * `DiscordButtonSet` to `string` and turn the guard below into a no-op.
 */
export const DISCORD_BUTTON_SETS = {
  guide: {
    /** This entry's label in the composer's picker. */
    optionLabel: 'All three member buttons',
    /** Its description, written for an exec rather than a developer. */
    description:
      'Three buttons under the message: Connect my account, Report a bug, Send feedback. ' +
      'A member clicks one and only they see the reply.',
    /**
     * What the buttons say, in order. Mirrors guideComponents() in
     * apps/bot/src/commands.ts, and changing a label here without changing it
     * there fails the tripwire test in BOTH packages.
     */
    buttons: ['Connect my account', 'Report a bug', 'Send feedback'],
    /**
     * Discord button styles, in the same order, FOR THE PREVIEW'S COLOURS AND
     * NOTHING ELSE. 1 is PRIMARY and 2 is SECONDARY. The payload the bot sends
     * is built from its own copy: nothing here reaches Discord.
     */
    styles: [1, 2, 2],
  },
  // THE THREE NARROW SETS, AND THEIR STYLES ARE NOT A CHOICE. Each is the same
  // button as the one in `guide` above, so its style is that button's style
  // inside the three-button row: 1 for Connect my account, 2 for the other two.
  // A lone SECONDARY button is not a defect, it is the same button in a shorter
  // row, and the bot's test asserts exactly that subset property.
  link: {
    optionLabel: 'Connect my account only',
    description:
      'One button under the message: Connect my account. A member clicks it and only they see ' +
      'the reply.',
    buttons: ['Connect my account'],
    styles: [1],
  },
  bug: {
    optionLabel: 'Report a bug only',
    description:
      'One button under the message: Report a bug. It opens a small form, and only the member ' +
      'who clicked sees the reply.',
    buttons: ['Report a bug'],
    styles: [2],
  },
  feedback: {
    optionLabel: 'Send feedback only',
    description:
      'One button under the message: Send feedback. It opens a small form, and only the member ' +
      'who clicked sees the reply.',
    buttons: ['Send feedback'],
    styles: [2],
  },
} as const;

/** The name of a set, which is all the column and the server action carry. */
export type DiscordButtonSet = keyof typeof DISCORD_BUTTON_SETS;

/**
 * Whether a client-supplied string is a set the bot knows how to answer.
 *
 * Used by the server action BEFORE the insert, so the CHECK in 00228 is the
 * second line of defence rather than the thing an exec reads.
 */
export function isDiscordButtonSet(value: unknown): value is DiscordButtonSet {
  // `Object.hasOwn` rather than `in`, which is not a style preference: `in`
  // walks the prototype chain, so it would admit `toString` and `constructor`,
  // and those are exactly the strings a caller poking at a server action sends.
  // They would then reach the insert and come back as a raw CHECK violation,
  // which is the one thing this guard exists to stop an exec reading.
  return typeof value === 'string' && Object.hasOwn(DISCORD_BUTTON_SETS, value);
}
