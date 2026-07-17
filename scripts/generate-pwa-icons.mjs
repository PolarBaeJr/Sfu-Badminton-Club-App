// Generates the player-app PWA icons (icon-192.png, icon-512.png,
// apple-touch-icon.png) with no image dependencies — shapes are rasterized
// directly and encoded as PNG via zlib.
//
// Artwork: stylized shuttlecock on the manifest background color, accent from
// the manifest theme color. Everything sits inside the central 80% circle so
// the 512 icon is safe to declare `purpose: "any maskable"`.
//
// Usage: node scripts/generate-pwa-icons.mjs

import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const OUT_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'player', 'public');

// manifest.json colors
const BG = [22, 33, 62]; // #16213E background_color
const CORK = [233, 69, 96]; // #E94560 theme_color
const FEATHER = [248, 250, 252]; // near-white

// --- Vector artwork in normalized [0,1] coords, y down ---
const CORK_C = { x: 0.5, y: 0.7, r: 0.105 };
const SKIRT = { topY: 0.25, bottomY: 0.6, topHW: 0.21, bottomHW: 0.075 };
const BAND = { topY: 0.585, bottomY: 0.62, hw: 0.085 };
const GAP_W = 0.011;
const GAPS = [
  { x1: 0.5, y1: 0.62, x2: 0.43, y2: 0.24 },
  { x1: 0.5, y1: 0.62, x2: 0.57, y2: 0.24 },
];

function distToSegment(px, py, { x1, y1, x2, y2 }) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  const cx = x1 + t * dx;
  const cy = y1 + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function sampleColor(u, v) {
  // Cork (drawn on top of the band)
  if (Math.hypot(u - CORK_C.x, v - CORK_C.y) <= CORK_C.r) return CORK;

  // Band between cork and skirt
  if (v >= BAND.topY && v <= BAND.bottomY && Math.abs(u - 0.5) <= BAND.hw) return FEATHER;

  // Skirt trapezoid (wider at the top), minus feather-divider gaps
  if (v >= SKIRT.topY && v <= SKIRT.bottomY) {
    const t = (SKIRT.bottomY - v) / (SKIRT.bottomY - SKIRT.topY);
    const hw = SKIRT.bottomHW + t * (SKIRT.topHW - SKIRT.bottomHW);
    if (Math.abs(u - 0.5) <= hw) {
      for (const gap of GAPS) {
        if (distToSegment(u, v, gap) < GAP_W) return BG;
      }
      return FEATHER;
    }
  }

  return BG;
}

function render(size) {
  const pixels = Buffer.alloc(size * size * 3);
  const SS = 3; // 3x3 supersampling for antialiasing
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const u = (x + (sx + 0.5) / SS) / size;
          const v = (y + (sy + 0.5) / SS) / size;
          const c = sampleColor(u, v);
          r += c[0];
          g += c[1];
          b += c[2];
        }
      }
      const i = (y * size + x) * 3;
      pixels[i] = Math.round(r / (SS * SS));
      pixels[i + 1] = Math.round(g / (SS * SS));
      pixels[i + 2] = Math.round(b / (SS * SS));
    }
  }
  return pixels;
}

// --- Minimal PNG encoder (8-bit RGB, no interlace) ---
const CRC_TABLE = new Int32Array(256).map((_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c;
});

function crc32(buf) {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

function encodePng(size, pixels) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: truecolor RGB

  // Each scanline is prefixed with filter byte 0 (None)
  const raw = Buffer.alloc(size * (size * 3 + 1));
  for (let y = 0; y < size; y++) {
    pixels.copy(raw, y * (size * 3 + 1) + 1, y * size * 3, (y + 1) * size * 3);
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

for (const [name, size] of [
  ['icon-192.png', 192],
  ['icon-512.png', 512],
  ['apple-touch-icon.png', 180],
]) {
  const file = join(OUT_DIR, name);
  writeFileSync(file, encodePng(size, render(size)));
  console.log(`wrote ${file} (${size}x${size})`);
}
