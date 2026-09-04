import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { ImageResponse } from 'next/og';
import { Card, FONTS, W, cardHeight } from '../discord-card';
import type { DiscordProfile } from '../discord-profile';

/**
 * THE CARD IS ACTUALLY RENDERED HERE, and that is the entire point.
 *
 * satori does not report overflow. A block that does not fit is drawn past the
 * bottom edge and cropped by the PNG encoder, so a layout that is 40px too tall
 * produces a valid 200 image with its last line missing and nothing anywhere
 * says so -- not a type error, not a console warning, not a failing assertion.
 * Every other test in this suite reads the card's SOURCE; none of them would
 * survive contact with a real render.
 *
 * WHAT IS AND IS NOT CHECKED HERE, because the difference matters:
 *
 *   CHECKED -- nothing is cropped. The bottom rows of a correct card are clean
 *   background; a layout that overflows has glyphs running off the edge, which
 *   shows up as ink in those rows. bottomEdgeInk below measures exactly that,
 *   and `detects a layout that overflows` proves the measurement can fail by
 *   deliberately rendering a card too short.
 *
 *   NOT CHECKED -- dead space. An over-tall height constant leaves a band of
 *   empty black above the rail (420/580 did, by ~85px). The rail is pinned with
 *   `marginTop: auto`, so it sits at the bottom either way and the bottom rows
 *   look identical. Detecting the gap means knowing which vertical holes in the
 *   card are intentional -- an empty RECENT panel is legitimately blank for
 *   ~90px -- and any threshold that separates those is really a restatement of
 *   the current design that would fire on the next restyle. So this is left to
 *   eyes: set CARD_RENDER_OUT and look.
 *
 * Do not read `expect(pngSize(buf)).toEqual({width, height})` as evidence about
 * the layout. ImageResponse always emits a PNG at the size it was handed, so
 * that assertion is about the encoder, not the card, and it cannot fail for a
 * layout reason. It stays only to pin the contract that cardHeight is what the
 * route passes through.
 *
 * createElement RATHER THAN JSX, and the file is .ts for the same reason: the
 * repo's tsconfig sets `jsx: preserve` for Next, so vitest's transform leaves
 * JSX in place and a .tsx test fails to parse before it runs. Nothing about the
 * card requires JSX to construct.
 */

const base: DiscordProfile = {
  id: '00000000-0000-0000-0000-000000000001',
  name: 'Matthew Cheng',
  handle: 'matthewc',
  avatarUrl: null,
  bio: null,
  status: null,
  ranked: true,
  doubles: { elo: 1842, provisional: false, wins: 24, losses: 9, streak: 4, rank: 3 },
  singles: { elo: 1596, provisional: true, wins: 8, losses: 6, streak: -1, rank: 11 },
  tournamentPoints: 340,
  background: { kind: 'default' },
  awards: [],
  recent: [
    { won: true, type: 'doubles', score: '21-15, 21-18', opponents: ['Kiera Chan'] },
    { won: false, type: 'singles', score: '19-21, 21-17, 15-21', opponents: ['Daniel Park'] },
    { won: true, type: 'doubles', score: '21-12, 21-9', opponents: ['Priya Raman', 'Sam Lee'] },
  ],
  rival: { name: 'Kiera Chan', wins: 5, losses: 2 },
  nights: 27,
};

/** The PNG header carries the drawn size. See the note above on what it proves. */
function pngSize(buf: Buffer): { width: number; height: number } {
  expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/** Width of the deliberate red bar down the left edge. */
const EDGE_ACCENT_PX = 16;

/** Clean background measures ~1; a drawn glyph measures 80+. */
const CLEAN = 25;

/**
 * How much ink sits in the bottom rows, as brightness above that row's own
 * background.
 *
 * MEASURED AGAINST THE ROW MEDIAN rather than an absolute threshold, because
 * the card's background is a gradient and a fixed cutoff would mean something
 * different at the top of the card than the bottom. The row is 1000px of mostly
 * background, so its median IS the background, whatever the gradient is doing
 * there.
 *
 * The leftmost pixels are skipped: a red accent bar runs the full height of the
 * card by design, and it is not evidence of a cropped glyph.
 *
 * On a correct card this is ~1. Anything actually drawn is 80+. The gap is two
 * orders of magnitude, so the cutoff is not a tuned number.
 */
function bottomEdgeInk(buf: Buffer, rows = 6): number {
  const png = PNG.sync.read(buf);
  // `?? 0` throughout: the repo compiles with noUncheckedIndexedAccess, so every
  // index into the pixel buffer types as `number | undefined`. Reads are all in
  // range by construction; the fallback is to satisfy the compiler, not a case
  // that happens.
  const luma = (x: number, y: number) => {
    const i = (png.width * y + x) << 2;
    const r = png.data[i] ?? 0;
    const g = png.data[i + 1] ?? 0;
    const b = png.data[i + 2] ?? 0;
    return 0.299 * r + 0.587 * g + 0.114 * b;
  };

  let worst = 0;
  for (let y = Math.max(0, png.height - rows); y < png.height; y++) {
    const values: number[] = [];
    for (let x = EDGE_ACCENT_PX; x < png.width; x++) values.push(luma(x, y));
    const sorted = [...values].sort((a, b) => a - b);
    const median = sorted[sorted.length >> 1] ?? 0;
    worst = Math.max(worst, Math.max(...values) - median);
  }
  return worst;
}

async function renderAt(profile: DiscordProfile, height: number, name?: string) {
  const response = new ImageResponse(createElement(Card, { profile, avatar: null }), {
    width: W,
    height,
    fonts: FONTS,
  });
  const buf = Buffer.from(await response.arrayBuffer());

  const out = process.env.CARD_RENDER_OUT;
  if (out && name) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, `${name}.png`), buf);
  }
  return buf;
}

/** Render at the height the card asks for, which is what the route does. */
async function render(profile: DiscordProfile, name: string) {
  const height = cardHeight(profile);
  return { buf: await renderAt(profile, height, name), height };
}

describe('the card fits the box it declares', () => {
  it('draws a ranked member with nothing running off the bottom', async () => {
    const { buf, height } = await render(base, 'ranked');
    expect(pngSize(buf)).toEqual({ width: W, height });
    expect(bottomEdgeInk(buf)).toBeLessThan(CLEAN);
    // A card that failed to lay out still encodes, but it encodes almost
    // nothing. Anything this size has real content on it.
    expect(buf.byteLength).toBeGreaterThan(10_000);
  }, 30_000);

  it('draws an unranked member short, and without the form blocks', async () => {
    const unranked: DiscordProfile = {
      ...base,
      ranked: false,
      doubles: null,
      singles: null,
      tournamentPoints: null,
      recent: [],
      rival: null,
      nights: null,
    };
    const { buf, height } = await render(unranked, 'unranked');
    expect(height).toBeLessThan(cardHeight(base));
    expect(pngSize(buf)).toEqual({ width: W, height });
    expect(bottomEdgeInk(buf)).toBeLessThan(CLEAN);
  }, 30_000);

  it('draws a ranked member who has played nothing yet', async () => {
    // Every form block empty while the ladder still lists them. The two "no
    // data" strings are the longest things in their panels, so this is the
    // case that overflows if either panel is tightened.
    const fresh: DiscordProfile = { ...base, recent: [], rival: null, nights: 0 };
    const { buf } = await render(fresh, 'ranked-empty');
    expect(bottomEdgeInk(buf)).toBeLessThan(CLEAN);
  }, 30_000);

  it('survives the longest strings the layout admits', async () => {
    // Every field at its worst at once: a name past both step-downs, a rival
    // whose name abbreviates, a doubles row with two long opponents, and a
    // four-figure rank. This is the case that overflows if a panel grows.
    const long: DiscordProfile = {
      ...base,
      name: 'Bartholomew Fitzgerald-Kensington',
      handle: 'bartholomew_fitzgerald',
      status: 'suspended',
      doubles: { elo: 2401, provisional: true, wins: 148, losses: 132, streak: -12, rank: 1287 },
      recent: [
        {
          won: false,
          type: 'doubles',
          score: '19-21, 21-19, 22-24',
          opponents: ['Aleksandra Kowalczyk', 'Constantine Papadopoulos'],
        },
        { won: true, type: 'singles', score: '21-19, 24-22', opponents: ['Wolfgang Schmidt-Bauer'] },
        { won: true, type: 'doubles', score: null, opponents: [] },
      ],
      rival: { name: 'Aleksandra Kowalczyk', wins: 3, losses: 11 },
      nights: 214,
    };
    const { buf } = await render(long, 'long-strings');
    expect(bottomEdgeInk(buf)).toBeLessThan(CLEAN);
  }, 30_000);

  it('detects a layout that overflows the height it was given', async () => {
    // THE TEST FOR THE TEST. Every assertion above is a card passing a check;
    // none of them shows the check can fail. Squeeze the same card into 80px
    // less than it needs and the recent/rival row runs off the bottom, which is
    // precisely the silent failure this file exists to catch. If this ever goes
    // green, bottomEdgeInk has stopped measuring anything and the passes above
    // are worthless.
    const buf = await renderAt(base, cardHeight(base) - 80);
    expect(bottomEdgeInk(buf)).toBeGreaterThan(CLEAN);
  }, 30_000);
});
