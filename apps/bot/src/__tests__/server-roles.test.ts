import { describe, expect, it } from 'vitest';
import { offerableRoles } from '../server-roles.js';
import { DISPLAY_NAMES, type DiscordRole } from '../setup.js';
import { MANAGED_ROLES } from '../roles.js';

// WHICH ROLES THE CONSOLE'S NOTIFY PICKER IS ALLOWED TO SEE.
//
// The two filters that ARE here are cheap to agree with. The two that are NOT
// here are the whole test: `position` and `mentionable` both look like obvious
// filters and both would silently delete most of the feature, so each has an
// assertion naming it.

const GUILD = '1466962179738570838';

function role(name: string, over: Partial<DiscordRole> = {}): DiscordRole {
  return { id: `id-${name}`, name, position: 10, ...over };
}

describe('offerableRoles', () => {
  it('drops @everyone, which shares the guild id', () => {
    // It cannot be notified through the roles list at all: only
    // allowed_mentions parse: ["everyone"] rings it, and the ping line the
    // console builds sends parse: []. Offering it draws a chip that rings nobody.
    const roles = offerableRoles(
      [{ id: GUILD, name: '@everyone', position: 0 }, role('Varsity')],
      GUILD,
    );

    expect(roles.map((r) => r.name)).toEqual(['Varsity']);
  });

  it("drops Discord's own managed roles", () => {
    // A bot's integration role, a Nitro booster role. Nobody holds one by
    // choice and nobody can be given one.
    const roles = offerableRoles(
      [role('SFU Badminton', { managed: true }), role('Varsity')],
      GUILD,
    );

    expect(roles.map((r) => r.name)).toEqual(['Varsity']);
  });

  it('KEEPS a role above the bot, which is the filter most likely to be added', () => {
    // planSetup has an `above_bot` check and copying it here would be the single
    // easiest way to break this feature. Hierarchy governs who may ASSIGN a
    // role, never who may MENTION one, and the roles above the bot are typically
    // @Admin and the exec roles: most of what an exec wants to notify.
    const roles = offerableRoles([role('Admin', { position: 999 })], GUILD);

    expect(roles.map((r) => r.name)).toEqual(['Admin']);
  });

  it('KEEPS a role that is not mentionable, which is how the club\'s own nine are made', () => {
    // `mentionable` decides whether an ORDINARY MEMBER may type the mention; a
    // bot holding MENTION_EVERYONE mentions any role regardless. createGuildRole
    // makes the nine with `mentionable: false`, so filtering on it would drop
    // exactly the roles the picker already offers today.
    // Typed as the intersection rather than cast: `mentionable` is a real field
    // on Discord's role object that this bot's interface has no use for, and a
    // cast here would be the kind of thing nothing catches, since
    // apps/bot/tsconfig.json excludes __tests__ from the type-check entirely.
    const notMentionable: DiscordRole & { mentionable: boolean } = {
      id: 'id-Internal',
      name: 'Internal',
      position: 3,
      mentionable: false,
    };

    const roles = offerableRoles([notMentionable], GUILD);

    expect(roles.map((r) => r.name)).toEqual(['Internal']);
  });

  it('carries the id, the name and the position, and nothing else', () => {
    // The route takes these three. Anything more would be a role object in a
    // table that only has to answer "what may this message mention".
    expect(offerableRoles([role('Varsity', { id: '444444444444444444' })], GUILD)).toEqual([
      { roleId: '444444444444444444', name: 'Varsity', position: 10 },
    ]);
  });

  it('KEEPS ALL NINE OF THE CLUB\'S OWN ROLES out of a lifelike server', () => {
    // The case that actually ships, rather than one synthetic role. Every one of
    // the nine is created `mentionable: false`, so a single copied filter would
    // empty the picker's whole "Club roles" group while leaving "Server roles"
    // looking healthy: the console merges the two lists by name, so the club
    // group would go quiet and the failure would read as a catalogue that is
    // simply missing them.
    const guild: (DiscordRole & { mentionable: boolean })[] = [
      { id: GUILD, name: '@everyone', position: 0, mentionable: false },
      { id: 'id-bot', name: 'SFU Badminton', position: 1, managed: true, mentionable: false },
      ...MANAGED_ROLES.map((managed, i) => ({
        id: `id-${managed}`,
        name: DISPLAY_NAMES[managed],
        position: i + 2,
        mentionable: false,
      })),
      { id: '444444444444444444', name: 'Varsity', position: 40, mentionable: true },
    ];

    const offered = offerableRoles(guild, GUILD);

    expect(offered.map((r) => r.name)).toEqual([
      ...MANAGED_ROLES.map((managed) => DISPLAY_NAMES[managed]),
      'Varsity',
    ]);
    expect(MANAGED_ROLES).toHaveLength(9);
  });

  it('answers with nothing for a server holding only @everyone and the bot', () => {
    // The caller posts nothing at all in this case: the route replaces a guild's
    // rows, so an empty list would be a request to empty the picker.
    expect(
      offerableRoles(
        [
          { id: GUILD, name: '@everyone', position: 0 },
          role('SFU Badminton', { managed: true }),
        ],
        GUILD,
      ),
    ).toEqual([]);
  });
});
