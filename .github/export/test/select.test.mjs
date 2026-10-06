import assert from 'node:assert/strict';
import { test } from 'node:test';

import { globToRegExp, parseInclude, selectPaths } from '../lib/select.mjs';

test('globs are anchored and segment-aware', () => {
  assert.ok(globToRegExp('apps/*/package.json').test('apps/admin/package.json'));
  assert.ok(!globToRegExp('apps/*/package.json').test('apps/admin/src/package.json'));
  assert.ok(globToRegExp('**/.env').test('.env'));
  assert.ok(globToRegExp('**/.env').test('apps/admin/.env'));
  assert.ok(!globToRegExp('**/.env').test('apps/admin/.env.example'));
  assert.ok(globToRegExp('docs/').test('docs/a/b.md'));
  assert.ok(globToRegExp('docs/project/0[1-4]-*.md').test('docs/project/03-roadmap.md'));
  assert.ok(!globToRegExp('docs/project/0[1-4]-*.md').test('docs/project/05-x.md'));
  assert.ok(globToRegExp('a?.md').test('ab.md'));
  assert.ok(!globToRegExp('a?.md').test('a/.md'));
});

test('default deny: an unlisted path is not exported', () => {
  const rules = parseInclude('apps/**\n');
  const { selected } = selectPaths(['apps/a.ts', 'secret.txt'], rules);
  assert.deepEqual(selected, ['apps/a.ts']);
});

test('the last matching include line wins', () => {
  const rules = parseInclude('# comment\n\ndocs/**\n!docs/ops/**\ndocs/ops/public.md\n');
  const { selected } = selectPaths(['docs/a.md', 'docs/ops/b.md', 'docs/ops/public.md'], rules);
  assert.deepEqual(selected, ['docs/a.md', 'docs/ops/public.md']);
});

test('the denylist overrides include, and denyAllow re-admits', () => {
  const rules = parseInclude('**\n');
  const { selected } = selectPaths(
    ['a/.env', 'a/.env.local', 'a/.env.example', 'a/b.ts'],
    rules,
    ['**/.env', '**/.env.*'],
    ['**/.env.example'],
  );
  assert.deepEqual(selected, ['a/.env.example', 'a/b.ts']);
});

test('an include pattern that matches nothing is reported', () => {
  const rules = parseInclude('apps/**\ngone/**\n');
  const { unmatched } = selectPaths(['apps/a.ts'], rules);
  assert.deepEqual(unmatched, ['gone/**']);
});
