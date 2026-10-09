import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { applyBrandMap, compileBrandMap, rewritePath, rewritePaths } from '../lib/transform.mjs';

const map = {
  rules: [
    { from: 'acmeclub', to: 'clubladder', path: true },
    { from: 'AcmeClub', to: 'ClubLadder', path: true },
    { from: 'Acme', to: 'Club' },
    { from: 'acmeclub.example', to: 'example.com' },
    { from: 'acmeonly', to: 'scoped', path: true, paths: ['apps/mobile/**'] },
  ],
};

test('only rules flagged path rename paths', () => {
  const rules = compileBrandMap(map);
  assert.equal(rewritePath(rules, 'docs/Acme.md'), 'docs/Acme.md');
  assert.equal(
    rewritePath(rules, 'apps/mobile/android/src/main/kotlin/com/acmeclub/app/Main.kt'),
    'apps/mobile/android/src/main/kotlin/com/clubladder/app/Main.kt',
  );
  assert.equal(rewritePath(rules, 'ios/AcmeClub/AcmeClub.entitlements'), 'ios/ClubLadder/ClubLadder.entitlements');
});

test('a path rule honours paths and exclude against the source path', () => {
  const rules = compileBrandMap(map);
  assert.equal(rewritePath(rules, 'apps/mobile/acmeonly.txt'), 'apps/mobile/scoped.txt');
  assert.equal(rewritePath(rules, 'apps/web/acmeonly.txt'), 'apps/web/acmeonly.txt');
});

test('a Kotlin package line and its directory move together', () => {
  const rules = compileBrandMap(map);
  const path = 'kotlin/com/acmeclub/app/ui/Screen.kt';
  const text = 'package com.acmeclub.app.ui\n';
  const newPath = rewritePath(rules, path);
  const newText = applyBrandMap(rules, path, text);
  const dirPackage = newPath.split('/').slice(1, -1).join('.');
  assert.equal(newText, `package ${dirPackage}\n`);
});

test('path hits are counted per rule', () => {
  const rules = compileBrandMap(map);
  const counts = new Map();
  rewritePath(rules, 'AcmeClub/AcmeClubTests/x.swift', counts);
  assert.equal(counts.get('AcmeClub'), 2);
});

test('two sources landing on one exported path are reported, never merged', () => {
  const rules = compileBrandMap(map);
  const files = new Map([
    ['a/acmeclub.txt', { text: '1' }],
    ['a/clubladder.txt', { text: '2' }],
    ['b/AcmeClub.txt', { text: '3' }],
  ]);
  const result = rewritePaths(rules, files);
  assert.deepEqual(result.collisions, ['a/clubladder.txt']);
  assert.equal(result.files.get('b/ClubLadder.txt').text, '3');
  assert.equal(result.sourceOf.get('b/ClubLadder.txt'), 'b/AcmeClub.txt');
});

test('the shipped map renames the mobile package and target folders consistently', () => {
  const config = JSON.parse(readFileSync(new URL('../brand-map.json', import.meta.url), 'utf8'));
  const rules = compileBrandMap(config);
  const kotlin = 'apps/mobile/android/app/src/main/kotlin/com/sfubadminton/app/ui/AppRoot.kt';
  const newKotlin = rewritePath(rules, kotlin);
  assert.doesNotMatch(newKotlin, /sfu|badminton/i);
  const dirPackage = newKotlin.split('/kotlin/')[1].split('/').slice(0, -1).join('.');
  assert.equal(applyBrandMap(rules, kotlin, 'package com.sfubadminton.app.ui'), `package ${dirPackage}`);
  const ios = 'apps/mobile/ios/SFUBadminton/SFUBadminton.entitlements';
  const newIos = rewritePath(rules, ios);
  assert.doesNotMatch(newIos, /sfu|badminton/i);
  // project.yml names the same file relative to apps/mobile/ios.
  assert.equal(
    applyBrandMap(rules, 'apps/mobile/ios/project.yml', 'SFUBadminton/SFUBadminton.entitlements'),
    newIos.slice('apps/mobile/ios/'.length),
  );
});
