import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

import { loadPatterns, parseArgs } from '../export.mjs';

const EXPORT = fileURLToPath(new URL('../export.mjs', import.meta.url));
const opts = (require) => ({ ...parseArgs(['--out', join(tmpdir(), 'unused')]), requirePatterns: require });

for (const [label, env] of [
  ['missing', {}],
  ['empty', { EXPORT_LEAK_PATTERNS: '' }],
  ['whitespace-only', { EXPORT_LEAK_PATTERNS: ' \n\t\n ' }],
]) {
  test(`--require-patterns fails closed when the secret is ${label}`, () => {
    const r = loadPatterns(opts(true), env);
    assert.match(r.error, /refusing to publish/);
    assert.equal(r.patterns.length, 0);
  });

  test(`a dry run only warns when the secret is ${label}`, () => {
    const r = loadPatterns(opts(false), env);
    assert.equal(r.error, undefined);
    assert.match(r.warning, /personal-value check skipped/);
  });
}

test('with patterns set, neither flag errors or warns', () => {
  for (const require of [true, false]) {
    const r = loadPatterns(opts(require), { EXPORT_LEAK_PATTERNS: 'Jordan Avery\n' });
    assert.deepEqual(r, { patterns: ['Jordan Avery'] });
  }
});

test('the CLI exits non-zero before writing anything when publishing without patterns', () => {
  const dir = mkdtempSync(join(tmpdir(), 'export-req-'));
  const out = join(dir, 'tree');
  try {
    const env = { ...process.env };
    delete env.EXPORT_LEAK_PATTERNS;
    delete env.GITHUB_OUTPUT;
    const res = spawnSync(process.execPath, [EXPORT, '--out', out, '--require-patterns'], { env, encoding: 'utf8' });
    assert.equal(res.status, 1);
    assert.match(res.stdout, /::error::EXPORT_LEAK_PATTERNS is not set or empty/);
    assert.ok(!existsSync(out));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a patterns file inside the repository is refused', () => {
  const o = { ...opts(true), patternsFile: EXPORT };
  assert.throws(() => loadPatterns(o, {}), /outside the source repository/);
});
