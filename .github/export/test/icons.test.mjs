import assert from 'node:assert/strict';
import { test } from 'node:test';
import { inflateSync } from 'node:zlib';

import {
  androidLauncherBackground,
  androidLauncherForeground,
  crc32,
  generatedAssets,
  renderIco,
  renderPng,
} from '../lib/icons.mjs';

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunks(png) {
  const out = [];
  let p = 8;
  while (p < png.length) {
    const len = png.readUInt32BE(p);
    const type = png.subarray(p + 4, p + 8).toString('ascii');
    const data = png.subarray(p + 8, p + 8 + len);
    const crc = png.readUInt32BE(p + 8 + len);
    out.push({ type, data, crc, body: png.subarray(p + 4, p + 8 + len) });
    p += 12 + len;
  }
  return out;
}

test('crc32 matches the standard check value', () => {
  assert.equal(crc32(Buffer.from('123456789')), 0xcbf43926);
});

test('renderPng is a valid RGB PNG of the requested size', () => {
  const png = renderPng(32);
  assert.deepEqual(png.subarray(0, 8), SIGNATURE);
  const cs = chunks(png);
  assert.deepEqual(cs.map((c) => c.type), ['IHDR', 'IDAT', 'IEND']);
  for (const c of cs) assert.equal(c.crc, crc32(c.body));
  assert.equal(cs[0].data.readUInt32BE(0), 32);
  assert.equal(cs[0].data.readUInt32BE(4), 32);
  assert.equal(inflateSync(cs[1].data).length, 32 * (32 * 3 + 1));
});

test('rendering is deterministic', () => {
  assert.deepEqual(renderPng(48, 0.1), renderPng(48, 0.1));
  assert.deepEqual(renderIco(), renderIco());
});

test('the ico holds one image per size', () => {
  const ico = renderIco([16, 32, 48]);
  assert.equal(ico.readUInt16LE(0), 0);
  assert.equal(ico.readUInt16LE(2), 1);
  assert.equal(ico.readUInt16LE(4), 3);
});

test('every club icon path is replaced', () => {
  const assets = generatedAssets();
  for (const app of ['player', 'admin']) {
    for (const name of ['apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'favicon.ico']) {
      assert.ok(assets.has(`apps/${app}/public/${name}`), `${app}/${name}`);
    }
  }
  assert.ok(assets.has('apps/player/public/qr/discord.png'));
});

test('the native apps get the mark, at their exported paths', () => {
  const assets = generatedAssets();
  const icon = assets.get('apps/mobile/ios/ClubLadder/Resources/Assets.xcassets/AppIcon.appiconset/AppIcon-1024.png');
  assert.ok(icon);
  const ihdr = chunks(icon)[0].data;
  assert.equal(ihdr.readUInt32BE(0), 1024);
  assert.equal(ihdr[9], 2, 'opaque RGB, as the App Store requires');
  for (const name of ['ic_launcher_background.xml', 'ic_launcher_foreground.xml']) {
    const xml = assets.get(`apps/mobile/android/app/src/main/res/drawable/${name}`).toString('utf8');
    assert.match(xml, /^<\?xml/);
    assert.match(xml, /android:viewportWidth="108"/);
    const pathData = /android:pathData="([^"]+)"/.exec(xml)[1];
    assert.match(pathData, /^[MLz0-9., ]+$/, 'only M, L and z');
  }
});

test('the launcher foreground stays inside the adaptive icon safe zone', () => {
  const xml = androidLauncherForeground();
  const numbers = /android:pathData="([^"]+)"/.exec(xml)[1].match(/[\d.]+/g).map(Number);
  for (const n of numbers) assert.ok(n >= 21 && n <= 87, String(n));
  assert.match(androidLauncherBackground(), /#FF0A0A0A/);
});
