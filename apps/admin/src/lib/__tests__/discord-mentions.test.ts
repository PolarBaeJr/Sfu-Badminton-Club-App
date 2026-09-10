import { describe, it, expect } from 'vitest';
import {
  resolveRoleMentions,
  resolveRoleNames,
  unresolveRoleMentions,
} from '../discord-mentions';

// The role map as a real guild has it: the DB's spelling, and an 18-digit
// snowflake, because the length of the id is what decides whether an expanded
// message still fits inside Discord's 2000 characters.
const ROLES = [
  { role_name: 'internal', role_id: '111111111111111111' },
  { role_name: 'session_staff', role_id: '222222222222222222' },
  { role_name: 'executives', role_id: '333333333333333333' },
];

const INTERNAL = '<@&111111111111111111>';
const SESSION_STAFF = '<@&222222222222222222>';

const resolve = (text: string) => resolveRoleMentions(text, ROLES);

describe('resolveRoleMentions', () => {
  it('does not care how the writer capitalised the role', () => {
    // Discord shows @Internal, the database stores `internal`, and somebody
    // shouting reaches for @INTERNAL. All three name one role.
    expect(resolve('@internal').text).toBe(INTERNAL);
    expect(resolve('@Internal').text).toBe(INTERNAL);
    expect(resolve('@INTERNAL').text).toBe(INTERNAL);
  });

  it('accepts every spelling of a two-word role', () => {
    // `session_staff` is the column value, `Session Staff` is what the server
    // displays, and a hyphen is what a hurried thumb produces.
    expect(resolve('@session_staff').text).toBe(SESSION_STAFF);
    expect(resolve('@Session_Staff').text).toBe(SESSION_STAFF);
    expect(resolve('@session staff').text).toBe(SESSION_STAFF);
    expect(resolve('@session-staff').text).toBe(SESSION_STAFF);
  });

  it('leaves @everyone and @here to Discord', () => {
    // Discord resolves these itself. Rewriting them would break the only two
    // mentions that already work.
    const text = 'Gym is closed @everyone, and @here means now.';
    expect(resolve(text).text).toBe(text);
    expect(resolve(text).matched).toEqual([]);
  });

  it('never rewrites a mention that is already a mention, and says the same thing twice', () => {
    const already = `Ask ${INTERNAL} about it.`;
    expect(resolve(already).text).toBe(already);

    // Idempotence, which is what the ordering of the scan buys: the emitted
    // token matches the first branch on the next pass and comes back whole.
    const once = resolve('Ask @internal about it.').text;
    expect(resolve(once).text).toBe(once);
  });

  it('leaves an email address alone', () => {
    // The motivating document is a Code of Conduct. It has addresses in it.
    const text = 'Email wkc10@sfu.ca or the exec team.';
    expect(resolve(text).text).toBe(text);
    expect(resolve(text).matched).toEqual([]);
  });

  it('resolves through markdown', () => {
    expect(resolve('**@internal**').text).toBe(`**${INTERNAL}**`);
    expect(resolve('> @internal').text).toBe(`> ${INTERNAL}`);
  });

  it('keeps the punctuation that follows a role name', () => {
    expect(resolve('@internal, please read this').text).toBe(`${INTERNAL}, please read this`);
    expect(resolve('This is for @internal.').text).toBe(`This is for ${INTERNAL}.`);
  });

  it('does not swallow the word after a role name that is only one word long', () => {
    // The scan takes up to two words so `@session staff` can be found, so the
    // backoff is the only thing standing between this sentence and a mention
    // that ate "courts".
    const text = '@session courts are closed';
    expect(resolve(text).text).toBe(text);
    expect(resolve(text).matched).toEqual([]);
  });

  it('re-emits the second word untouched when the first word is the role', () => {
    expect(resolve('@internal members only').text).toBe(`${INTERNAL} members only`);
  });

  it('leaves an unknown name as literal text rather than refusing the message', () => {
    // A name the club does not have is prose, not an error. This is what gets
    // posted today, so the worst case of the whole feature is the status quo.
    const text = 'Talk to @varsity about the court booking';
    expect(resolve(text).text).toBe(text);
    expect(resolve(text).matched).toEqual([]);
  });

  it('reports the canonical database spellings of what it substituted', () => {
    // What the audit entry quotes. `Session Staff` and `session-staff` are the
    // same row, and one mention of it named twice is still one role.
    const { matched } = resolve('@Session Staff and @session-staff and @internal');
    expect(matched).toEqual(['internal', 'session_staff']);
  });
});

// The ping line's half: role names somebody PICKED, not names they typed. None
// of the prose handling above applies, and the one thing they share is the
// normalisation that makes `Session Staff` and `session_staff` one role.
describe('resolveRoleNames', () => {
  it('turns picked names into ids, however they were spelled', () => {
    const picked = resolveRoleNames(['Session Staff', 'internal'], ROLES);

    expect(picked.ids).toEqual(['222222222222222222', '111111111111111111']);
    // The database's spellings, which is what the audit entry has to quote.
    expect(picked.matched).toEqual(['session_staff', 'internal']);
    expect(picked.unknown).toEqual([]);
  });

  it('names an unknown role instead of quietly dropping it', () => {
    // A dropped ping role is a message that looks like it notifies and rings
    // nobody, which is the failure the ping line exists to remove. The caller
    // refuses the whole message on one of these.
    const picked = resolveRoleNames(['internal', 'varsity'], ROLES);

    expect(picked.unknown).toEqual(['varsity']);
    expect(picked.ids).toEqual(['111111111111111111']);
  });

  it('cannot reach @everyone, because it is not a row in the map', () => {
    expect(resolveRoleNames(['everyone', '@everyone', 'here'], ROLES).ids).toEqual([]);
  });

  it('asks for the same role once, however many times it was sent', () => {
    // A server action is an HTTP endpoint, and the same name three ways is
    // still one line above the embed.
    const picked = resolveRoleNames(['internal', 'Internal', ' internal ', ''], ROLES);

    expect(picked.ids).toEqual(['111111111111111111']);
    expect(picked.unknown).toEqual([]);
  });
});

// The way back, for a composer about to show an exec their own words. Every
// assertion here is a WHOLE-STRING round trip on purpose: naming one mention
// correctly while moving a character somewhere else would be a worse bug than
// the ids this replaces.
describe('unresolveRoleMentions', () => {
  // A name that cannot survive the return trip, in the two shapes that break it:
  // more words than the forward scan captures, and a character the scan's
  // character class does not take.
  const AWKWARD = [
    ...ROLES,
    { role_name: 'the exec team', role_id: '444444444444444444' },
    { role_name: 'vip!', role_id: '555555555555555555' },
  ];

  it('gives back the name, and that name resolves to the same id again', () => {
    const resolved = resolve('Ask @internal about it.').text;
    expect(resolved).toBe(`Ask ${INTERNAL} about it.`);

    const named = unresolveRoleMentions(resolved, ROLES);
    expect(named).toBe('Ask @internal about it.');
    // The proof that the round trip closed: resolving the restored text is the
    // identical string, so pressing Save changes nothing in the channel.
    expect(resolve(named).text).toBe(resolved);
  });

  it('gives back the database spelling of a two-word role', () => {
    const resolved = resolve('@session staff, doors at seven.').text;

    expect(unresolveRoleMentions(resolved, ROLES)).toBe('@session_staff, doors at seven.');
    expect(resolve(unresolveRoleMentions(resolved, ROLES)).text).toBe(resolved);
  });

  it('leaves an id the guild map cannot name exactly as it found it', () => {
    // A live self-assign role from `discord_self_roles` (00168) is the realistic
    // case, not a deleted one, and inventing a name for it would be a lie.
    const text = 'Ask <@&999999999999999999> about it.';
    expect(unresolveRoleMentions(text, ROLES)).toBe(text);
  });

  it('leaves a name that cannot round-trip as the raw id', () => {
    // Three words is more than the forward scan captures, so `@the exec team`
    // would not resolve back to this id and the substitution is refused.
    const threeWords = 'Ask <@&444444444444444444> about it.';
    expect(unresolveRoleMentions(threeWords, AWKWARD)).toBe(threeWords);

    // `!` is outside [A-Za-z0-9_-], so the scan would stop at `@vip`.
    const punctuated = 'Ask <@&555555555555555555> about it.';
    expect(unresolveRoleMentions(punctuated, AWKWARD)).toBe(punctuated);
  });

  it('leaves a mention glued to a word character alone', () => {
    // `@internal` written there would not resolve back, because the forward scan
    // requires whitespace or markdown before the @.
    const text = `x${INTERNAL}`;
    expect(unresolveRoleMentions(text, ROLES)).toBe(text);
  });

  it('does not disturb the prose the forward scan protects', () => {
    for (const text of ['Email wkc10@sfu.ca or the exec team.', '@session courts are closed']) {
      expect(unresolveRoleMentions(resolve(text).text, ROLES)).toBe(text);
    }
  });
});
