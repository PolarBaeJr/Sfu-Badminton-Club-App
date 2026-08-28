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

describe('audit policy drift', () => {
  const used = new Set<string>();
  for (const file of sourceFiles(join(__dirname, '..', '..'))) {
    const src = readFileSync(file, 'utf8');
    for (const m of src.matchAll(/action_type:\s*'([a-z0-9_]+)'/g)) used.add(m[1]!);
  }

  it('finds the action types (guards against the scan itself breaking)', () => {
    expect(used.size).toBeGreaterThan(40);
    expect(used.has('fee_waived')).toBe(true);
    expect(used.has('session_updated')).toBe(true);
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
