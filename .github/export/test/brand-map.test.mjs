import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { applyBrandMap, compileBrandMap } from '../lib/transform.mjs';

const map = {
  rules: [
    { from: 'Acme', to: 'Club' },
    { from: 'Acme Badminton Club', to: 'Club Ladder' },
    { from: 'acme.example', to: 'example.com', paths: ['apps/**'] },
    { from: '@acme', to: '@example', exclude: ['supabase/migrations/**'] },
  ],
};

test('the longest rule applies first', () => {
  const rules = compileBrandMap(map);
  assert.equal(applyBrandMap(rules, 'x.md', 'Acme Badminton Club and Acme'), 'Club Ladder and Club');
});

test('replacement is case-sensitive and literal', () => {
  const rules = compileBrandMap(map);
  assert.equal(applyBrandMap(rules, 'x.md', 'ACME acme Acme.'), 'ACME acme Club.');
});

test('paths and exclude scope a rule', () => {
  const rules = compileBrandMap(map);
  assert.equal(applyBrandMap(rules, 'apps/a.ts', 'acme.example'), 'example.com');
  assert.equal(applyBrandMap(rules, 'docs/a.md', 'acme.example'), 'acme.example');
  assert.equal(applyBrandMap(rules, 'supabase/migrations/1.sql', 'x@acme'), 'x@acme');
  assert.equal(applyBrandMap(rules, 'apps/a.ts', 'x@acme'), 'x@example');
});

test('hits are counted per rule', () => {
  const rules = compileBrandMap(map);
  const counts = new Map();
  applyBrandMap(rules, 'x.md', 'Acme, Acme, Acme Badminton Club', counts);
  assert.equal(counts.get('Acme'), 2);
  assert.equal(counts.get('Acme Badminton Club'), 1);
});

test('the shipped brand map never touches protected identifiers', () => {
  const config = JSON.parse(readFileSync(new URL('../brand-map.json', import.meta.url), 'utf8'));
  const rules = compileBrandMap(config);
  const protectedText = 'sb-badminton-auth-token sfu_rec sfss_purchase_url';
  assert.equal(applyBrandMap(rules, 'apps/player/src/a.ts', protectedText), protectedText);
  for (const rule of config.rules) assert.ok(rule.from.length > 0 && typeof rule.to === 'string');
});
