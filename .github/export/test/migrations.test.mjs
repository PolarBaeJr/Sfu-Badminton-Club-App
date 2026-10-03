import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { compileRules } from '../lib/leaks.mjs';
import { computeManifest, formatManifest } from '../lib/manifest.mjs';
import { REDACTED, redactMigration } from '../lib/transform.mjs';

const compiled = compileRules(
  { rules: [{ id: 'host', category: 'infra', level: 'fail', pattern: 'secret-host' }], emailAllow: ['example.org'] },
  ['Jordan Avery'],
);
const PATH = 'supabase/migrations/00001_x.sql';

test('a whole-line comment that trips a rule is redacted, keeping indent and line count', () => {
  const sql = 'SELECT 1;\n  -- ran on secret-host\n-- fine comment\n';
  const { text, redacted } = redactMigration(compiled, PATH, sql);
  assert.equal(redacted, 1);
  assert.equal(text, `SELECT 1;\n  ${REDACTED}\n-- fine comment\n`);
  assert.equal(text.split('\n').length, sql.split('\n').length);
});

test('personal patterns and foreign emails redact too, case-insensitively', () => {
  const sql = '-- asked by jordan avery\n-- mail jane@example.net\n-- mail jane@example.org\n';
  const { text, redacted } = redactMigration(compiled, PATH, sql);
  assert.equal(redacted, 2);
  assert.equal(text, `${REDACTED}\n${REDACTED}\n-- mail jane@example.org\n`);
});

test('lines inside single-quoted literals and block comments are data, never touched', () => {
  const sql = "INSERT INTO t VALUES ('a\n-- secret-host\nb');\n/*\n-- secret-host\n*/\n";
  const { text, redacted } = redactMigration(compiled, PATH, sql);
  assert.equal(redacted, 0);
  assert.equal(text, sql);
});

test('inside a dollar body, `--` is a comment but `---` is markdown', () => {
  const sql = 'DO $$\nBEGIN\n  -- secret-host\nEND $$;\nSELECT $md$\n--- secret-host\n$md$;\n';
  const { text, redacted } = redactMigration(compiled, PATH, sql);
  assert.equal(redacted, 1);
  assert.ok(text.includes(`  ${REDACTED}\n`));
  assert.ok(text.includes('--- secret-host'));
});

test('a dollar body ends only at its own closing tag', () => {
  const sql = "SELECT $a$ it's $b$ fine\n-- secret-host\n$a$;\n-- secret-host\n";
  const { text, redacted } = redactMigration(compiled, PATH, sql);
  assert.equal(redacted, 2);
  assert.equal(text.split('\n')[3], REDACTED);
});

test('a hit in SQL code is left for the leak scan', () => {
  const sql = "SELECT 'secret-host';\n";
  assert.equal(redactMigration(compiled, PATH, sql).text, sql);
});

test('the manifest matches the migration-manifest test algorithm', () => {
  const a = Buffer.from('SELECT 1;\n');
  const b = Buffer.from('SELECT 2;\n');
  const m = computeManifest([['00002_b.sql', b], ['README.md', Buffer.from('x')], ['00001_a.sql', a]]);
  const sha = (buf) => createHash('sha256').update(buf).digest('hex');
  const rollup = createHash('sha256').update(`00001 ${sha(a)}\n00002 ${sha(b)}\n`).digest('hex');
  assert.deepEqual(m, { count: 2, latest: '00002', rollup });
  assert.ok(formatManifest(m).endsWith('}\n'));
});
