// ONE DERIVATION, OR THE NINTH CALL SITE IS THE BUG.
//
// Eight surfaces across the two apps open a Realtime channel, and every one of
// them shipped with a bare `.subscribe()` — no status callback — which is the
// only way supabase-js can report that the subscription is dead. That was not
// eight independent oversights: it is what happens when the correct shape is a
// convention rather than a module. A rule written at each call site holds
// exactly until somebody adds the next one by copying the file next door.
//
// So this asserts the shape rather than trusting it. Text over AST for the same
// reason realtime-publication.test.ts is a text scan and says so: the property
// worth guarding ("does every channel go through the shared hook") is answerable
// from source, and anything cleverer would be more code to keep honest than the
// thing it checks.
//
// SCANNING BOTH APPS FROM HERE, rather than a copy in each app's lib. The
// existing per-app publication guards had to be duplicated — they compare app
// source against the migrations, and the two apps subscribe to different
// tables. This one compares app source against a shared module, so the same
// file can and should ask the question once. roster-restore-callers.test.ts is
// the precedent for a shared test reaching up into the apps.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));
const APPS = ['apps/player/src', 'apps/admin/src'];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    // Other branches' checkouts live under .claude/worktrees and are not this
    // branch's code; scanning them would fail on work that is not here.
    if (entry === 'node_modules' || entry === '.next' || entry === '.claude' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    // Tests are not the app, and a test may legitimately contain any of the
    // literals below as a fixture.
    else if (/\.tsx?$/.test(entry) && !full.includes('__tests__')) out.push(full);
  }
  return out;
}

function appFiles(): { path: string; text: string }[] {
  return APPS.flatMap((app) =>
    sourceFiles(join(repoRoot, app)).map((path) => ({
      path: path.slice(repoRoot.length),
      text: readFileSync(path, 'utf8'),
    })),
  );
}

/**
 * Lines that are prose, skipped by the scans below.
 *
 * CRUDE AND DELIBERATE, like the 400-character window in the publication
 * guards. Every live-* component in this repository carries a long comment
 * about `.subscribe()` resolving on an unpublished table, so a scan that did
 * not skip comments would report six violations that are all sentences. A real
 * call is never the first thing on a line that starts with a comment marker,
 * and this is not a parser and does not pretend to be.
 */
function isProse(line: string): boolean {
  const trimmed = line.trimStart();
  return trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*');
}

function codeLines(text: string): string[] {
  return text.split('\n').filter((line) => !isProse(line));
}

/** Every app file that opens a Realtime channel. */
function channelFiles(): { path: string; text: string }[] {
  return appFiles().filter(({ text }) => codeLines(text).some((line) => line.includes('.channel(')));
}

describe('every Realtime channel in both apps goes through useLiveChannel', () => {
  const files = channelFiles();

  it('finds the channels at all', () => {
    // A FLOOR, RAISED WHENEVER A LIVE SURFACE IS ADDED. Same reasoning as the
    // publication guards' floors: if the extraction above silently stopped
    // matching, every assertion below would pass over an empty list and this
    // file would be worth nothing. Eight today — five in the player app
    // (leaderboard, the nav badge, live-rating, live-matches, live-tournament)
    // and three in the console (matches, sessions, tournaments).
    expect(files.length).toBeGreaterThanOrEqual(8);
    expect(files.map((f) => f.path)).toContain('apps/player/src/components/bottom-nav.tsx');
    expect(files.map((f) => f.path)).toContain('apps/admin/src/app/sessions/live-attendance.tsx');
  });

  it('never calls .subscribe() on a channel directly', () => {
    // The defect itself, stated as a rule. A bare `.subscribe()` cannot report
    // CHANNEL_ERROR, TIMED_OUT or CLOSED to anyone, and a `.subscribe(cb)`
    // written by hand at one call site is the drift this whole module exists to
    // prevent — the handling is not one line, it is a backoff, a
    // missed-something flag that has to survive a rebuild, and a teardown.
    //
    // push-client.ts is excluded BY NAME AND ONLY BY NAME: `pushManager.
    // subscribe()` is the Web Push API, an entirely unrelated call that merely
    // shares a verb. Excluding it by pattern (say, "any subscribe with an
    // object argument") would eventually excuse a realtime call too.
    const offenders = files
      .concat(appFiles().filter((f) => f.path.endsWith('push-client.ts')))
      .flatMap(({ path, text }) =>
        codeLines(text)
          .filter((line) => /\.subscribe\(/.test(line) && !line.includes('pushManager.subscribe'))
          .map((line) => `${path}: ${line.trim()}`),
      );
    expect(
      offenders,
      'a bare .subscribe() cannot report that the channel died — use useLiveChannel',
    ).toEqual([]);
  });

  it('imports the hook wherever it opens a channel', () => {
    const missing = files
      .filter(({ text }) => !/useLiveChannel/.test(text))
      .map((f) => f.path);
    expect(missing, 'opens a Realtime channel without the recovery hook').toEqual([]);
  });

  it('hands the hook a callback that actually re-fetches', () => {
    // HALF A FIX PASSES EVERY OTHER ASSERTION IN THIS FILE. `useLiveChannel(()
    // => {})` imports the hook, handles CHANNEL_ERROR, rebuilds the channel and
    // type-checks — and leaves the screen showing the render it had before the
    // outage, because Postgres CDC replays nothing and nobody asked the server
    // for the rows that were written in the gap. Noticing that the channel died
    // and re-fetching afterwards are two halves of one fix and neither is worth
    // anything alone, so the callback is checked and not just its presence.
    //
    // The accepted spellings are named rather than inferred. There are exactly
    // two re-fetches in these eight files: `router.refresh()`, which re-runs the
    // server component (seven sites), and `checkUnread()` in the nav, which
    // re-runs the count query — a route refresh would not recompute that badge,
    // because the nav lives in the layout and never unmounts. A third kind of
    // recovery should be added here deliberately, by someone who has thought
    // about whether it really re-reads.
    const REFETCHES = /router\.refresh\(\)|checkUnread\(\)/;
    const hollow: string[] = [];
    for (const { path, text } of files) {
      const code = codeLines(text).join('\n');
      for (const match of code.matchAll(/useLiveChannel\(/g)) {
        // A window rather than brace matching: every call site in this
        // repository passes a one- or two-line arrow, and a parser here would
        // be more code than the thing it guards. Same trade as the
        // 400-character window in the publication guards.
        const argument = code.slice(match.index + match[0].length, match.index + match[0].length + 200);
        if (!REFETCHES.test(argument)) hollow.push(`${path}: ${argument.split('\n')[0]}`);
      }
    }
    expect(
      hollow,
      'recovering from a dead channel is only half the fix — the callback must re-fetch',
    ).toEqual([]);
  });

  it('stops watching before removing the channel', () => {
    // ORDER IS LOAD-BEARING AND INVISIBLE. `removeChannel` unsubscribes, which
    // delivers CLOSED through the status callback; a watcher torn down AFTER it
    // would read the component's own unmount as an outage and queue a rebuild
    // against a tree React has already thrown away. Every navigation in either
    // app runs this path, so getting it backwards is not an edge case — it is
    // a rebuild per page view.
    //
    // Keyed on the identifier `stopWatching`, which makes it a naming
    // convention this test enforces. That is the trade taken knowingly: a
    // rename fails here loudly, which is much better than the alternative of
    // matching loosely and silently skipping the file that got it wrong.
    for (const { path, text } of files) {
      const stop = text.indexOf('stopWatching()');
      const remove = text.indexOf('removeChannel(');
      expect(stop, `${path} does not call stopWatching() in its cleanup`).toBeGreaterThan(-1);
      expect(remove, `${path} does not remove its channel`).toBeGreaterThan(-1);
      expect(stop, `${path} tears down the watcher after removeChannel()`).toBeLessThan(remove);
    }
  });
});
