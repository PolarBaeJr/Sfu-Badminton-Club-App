// F-023. Audit writes are best-effort, and for money, permissions, moderation,
// rating repair, merges/deletions, disputes and tournament finalisation that
// meant a governance fact could disappear with nothing but a Sentry event to
// say so. audit-policy.ts splits the classes; these tests pin the split and,
// more importantly, pin that the split does not silently go stale.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

vi.mock('server-only', () => ({}));
const captureException = vi.fn();
vi.mock('@sentry/nextjs', () => ({ captureException: (...a: unknown[]) => captureException(...a) }));

import { logAdminAudit } from '../audit';
import { REQUIRED_AUDIT_ACTIONS, RISK_CLASS_PATTERNS, isRequiredAudit } from '../audit-policy';

interface Attempt { row: Record<string, unknown>; }

function makeClient(failures: (string | null)[]) {
  const attempts: Attempt[] = [];
  let n = 0;
  const client = {
    from: () => ({
      insert: async (row: Record<string, unknown>) => {
        attempts.push({ row });
        const msg = failures[n++] ?? null;
        return { error: msg ? { message: msg } : null };
      },
    }),
  } as never;
  return { client, attempts };
}

const entry = (action_type: string) => ({
  actor_id: 'admin-1',
  action_type,
  target_type: 'player',
  target_id: '00000000-0000-4000-8000-000000000001',
  old_value: { paid: false },
  new_value: { paid: true },
  reason: 'Cash handed over at the desk',
});

beforeEach(() => captureException.mockReset());

describe('required audit facts survive a refused payload', () => {
  it('retries a high-risk action without old_value/new_value', async () => {
    const { client, attempts } = makeClient(['value too long for type character varying']);

    await logAdminAudit(client, entry('fee_marked_paid'));

    expect(attempts).toHaveLength(2);
    // The fact survives.
    expect(attempts[1]!.row.actor_id).toBe('admin-1');
    expect(attempts[1]!.row.action_type).toBe('fee_marked_paid');
    expect(attempts[1]!.row.target_id).toBe('00000000-0000-4000-8000-000000000001');
    // The payload — the likely cause — does not.
    expect(attempts[1]!.row).not.toHaveProperty('new_value');
    expect(attempts[1]!.row).not.toHaveProperty('old_value');
    // The human's own words are kept, and the loss is stated in the row itself
    // rather than only in Sentry.
    expect(attempts[1]!.row.reason).toContain('Cash handed over at the desk');
    expect(attempts[1]!.row.reason).toContain('audit payload dropped');
  });

  it('does not throw, even when both attempts fail', async () => {
    const { client, attempts } = makeClient(['boom', 'boom again']);

    await expect(logAdminAudit(client, entry('player_banned'))).resolves.toBeUndefined();

    expect(attempts).toHaveLength(2);
    // Two reports: the original, and the one that says the FACT was lost.
    expect(captureException).toHaveBeenCalledTimes(2);
    expect(String(captureException.mock.calls[1]![0])).toContain('FACT lost');
  });

  it('leaves a routine action best-effort — one attempt, no retry', async () => {
    const { client, attempts } = makeClient(['boom']);

    await logAdminAudit(client, entry('session_updated'));

    expect(attempts).toHaveLength(1);
    expect(captureException).toHaveBeenCalledTimes(1);
  });

  it('does nothing extra when the first insert succeeds', async () => {
    const { client, attempts } = makeClient([]);
    await logAdminAudit(client, entry('fee_waived'));
    expect(attempts).toHaveLength(1);
    expect(captureException).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------
// The drift guard. A new high-risk action added without classifying it is the
// only way this policy quietly stops covering what it claims to.
// ------------------------------------------------------------------

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name === '.next' || name === '__tests__') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name)) out.push(full);
  }
  return out;
}

// THE THIRD TRAIL: SQL. Some audit rows are written by database functions, not
// by this console — apply_match_result, reverse_match_result, merge_players and
// others have always done so, and since 00203 the club Void and Convert do too,
// because an audit row that commits with the mutation is the whole point of
// folding them into one transaction.
//
// A scan that reads only TypeScript therefore reports an action as "no longer
// existing" the moment it moves into SQL, which is precisely backwards: it has
// just become MORE durable, not less. That blind spot predates 00203 — it is
// the same shape as the `action:` one below, and it is closed the same way.
//
// Parsed POSITIONALLY rather than by grabbing every quoted word near the
// INSERT: the tuples also carry target_type literals like 'match' and 'dispute',
// and letting those into `used` would quietly weaken the classification test
// two blocks down.
function sqlAuditActions(migrationsDir: string): Set<string> {
  const found = new Set<string>();
  for (const name of readdirSync(migrationsDir)) {
    if (!name.endsWith('.sql')) continue;
    const src = readFileSync(join(migrationsDir, name), 'utf8');
    for (const m of src.matchAll(/INSERT\s+INTO\s+(?:public\.)?audit_logs\s*\(([^)]*)\)([\s\S]{0,600}?)VALUES\s*\(/gi)) {
      const cols = m[1]!.split(',').map((c) => c.trim().toLowerCase());
      const idx = cols.indexOf('action_type');
      if (idx < 0) continue;
      // Walk the VALUES tuple to its matching paren, splitting on top-level
      // commas only, so a nested call like jsonb_build_object(a, b) counts once.
      const rest = src.slice(m.index! + m[0]!.length);
      const args: string[] = [];
      let depth = 0, cur = '', quoted = false;
      for (const ch of rest) {
        if (quoted) { cur += ch; if (ch === "'") quoted = false; continue; }
        if (ch === "'") { quoted = true; cur += ch; continue; }
        if (ch === '(') depth++;
        if (ch === ')') { if (depth === 0) { args.push(cur); break; } depth--; }
        if (ch === ',' && depth === 0) { args.push(cur); cur = ''; continue; }
        cur += ch;
      }
      const lit = args[idx]?.trim().match(/^'([a-z0-9_]+)'$/);
      if (lit) found.add(lit[1]!);
    }
  }
  return found;
}

describe('audit policy drift', () => {
  const used = new Set<string>();
  const fromSql = sqlAuditActions(join(__dirname, '..', '..', '..', '..', '..', 'supabase', 'migrations'));
  for (const a of fromSql) used.add(a);
  for (const file of sourceFiles(join(__dirname, '..', '..'))) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/action_type:\s*'([a-z0-9_]+)'/g)) used.add(m[1]!);
    // THE TOURNAMENT TRAIL WRITES `action:`, NOT `action_type:`.
    //
    // Scanning only the admin trail is why 32 tournament action names sat
    // unclassified while logAudit called isRequiredAudit on every one of them:
    // the guard against drift had a blind spot exactly the shape of the trail
    // that most needed it. Both spellings now feed the same classification.
    for (const m of src.matchAll(/\baction:\s*'([a-z0-9_]+)'/g)) used.add(m[1]!);
  }

  it('finds the action types (guards against the scan itself breaking)', () => {
    expect(used.size).toBeGreaterThan(40);
    expect(used.has('fee_waived')).toBe(true);
    expect(used.has('session_updated')).toBe(true);
    // One name from each trail, so a regex that silently stops matching either
    // spelling fails here rather than passing a vacuous classification check.
    expect(used.has('event_finalized')).toBe(true);
    expect(used.has('match_voided')).toBe(true);
    // The SQL trail, pinned the same way. Without these two a broken migration
    // regex would silently reopen the blind spot and every SQL-written action
    // would start reporting as stale.
    expect(fromSql.has('match_converted_casual')).toBe(true);
    expect(fromSql.has('match_reversed')).toBe(true);
    // ...and it must not have swept up the target_type literals sitting beside
    // the action name in the same tuple.
    expect(fromSql.has('match')).toBe(false);
    expect(fromSql.has('dispute')).toBe(false);
  });

  it('classifies every action whose name puts it in a risk class', () => {
    const unclassified = [...used]
      .filter((a) => RISK_CLASS_PATTERNS.some((re) => re.test(a)))
      .filter((a) => !isRequiredAudit(a))
      .sort();
    expect(unclassified).toEqual([]);
  });

  it('does not list actions that no longer exist', () => {
    // A stale entry is harmless at runtime and misleading to read, and it hides
    // a rename — which is the same drift in the other direction.
    const stale = [...REQUIRED_AUDIT_ACTIONS].filter((a) => !used.has(a)).sort();
    expect(stale).toEqual([]);
  });
});
