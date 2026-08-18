import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

// MEMBER-PRIVACY AUDIT §2.5 — "Show activity status" was a switch wired to
// nothing.
//
// It read and wrote `players.show_activity_status` from the settings page and
// was consulted by NOTHING: no screen, no query, no policy. `last_active_at` is
// not granted to `authenticated` (00032), so no member can see another
// member's last-active time whatever the switch is set to.
//
// That made it worse than inert. A member who turned it off had been told they
// were now private about their activity, while the disclosure it SOUNDS like it
// governs — when was this person last around — was fully readable through
// session_attendance and session_rsvp. A control that manufactures confidence
// it cannot deliver is worse than no control, and the honest fix is to remove
// it rather than to wire it up: wiring it up means first building a surface
// that discloses activity.
//
// WHAT THIS FILE GUARDS is the pair, not the removal. Either the control is
// absent, or a members' surface exists for it to govern. Putting the switch
// back without the surface fails here; building the surface and putting the
// switch back with it passes, which is the outcome anyone doing that work
// wants.

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, found);
    else if (/\.tsx?$/.test(entry)) found.push(full);
  }
  return found;
}

const SRC = join(__dirname, '..', '..');
const rel = (f: string) => f.slice(SRC.length + 1).replace(/\\/g, '/');

// COMMENTS ARE STRIPPED BEFORE SCANNING. The settings page carries a block
// comment explaining what used to be there and why it went, which names the
// column — and a scan that flagged its own tombstone would force whoever wrote
// it to describe the fix without naming the thing it fixed. What is being
// looked for is CODE that reads or writes the column.
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
}

const files = sourceFiles(SRC).filter((f) => !f.includes('__tests__'));

describe('the members\' app does not offer a privacy control it cannot honour', () => {
  it('has no reader or writer of show_activity_status', () => {
    const offenders = files
      .filter((f) => /show_activity_status/.test(code(f)))
      .map(rel);
    expect(
      offenders,
      'show_activity_status is back in the members\' app. Audit §2.5: this column ' +
      'governs nothing — last_active_at is not granted to `authenticated`, so no ' +
      'member can see another\'s last-active time. If a surface that discloses ' +
      'activity now exists, wire the switch to THAT and update this test to name ' +
      'it; if it does not, the switch is a promise the app cannot keep.',
    ).toEqual([]);
  });

  it('does not select another member\'s last_active_at', () => {
    // The console reads this column freely — it is on the service role and it
    // is how the inactivity queue is run. The members' app reading it is the
    // thing that would make the switch meaningful, and would need the grant in
    // 00032 widened first, which is a decision rather than an oversight.
    const offenders = files
      .filter((f) => /last_active_at/.test(code(f)))
      .map(rel)
      // These four WRITE it, for the caller's own row only — the check-in bump
      // and the reactivation path. Writing your own last-active time is not a
      // disclosure of anybody's, and the allowlist is names rather than a
      // "looks like a write" heuristic so that adding a READ to one of these
      // files still has to be a deliberate edit here.
      .filter((f) => ![
        'lib/reactivate.ts',
        'lib/actions/profile.ts',
        'lib/actions/_shared.ts',
        'lib/actions/sessions.ts',
      ].includes(f));
    expect(
      offenders,
      'a members\' app file now touches last_active_at outside the three that bump ' +
      'the caller\'s own. If this is a real activity surface, §2.5 changes: the ' +
      'grant in 00032 has to be widened deliberately AND show_activity_status has ' +
      'to gate it before it ships.',
    ).toEqual([]);
  });

  it('the settings page no longer advertises the control', () => {
    const settings = readFileSync(join(SRC, 'app', 'settings', 'page.tsx'), 'utf8');
    // The label is the promise. Asserting on it rather than on the state
    // variable is deliberate: renaming the variable would not un-break the
    // promise, and the label is what the member actually read.
    expect(settings).not.toContain('Show activity status');
    expect(settings).not.toContain('when you were last active');
  });

  it('the leaderboard privacy switch beside it is untouched', () => {
    // hide_from_leaderboard governs something real (leaderboard-privacy.test.ts
    // pins it). Removing the dead switch must not take the live one with it —
    // this is the ablation half: a change that deleted the whole Privacy
    // section would pass every assertion above.
    const settings = readFileSync(join(SRC, 'app', 'settings', 'page.tsx'), 'utf8');
    expect(settings).toContain('Show on leaderboard');
    expect(settings).toContain('hide_from_leaderboard: !showOnLeaderboard');
  });
});
