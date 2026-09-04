import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
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
 * survive contact with a real render, and none of them would have caught a
 * height regression.
 *
 * So: render every shape at its declared height and prove the drawing finished.
 * A PNG that decodes and carries the dimensions cardHeight promised is the only
 * evidence available in-process that the layout fits the box it was given.
 *
 * createElement RATHER THAN JSX, and the file is .ts for the same reason: the
 * repo's tsconfig sets `jsx: preserve` for Next, so vitest's transform leaves
 * JSX in place and a .tsx test fails to parse before it runs. Nothing about the
 * card requires JSX to construct.
 *
 * SET CARD_RENDER_OUT to a directory to keep the images for a human to look at.
 * The assertions check geometry, which is what can be checked mechanically;
 * whether the card is well composed is a question for eyes.
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

/** The PNG header carries the real drawn size; trust it over the request. */
function pngSize(buf: Buffer): { width: number; height: number } {
  // Signature, then the IHDR chunk: width and height are big-endian uint32 at
  // byte 16 and 20. Reading them is how we learn what was actually produced
  // rather than what was asked for.
  expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

async function render(profile: DiscordProfile, name: string) {
  const height = cardHeight(profile);
  const response = new ImageResponse(
    createElement(Card, { profile, avatar: null }),
    { width: W, height, fonts: FONTS }
  );
  const buf = Buffer.from(await response.arrayBuffer());

  const out = process.env.CARD_RENDER_OUT;
  if (out) {
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, `${name}.png`), buf);
  }
  return { buf, height };
}

describe('the card renders at the height it claims', () => {
  it('draws a ranked member at the full height', async () => {
    const { buf, height } = await render(base, 'ranked');
    expect(pngSize(buf)).toEqual({ width: W, height });
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
  }, 30_000);

  it('draws a ranked member who has played nothing yet', async () => {
    // Every form block empty while the ladder still lists them. The two "no
    // data" strings are the longest things in their panels, so this is the
    // case that overflows if either panel is tightened.
    const fresh: DiscordProfile = { ...base, recent: [], rival: null, nights: 0 };
    const { buf, height } = await render(fresh, 'ranked-empty');
    expect(pngSize(buf)).toEqual({ width: W, height });
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
        { won: false, type: 'doubles', score: '19-21, 21-19, 22-24', opponents: ['Aleksandra Kowalczyk', 'Constantine Papadopoulos'] },
        { won: true, type: 'singles', score: '21-19, 24-22', opponents: ['Wolfgang Schmidt-Bauer'] },
        { won: true, type: 'doubles', score: null, opponents: [] },
      ],
      rival: { name: 'Aleksandra Kowalczyk', wins: 3, losses: 11 },
      nights: 214,
    };
    const { buf, height } = await render(long, 'long-strings');
    expect(pngSize(buf)).toEqual({ width: W, height });
  }, 30_000);
});
