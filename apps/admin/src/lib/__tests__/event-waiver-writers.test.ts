import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// THE ANTI-LAUNDERING GUARANTEE, AS A TEST RATHER THAN A PROMISE.
//
// The club owner's requirement was that an exec adding somebody on the day can
// hand them a device and have them sign there and then — and that the resulting
// row must be a REAL signature, the member reading the text and agreeing, not
// an officer ticking a box on their behalf.
//
// Those two are indistinguishable in the data if both can write the table. A row
// an officer created looks exactly like a row the member created: same
// player_id, same hash, same timestamp. No column fixes that — a service-role
// writer fills in whatever it likes, so a `signed_by` column constrained to
// equal `player_id` would be a decoration, not a guarantee. And a row that looks
// like a signature but is an officer's assertion is WORSE than no row, because
// the club then holds a document saying somebody agreed to something they were
// never shown.
//
// The guarantee is therefore structural: the ADMIN APP CONTAINS NO WRITER AT
// ALL. Every insert happens in the player app, behind requirePlayer(), against
// the member's own session cookie. "Sign at the door" means handing over a
// device the member is signed in on.
//
// This test is what stops that being a sentence in a comment. It reads the
// admin app's source and asserts that nothing in it writes the table, and reads
// the player app's and asserts every writer sits behind requirePlayer(). An
// officer's claim that they handed somebody a tablet is an audit fact; it goes
// to tournament_audit_log, where officer claims belong.

const ADMIN_SRC = join(__dirname, '../..');
const PLAYER_SRC = join(__dirname, '../../../../player/src');

const TABLE = 'event_waiver_acceptances';
/** Anything that could put a row in, or take one out. */
const MUTATIONS = ['.insert(', '.upsert(', '.update(', '.delete(', '.rpc('];

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) out.push(...sourceFiles(path));
    else if (/\.tsx?$/.test(name) && !name.endsWith('.test.ts') && !name.endsWith('.test.tsx')) {
      out.push(path);
    }
  }
  return out;
}

/**
 * Files that name the table AND perform a mutation somewhere in the same
 * statement chain. Crude on purpose: a false positive costs somebody thirty
 * seconds of reading, and the failure it guards against costs the club its
 * defence.
 */
function writersOf(dir: string): string[] {
  const hits: string[] = [];
  for (const file of sourceFiles(dir)) {
    const source = readFileSync(file, 'utf8');
    if (!source.includes(TABLE)) continue;
    // Take each `.from('event_waiver_acceptances')` and look at what is chained
    // onto it, up to the end of the statement.
    const marker = `.from('${TABLE}')`;
    let index = source.indexOf(marker);
    while (index !== -1) {
      const chain = source.slice(index, index + 400);
      if (MUTATIONS.some((m) => chain.includes(m))) {
        hits.push(file.slice(file.indexOf('/src/') + 1));
        break;
      }
      index = source.indexOf(marker, index + 1);
    }
  }
  return hits.sort();
}

describe('nobody signs an event waiver on somebody else’s behalf', () => {
  // THE LOAD-BEARING ASSERTION. If this ever fails, somebody has given an exec
  // a way to record a signature for a member — which is the exact failure the
  // whole design is built around, and it will not look like a failure from the
  // outside: the roster will go green.
  it('the admin app never writes event_waiver_acceptances', () => {
    expect(writersOf(ADMIN_SRC)).toEqual([]);
  });

  // The admin app READS it, on purpose — the roster shows who has signed and
  // check-in refuses whoever has not. This asserts the read exists, so the test
  // above cannot start passing merely because the table stopped being mentioned
  // at all.
  it('the admin app does read it, so the assertion above is about writes', () => {
    const readers = sourceFiles(ADMIN_SRC).filter((f) => readFileSync(f, 'utf8').includes(TABLE));
    expect(readers.length).toBeGreaterThan(0);
  });

  it('every player-app writer sits behind the member’s own session', () => {
    const writers = writersOf(PLAYER_SRC);
    expect(writers.length, 'the player app must be the one that writes it').toBeGreaterThan(0);

    for (const relative of writers) {
      const absolute = join(PLAYER_SRC, '..', relative.replace(/^src\//, 'src/'));
      const source = readFileSync(absolute, 'utf8');
      // Either this file authenticates the member itself, or it is a helper
      // whose only callers do — and helpers take the player id as an argument
      // rather than resolving one, which is the shape that keeps "whose
      // signature is this" a question only requirePlayer() can answer.
      const authenticatesHere = source.includes('requirePlayer(');
      const isHelperTakingPlayerId = source.includes('playerId: string');
      expect(
        authenticatesHere || isHelperTakingPlayerId,
        `${relative} writes ${TABLE} without requirePlayer() and without taking a caller-supplied player id`,
      ).toBe(true);
    }
  });

  // THE PARAMETER THAT MUST NOT EXIST. acceptEventWaiver takes a tournament id
  // and a tick box — no player id — because a player-id parameter is all an
  // exec-facing wrapper would need to start recording other people's
  // signatures. The server takes the signer from the session and nowhere else.
  it('the member-facing accept action takes no player id', () => {
    const source = readFileSync(join(PLAYER_SRC, 'lib/tournament-actions.ts'), 'utf8');
    const signature = source.slice(
      source.indexOf('export async function acceptEventWaiver'),
      source.indexOf('export async function acceptEventWaiver') + 200,
    );
    expect(signature).toContain('tournamentId: string');
    expect(signature.toLowerCase()).not.toContain('playerid');
  });
});
