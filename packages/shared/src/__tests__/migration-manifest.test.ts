// F-012. supabase/migrations/.manifest.json is the release manifest: what
// schema this checkout expects a database to be at. `db-migrate.sh preflight`
// compares it against public.schema_migrations and refuses the promotion when
// they differ.
//
// A manifest is only worth anything if it cannot go stale. This test is that
// guarantee: it recomputes the manifest from the migration directory and fails
// when the committed file disagrees, so adding a migration without running
// scripts/gen-migration-manifest.sh fails CI rather than shipping an image that
// claims to expect a schema it does not.

import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const MIGRATIONS = join(__dirname, '..', '..', '..', '..', 'supabase', 'migrations');

function computed() {
  const files = readdirSync(MIGRATIONS)
    .filter((f) => /^\d+.*\.sql$/.test(f))
    .sort();
  const lines = files.map((f) => {
    const version = f.split('_')[0]!;
    const sum = createHash('sha256').update(readFileSync(join(MIGRATIONS, f))).digest('hex');
    return `${version} ${sum}`;
  });
  return {
    count: files.length,
    latest: files.length ? files[files.length - 1]!.split('_')[0]! : '',
    // Same input the shell generator hashes: one trailing newline per line.
    rollup: createHash('sha256').update(lines.join('\n') + '\n').digest('hex'),
  };
}

describe('migration release manifest', () => {
  const manifest = JSON.parse(readFileSync(join(MIGRATIONS, '.manifest.json'), 'utf8'));

  it('matches the migration directory', () => {
    // If this fails: run ./scripts/gen-migration-manifest.sh and commit the result.
    expect(manifest).toEqual(computed());
  });

  it('is the shape preflight reads', () => {
    expect(typeof manifest.count).toBe('number');
    expect(manifest.latest).toMatch(/^\d{5}$/);
    expect(manifest.rollup).toMatch(/^[a-f0-9]{64}$/);
  });

  it('covers every migration file, gaps in numbering included', () => {
    // The versions are not contiguous — some numbers were skipped or
    // renumbered — so `latest` is not the count and neither one alone can
    // stand in for the rollup.
    const files = readdirSync(MIGRATIONS).filter((f) => /^\d+.*\.sql$/.test(f));
    expect(manifest.count).toBe(files.length);
    expect(Number(manifest.latest)).toBeGreaterThanOrEqual(manifest.count);
  });

  it('changes when a migration file changes', () => {
    // The property that makes this worth having: `latest` cannot see a
    // migration edited after it was applied, and `count` cannot see one
    // renumbered. The rollup sees both.
    const lines = ['00001 aaa', '00002 bbb'];
    const a = createHash('sha256').update(lines.join('\n') + '\n').digest('hex');
    const b = createHash('sha256').update(['00001 aaa', '00002 ccc'].join('\n') + '\n').digest('hex');
    expect(a).not.toBe(b);
  });
});
