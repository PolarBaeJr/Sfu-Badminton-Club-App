// EVERY RESTORE WRITES THE SAME FIVE COLUMNS, OR IT IS NOT A RESTORE.
//
// Four places put a member back on the active roster. Exactly one of them —
// reactivateLapsedMember — wrote all five columns; it even carried a long
// comment explaining why last_active_at was load-bearing. The other three wrote
// `active_flag: true` and stopped, so mark-inactive-players (which selects on
// `active_flag = true AND last_active_at < cutoff`) put the member straight
// back in its result set. The restore was reversed the same night and, because
// the notice stamp had just been cleared, the member was emailed "your
// membership is now inactive" all over again.
//
// The failure is invisible at the call site: the write succeeds, the audit row
// is honest, the page re-renders showing them active. Only the next morning
// disagrees. So the rule is enforced here rather than left to review — writing
// that column by hand is the bug, and rosterRestoreColumns is the only spelling
// of it.

import { describe, it, expect } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { rosterRestoreColumns } from '../utils/roster-restore';

const repoRoot = fileURLToPath(new URL('../../../../', import.meta.url));

/** `active_flag: true` written as an object literal field. */
const RAW_WRITE = /active_flag:\s*true/;

const ALLOWED = ['packages/shared/src/utils/roster-restore.ts'];

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    // Other branches' checkouts live under .claude/worktrees and are not this
    // branch's code; scanning them would fail on work that is not here.
    if (entry === 'node_modules' || entry === '.next' || entry === '.claude' || entry === '.git') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.tsx?$/.test(entry)) out.push(full);
  }
  return out;
}

describe('rosterRestoreColumns', () => {
  it('writes all five columns the overnight jobs read', () => {
    const cols = rosterRestoreColumns('2026-08-18T00:00:00.000Z');
    expect(cols).toEqual({
      active_flag: true,
      // The one the three broken call sites were missing. Without it the
      // restore is undone by mark-inactive-players on its next run.
      last_active_at: '2026-08-18T00:00:00.000Z',
      inactivity_notice_sent_at: null,
      inactive_since: null,
      updated_at: '2026-08-18T00:00:00.000Z',
    });
  });

  it('uses ONE clock reading, so the two timestamps cannot disagree', () => {
    const cols = rosterRestoreColumns('2026-08-18T12:34:56.000Z');
    expect(cols.last_active_at).toBe(cols.updated_at);
  });

  it('is the only place active_flag: true is written', () => {
    const offenders: string[] = [];
    for (const dir of ['apps', 'packages']) {
      for (const file of sourceFiles(join(repoRoot, dir))) {
        const rel = file.slice(repoRoot.length);
        if (ALLOWED.includes(rel) || rel.includes('__tests__')) continue;
        const src = readFileSync(file, 'utf8');
        // ONLY FILES THAT WRITE THE TABLE. `active_flag: true` is also a
        // legitimate ARGUMENT — the console's Restore button passes it to
        // updatePlayer, which is the server action this rule already covers.
        // Flagging the caller as well would demand the helper at a site with no
        // database access, which is not what the rule means.
        if (!src.includes("from('players')")) continue;
        src.split('\n').forEach((line, i) => {
          // Prose describing the rule is not a write of it.
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
          // Nor is an audit payload: those rows RECORD a write that happened
          // elsewhere, and the write itself is what this rule governs.
          if (/(old|new)_?[Vv]alue/.test(line)) return;
          if (RAW_WRITE.test(line)) offenders.push(`${rel}:${i + 1}  ${line.trim()}`);
        });
      }
    }
    expect(
      offenders,
      'Spread rosterRestoreColumns(nowISO) instead — a restore that sets ' +
        'active_flag without bumping last_active_at is reversed by ' +
        `mark-inactive-players on its next run:\n${offenders.join('\n')}`,
    ).toEqual([]);
  });
});
