import { describe, it, expect } from 'vitest';
import { resolveRoleMentions } from '../discord-mentions';

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
