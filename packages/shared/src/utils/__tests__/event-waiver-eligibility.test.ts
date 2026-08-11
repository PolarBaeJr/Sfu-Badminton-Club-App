import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  resolveEventWaiverText,
  eventWaiverRequired,
  eventWaiverStatus,
  eventWaiverShortVersion,
  eventWaiverStateLabel,
  screenForEventWaiver,
  eventWaiverRefusal,
  type EventWaiverAcceptance,
} from '../event-waiver-eligibility';

// ELIGIBILITY IS THE KIND OF LOGIC THAT MUST NOT BE WRONG IN EITHER DIRECTION.
// Wrong-permissive means an unsigned member plays a contact sport, which is the
// liability this whole change exists to close. Wrong-restrictive means a queue
// at the door on the morning of a tournament and an exec looking for a way
// round the gate. So both directions are pinned, one case at a time.

const HASH_A = 'a'.repeat(64);
const HASH_B = 'b'.repeat(64);

const at = (iso: string) => `2026-08-${iso}T12:00:00.000Z`;

function row(player_id: string, waiver_hash: string, day: string): EventWaiverAcceptance {
  return { player_id, waiver_hash, accepted_at: at(day) };
}

// ---------------------------------------------------------------------------
// RESOLUTION — which text applies
// ---------------------------------------------------------------------------

describe('resolveEventWaiverText', () => {
  it('is the tournament’s own copy, trimmed', () => {
    expect(resolveEventWaiverText({ waiver_text: '  I accept the risks.  ' })).toBe('I accept the risks.');
  });

  // A NULL, AN EMPTY BOX AND A BOX OF SPACES ARE ALL "NO WAIVER". The middle
  // one is what an exec who cleared the field left behind, and the third is
  // what a stray newline in a textarea leaves behind. Treating either as a
  // waiver would block a whole tournament on text nobody can read.
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', ''],
    ['whitespace only', '   \n\t  '],
  ])('treats %s as no waiver', (_label, value) => {
    expect(resolveEventWaiverText({ waiver_text: value })).toBeNull();
    expect(eventWaiverRequired({ waiver_text: value })).toBe(false);
  });

  it('treats a missing tournament as no waiver rather than throwing', () => {
    expect(resolveEventWaiverText(null)).toBeNull();
    expect(resolveEventWaiverText(undefined)).toBeNull();
  });

  // THE RESOLUTION RULE IS THE PLAYER APP'S, NOT A SECOND ONE. Per-season
  // templates exist (00074) and are copied into waiver_text at creation; if
  // this module ever consulted them, editing a template would retroactively
  // change what somebody already agreed to. This asserts the file does not
  // mention them at all.
  it('never consults the per-season template', () => {
    const source = readFileSync(join(__dirname, '../event-waiver-eligibility.ts'), 'utf8');
    const code = source
      .split('\n')
      .filter((line) => !line.trimStart().startsWith('//') && !line.trimStart().startsWith('*'))
      .join('\n');
    expect(code.includes('event_waiver_templates')).toBe(false);
    expect(code.includes('template')).toBe(false);
  });

  // The other half of "no second rule": no hashing here either, so nothing in
  // this module can pull node:crypto into the player bundle through the barrel.
  it('imports nothing at all, so it can never pull node:crypto into the barrel', () => {
    const source = readFileSync(join(__dirname, '../event-waiver-eligibility.ts'), 'utf8');
    const imports = source.split('\n').filter((line) => /^\s*(import|export)\s.*\bfrom\b/.test(line));
    expect(imports).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// ONE MEMBER'S STANDING
// ---------------------------------------------------------------------------

describe('eventWaiverStatus', () => {
  it('is not_required, and eligible, when the tournament has no waiver', () => {
    const status = eventWaiverStatus('p1', null, []);
    expect(status.state).toBe('not_required');
    expect(status.eligible).toBe(true);
  });

  // ...even if the member happens to have an old acceptance lying around from
  // before the text was cleared. The tournament is asking for nothing.
  it('is not_required even when acceptances exist', () => {
    expect(eventWaiverStatus('p1', null, [row('p1', HASH_A, '01')]).state).toBe('not_required');
  });

  it('is unsigned, and NOT eligible, when there are no rows at all', () => {
    const status = eventWaiverStatus('p1', HASH_A, []);
    expect(status.state).toBe('unsigned');
    expect(status.eligible).toBe(false);
    expect(status.lastAcceptedAt).toBeNull();
  });

  it('is unsigned when the only rows belong to somebody else', () => {
    const status = eventWaiverStatus('p1', HASH_A, [row('p2', HASH_A, '01')]);
    expect(status.state).toBe('unsigned');
    expect(status.eligible).toBe(false);
  });

  it('is signed when a row matches the live wording', () => {
    const status = eventWaiverStatus('p1', HASH_A, [row('p1', HASH_A, '03')]);
    expect(status.state).toBe('signed');
    expect(status.eligible).toBe(true);
    expect(status.signedAt).toBe(at('03'));
  });

  // THE HASH'S CONSEQUENCE, pinned. An exec edits waiver_text; every acceptance
  // of the old wording stops matching; the member is unsigned again. Correct,
  // and it is why editing mid-tournament has to be warned about at the point of
  // the edit.
  it('is stale — signed, but not this text — when no row matches', () => {
    const status = eventWaiverStatus('p1', HASH_B, [row('p1', HASH_A, '01')]);
    expect(status.state).toBe('stale');
    expect(status.eligible).toBe(false);
    expect(status.lastAcceptedAt).toBe(at('01'));
    expect(status.lastAcceptedHash).toBe(HASH_A);
  });

  it('finds the match among several wordings, whatever order they arrive in', () => {
    const rows = [row('p1', HASH_B, '05'), row('p2', HASH_A, '02'), row('p1', HASH_A, '01')];
    const status = eventWaiverStatus('p1', HASH_A, rows);
    expect(status.state).toBe('signed');
    expect(status.signedAt).toBe(at('01'));
    // The display date still tracks the LATEST thing they accepted, which is
    // the newer wording — they are signed either way.
    expect(status.lastAcceptedAt).toBe(at('05'));
    expect(status.lastAcceptedHash).toBe(HASH_B);
  });

  it('reports the newest acceptance date for a stale signer', () => {
    const rows = [row('p1', HASH_A, '01'), row('p1', HASH_B, '04')];
    const status = eventWaiverStatus('p1', 'c'.repeat(64), rows);
    expect(status.state).toBe('stale');
    expect(status.lastAcceptedAt).toBe(at('04'));
    expect(status.lastAcceptedHash).toBe(HASH_B);
  });

  // Only 'signed' and 'not_required' let anybody onto the court. Written as an
  // exhaustive table rather than four separate its, so a fifth state added
  // later cannot quietly default to eligible.
  it('lets exactly two states through', () => {
    const cases = [
      { hash: null, rows: [] as EventWaiverAcceptance[], state: 'not_required', eligible: true },
      { hash: HASH_A, rows: [row('p1', HASH_A, '01')], state: 'signed', eligible: true },
      { hash: HASH_A, rows: [row('p1', HASH_B, '01')], state: 'stale', eligible: false },
      { hash: HASH_A, rows: [], state: 'unsigned', eligible: false },
    ];
    for (const c of cases) {
      const status = eventWaiverStatus('p1', c.hash, c.rows);
      expect(status.state, JSON.stringify(c)).toBe(c.state);
      expect(status.eligible, JSON.stringify(c)).toBe(c.eligible);
    }
  });
});

// ---------------------------------------------------------------------------
// THE LABEL — the /legal shape, for a document with a hash instead of a version
// ---------------------------------------------------------------------------

describe('eventWaiverStateLabel', () => {
  const shortDate = (iso: string) => iso.slice(0, 10);

  it('reads like /legal: signed v… · date', () => {
    const status = eventWaiverStatus('p1', HASH_A, [row('p1', HASH_A, '02')]);
    expect(eventWaiverStateLabel(status, shortDate)).toBe('signed vaaaaaaa · 2026-08-02');
  });

  it('says "never signed", the same words /legal uses', () => {
    expect(eventWaiverStateLabel(eventWaiverStatus('p1', HASH_A, []), shortDate)).toBe('never signed');
  });

  // A stale signer is not accused of failing to do something — the club moved
  // the text. The label has to say which happened, because they are different
  // conversations at the door.
  it('says the wording changed rather than blaming the signer', () => {
    const status = eventWaiverStatus('p1', HASH_B, [row('p1', HASH_A, '02')]);
    expect(eventWaiverStateLabel(status, shortDate)).toBe(
      'signed vaaaaaaa · 2026-08-02 — wording has changed since',
    );
  });

  it('says so plainly when nothing is required', () => {
    expect(eventWaiverStateLabel(eventWaiverStatus('p1', null, []), shortDate)).toBe('no event waiver');
  });

  it('shortens a hash to seven characters, like a git sha, and nothing to null', () => {
    expect(eventWaiverShortVersion(HASH_A)).toBe('aaaaaaa');
    expect(eventWaiverShortVersion(null)).toBeNull();
    expect(eventWaiverShortVersion('')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SCREENING A FIELD — singles, pairs and bulk
// ---------------------------------------------------------------------------

const alice = { id: 'p1', name: 'Alice' };
const bob = { id: 'p2', name: 'Bob' };
const cara = { id: 'p3', name: 'Cara' };

describe('screenForEventWaiver', () => {
  it('waves everyone through when the tournament has no waiver', () => {
    const result = screenForEventWaiver(
      [{ id: 'e1', members: [alice] }, { id: 'e2', members: [bob, cara] }],
      null,
      [],
    );
    expect(result.allowed).toEqual(['e1', 'e2']);
    expect(result.blocked).toEqual([]);
  });

  it('splits a field instead of refusing all of it', () => {
    const result = screenForEventWaiver(
      [{ id: 'e1', members: [alice] }, { id: 'e2', members: [bob] }, { id: 'e3', members: [cara] }],
      HASH_A,
      [row('p1', HASH_A, '01'), row('p3', HASH_A, '01')],
    );
    // THE BULK PATHS MUST NOT FAIL WHOLE. Two people are checked in and one is
    // named; a queue held up by an all-or-nothing refusal is the failure this
    // feature is meant to prevent, not cause.
    expect(result.allowed).toEqual(['e1', 'e3']);
    expect(result.blocked.map((b) => b.id)).toEqual(['e2']);
  });

  // ---- PAIRS -------------------------------------------------------------
  // A pair is two entrants who happen to play together. One signature is not
  // half an eligibility: the team cannot take the court, because the unsigned
  // half would be on it.
  it('blocks a pair when only one half has signed, and names that half', () => {
    const result = screenForEventWaiver(
      [{ id: 'pair1', members: [alice, bob] }],
      HASH_A,
      [row('p1', HASH_A, '01')],
    );
    expect(result.allowed).toEqual([]);
    expect(result.blocked).toEqual([
      { id: 'pair1', unsigned: [{ id: 'p2', name: 'Bob', state: 'unsigned' }] },
    ]);
  });

  it('names both halves when neither has signed', () => {
    const result = screenForEventWaiver([{ id: 'pair1', members: [alice, bob] }], HASH_A, []);
    expect(result.blocked[0]!.unsigned.map((m) => m.name)).toEqual(['Alice', 'Bob']);
  });

  it('lets a fully signed pair through', () => {
    const result = screenForEventWaiver(
      [{ id: 'pair1', members: [alice, bob] }],
      HASH_A,
      [row('p1', HASH_A, '01'), row('p2', HASH_A, '02')],
    );
    expect(result.allowed).toEqual(['pair1']);
    expect(result.blocked).toEqual([]);
  });

  it('blocks a pair whose partner signed an older wording', () => {
    const result = screenForEventWaiver(
      [{ id: 'pair1', members: [alice, bob] }],
      HASH_B,
      [row('p1', HASH_B, '01'), row('p2', HASH_A, '01')],
    );
    expect(result.blocked[0]!.unsigned).toEqual([{ id: 'p2', name: 'Bob', state: 'stale' }]);
  });

  it('handles an empty field without inventing anything', () => {
    expect(screenForEventWaiver([], HASH_A, [])).toEqual({ allowed: [], blocked: [] });
  });
});

// ---------------------------------------------------------------------------
// THE REFUSAL — what the officer at the door actually reads
// ---------------------------------------------------------------------------

describe('eventWaiverRefusal', () => {
  const screen = (entries: Parameters<typeof screenForEventWaiver>[0], rows: EventWaiverAcceptance[]) =>
    eventWaiverRefusal(screenForEventWaiver(entries, HASH_A, rows).blocked);

  it('is empty when nothing is blocked', () => {
    expect(eventWaiverRefusal([])).toBe('');
  });

  it('names the person and says what fixes it', () => {
    const message = screen([{ id: 'e1', members: [alice] }], []);
    expect(message).toContain('Alice has not accepted');
    expect(message).toContain('cannot be checked in');
    // The one thing that resolves it, said plainly. A refusal that does not
    // say what to do about it is the failure this message exists to avoid.
    expect(message).toContain('open the club app');
  });

  // THE ANTI-LAUNDERING SENTENCE. The exec must not go looking for a tick box,
  // because the whole point is that there isn't one — a row an officer creates
  // on a member's behalf looks like a signature and is not.
  it('says out loud that nobody can sign for them', () => {
    const message = screen([{ id: 'e1', members: [alice] }], []);
    expect(message).toContain('has to be them, signed in as themselves');
    expect(message).toContain('Nobody can accept it on their behalf');
  });

  it('pluralises for more than one, and lists them all', () => {
    const message = screen([{ id: 'e1', members: [alice] }, { id: 'e2', members: [bob] }], []);
    expect(message).toContain('Alice, Bob have not accepted');
  });

  it('explains a stale signature rather than calling it a missing one', () => {
    const message = screen([{ id: 'e1', members: [alice] }], [row('p1', HASH_B, '01')]);
    expect(message).toContain('the waiver text has been edited since they last signed');
  });

  // One member entered in Singles and Mixed holds up two entries. The desk
  // should read one name, not the same name twice.
  it('names a member once even when they hold up several entries', () => {
    const message = screen(
      [{ id: 'e1', members: [alice] }, { id: 'e2', members: [alice, bob] }],
      [row('p2', HASH_A, '01')],
    );
    expect(message.match(/Alice/g)).toHaveLength(1);
    expect(message).toContain('Alice has not accepted');
  });
});
