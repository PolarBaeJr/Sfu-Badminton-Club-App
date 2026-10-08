import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

// A TOURNAMENT NOTIFICATION WITHOUT A tournament_id IS A ROW WITH NOWHERE TO GO.
//
// The player app links these at /tournaments/[id]/events/[eventId] — see
// notificationAction() in apps/player/src/lib/notification-rows.ts, which
// returns null when it has an event id and no tournament id. So a producer that
// writes { match_id, event_id } and stops does not merely lose a nicety: the
// member gets a notification they cannot open, and the only repair is a second
// query on the reading side (which /notifications does carry, for the rows that
// were written that way before this was noticed).
//
// enterMatchResult was that producer while the other two — bracket published,
// event completed — always wrote both ids, which is exactly how a gap like this
// survives: it looks like the surrounding code.
//
// Read off the SOURCE rather than exercised through the client, deliberately.
// What is being defended is a call-site convention across a directory, and a
// behavioural test can only cover the call sites somebody remembered to write a
// case for — which is the same thing that failed here. A new notifyPlayers()
// call anywhere in tournament-actions/ is caught the moment it is added.

const ACTIONS_DIR = join(__dirname, '..', 'tournament-actions');

/** The text of every argument list passed to `notifyPlayers` in `source`. */
function notifyPlayersCalls(source: string): string[] {
  const calls: string[] = [];
  const marker = 'notifyPlayers(';

  for (let at = source.indexOf(marker); at !== -1; at = source.indexOf(marker, at + 1)) {
    // Skip the declaration and the imports of the name — only calls take args
    // we can read, and `export async function notifyPlayers(` would otherwise
    // be scanned as if it were one.
    const before = source.slice(Math.max(0, at - 40), at);
    if (/function\s+$/.test(before)) continue;

    let depth = 0;
    let end = -1;
    for (let i = at + marker.length - 1; i < source.length; i += 1) {
      const ch = source[i];
      if (ch === '(') depth += 1;
      else if (ch === ')') {
        depth -= 1;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) throw new Error(`Unbalanced notifyPlayers( call at offset ${at}`);
    calls.push(source.slice(at + marker.length, end));
  }

  return calls;
}

const SOURCES = readdirSync(ACTIONS_DIR)
  .filter((f) => f.endsWith('.ts'))
  .map((f) => ({ file: f, text: readFileSync(join(ACTIONS_DIR, f), 'utf8') }));

describe('tournament notification metadata', () => {
  it('finds the notifyPlayers call sites at all', () => {
    // A guard on the guard: if the helper is renamed, every assertion below
    // passes vacuously and this suite silently stops defending anything.
    const total = SOURCES.reduce((n, s) => n + notifyPlayersCalls(s.text).length, 0);
    expect(total).toBeGreaterThanOrEqual(3);
  });

  it('every notifyPlayers call passes tournament_id in its metadata', () => {
    const missing: string[] = [];

    for (const { file, text } of SOURCES) {
      for (const call of notifyPlayersCalls(text)) {
        if (!call.includes('tournament_id')) {
          missing.push(`${file}: ${call.replace(/\s+/g, ' ').slice(0, 90)}`);
        }
      }
    }

    expect(missing).toEqual([]);
  });

  it('reads the argument list, not just the line the call starts on', () => {
    // The calls in this directory span five or six lines each, so a check that
    // only looked at the matched line would report every one of them missing.
    // Proving the scanner spans lines is what makes the assertion above mean
    // "the metadata has it" rather than "the first line happens to".
    const calls = notifyPlayersCalls(
      "await notifyPlayers(client, ids,\n  'Title',\n  `Body (${x})`,\n  { event_id: e, tournament_id: t },\n  'tournament_match_result'\n);",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain('tournament_id');
    expect(calls[0]).toContain('tournament_match_result');
  });

  it('reports a call that omits tournament_id', () => {
    const calls = notifyPlayersCalls(
      "await notifyPlayers(client, ids, 'T', 'B',\n  { match_id: m, event_id: e },\n  'tournament_match_result');",
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain('tournament_id');
  });
});
