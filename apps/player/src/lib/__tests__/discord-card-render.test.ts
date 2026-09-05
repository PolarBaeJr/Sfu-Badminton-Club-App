import { describe, it, expect } from 'vitest';
import { createElement } from 'react';
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { ImageResponse } from 'next/og';
import { Card, FONTS, W, cardHeight, cardBio, BIO_MAX, H_BIO } from '../discord-card';
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
  // compRank null: the base fixture is a member who is NOT competitive, so
  // every case built off it draws the tiles the way most of the club sees them.
  // The competitive shape is its own case below.
  doubles: { elo: 1842, provisional: false, wins: 24, losses: 9, streak: 4, rank: 3, compRank: null },
  singles: { elo: 1596, provisional: true, wins: 8, losses: 6, streak: -1, rank: 11, compRank: null },
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

/**
 * How many 24px lines the bio text actually occupies at the card's own font,
 * size and usable width.
 *
 * Drawn on its own rather than read off the card, because on the card the
 * third line is already clipped away and there is nothing left to count. The
 * width is the card's 1000 less its 50px left and 40px right padding.
 */
async function bioLines(text: string): Promise<number> {
  return linesAt(text, { width: W - 90, size: 17, band: 24 });
}

/**
 * How many bands of a given height the text inks when drawn at a given width
 * and font -- the same measurement bioLines makes, for any box on the card.
 *
 * EVERY FIXED-HEIGHT BOX ON THIS CARD NEEDS THIS, not just the bio. A tile
 * sub-line that grows past its panel's width wraps to a second line, and
 * StatPanel is a fixed 132px holding exactly two of them, so the wrap pushes
 * the last line out of the box and satori clips it away without a word. The
 * bottom-edge crop check cannot see it. Neither can the type system. Counting
 * inked bands is the only thing that can.
 */
async function linesAt(
  text: string,
  opts: { width: number; size: number; band: number; weight?: number; letterSpacing?: number },
): Promise<number> {
  const BAND = opts.band;
  const el = createElement(
    'div',
    { style: { display: 'flex', width: W, height: 240, background: '#000' } },
    createElement(
      'div',
      {
        style: {
          display: 'flex',
          width: opts.width,
          fontFamily: 'Barlow',
          fontWeight: opts.weight ?? 400,
          fontSize: opts.size,
          ...(opts.letterSpacing === undefined ? {} : { letterSpacing: opts.letterSpacing }),
          lineHeight: `${BAND}px`,
          color: '#ffffff',
        },
      },
      text,
    ),
  );
  const buf = Buffer.from(
    await new ImageResponse(el, { width: W, height: 240, fonts: FONTS }).arrayBuffer(),
  );
  const png = PNG.sync.read(buf);
  let lines = 0;
  for (let band = 0; band * BAND < png.height; band++) {
    let inked = false;
    for (let y = band * BAND; y < (band + 1) * BAND && !inked; y++) {
      for (let x = 0; x < png.width; x++) {
        // White text on black: any bright pixel is a glyph. No median needed —
        // this probe draws its own flat background rather than the card's
        // gradient.
        if ((png.data[(png.width * y + x) << 2] ?? 0) > 60) { inked = true; break; }
      }
    }
    if (inked) lines++;
  }
  return lines;
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
      doubles: { elo: 2401, provisional: true, wins: 148, losses: 132, streak: -12, rank: 1287, compRank: 964 },
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

  it('draws a bio without pushing anything off the bottom', async () => {
    // BOTH SHAPES, because they are different cards to look at and only one of
    // them is the common case. A 48-char bio takes one of the block's two lines
    // and leaves the other empty; the second case fills both. The 24px band
    // between them is dead space on most real cards, and per the note at the
    // top of this file dead space is the failure no assertion here can see --
    // so both are written out for eyes under CARD_RENDER_OUT.
    for (const [name, bio] of [
      ['bio', 'Left-handed, plays doubles. Around most Tuesdays.'],
      [
        'bio-two-line',
        'Left-handed, plays doubles. Around most Tuesdays and the odd Friday, ' +
          'usually on the far courts. Always up for a game with anyone.',
      ],
    ] as const) {
      const withBio: DiscordProfile = { ...base, bio };
      const { buf, height } = await render(withBio, name);
      // The block is ADDED to the height, not absorbed into it -- a card that
      // drew the bio at the old height would crop the rail off instead.
      expect(height, name).toBe(cardHeight(base) + H_BIO);
      expect(pngSize(buf), name).toEqual({ width: W, height });
      expect(bottomEdgeInk(buf), name).toBeLessThan(CLEAN);
      expect(await bioLines(bio), name).toBeLessThanOrEqual(2);
    }
  }, 60_000);

  it('fits the competitive tiles and the badge label in the boxes they get', async () => {
    // THE ASSERTION THAT HOLDS THE COMP RANK, and like the bio one it is a wrap
    // count rather than a crop check -- StatPanel and RankBadge are both fixed
    // boxes, so an overlong line is clipped in silence, not drawn off the card.
    //
    // PANEL_TEXT is the panel's usable width, derived not guessed: the card is
    // 1000 wide with 50 left and 40 right padding, so the grid gets 910; four
    // panels with three 12px gaps make each (910 - 36) / 4 = 218.5; each has
    // 16px of padding a side. BADGE_TEXT is RankBadge's own width, which has no
    // padding at all -- the label is centred in the full 132.
    const PANEL_TEXT = (W - 90 - 3 * 12) / 4 - 32;
    const BADGE_TEXT = 132;

    // The worst line each shape can produce, not a typical one: a four-figure
    // open rank beside a three-figure comp rank, and a record in the hundreds.
    const worst: DiscordProfile = {
      ...base,
      doubles: { elo: 2401, provisional: true, wins: 148, losses: 132, streak: -12, rank: 1287, compRank: 964 },
      singles: { elo: 1596, provisional: true, wins: 108, losses: 96, streak: -11, rank: 1102, compRank: 873 },
    };
    for (const [label, text] of [
      ['rank sub', `#${worst.doubles!.rank} open · #${worst.doubles!.compRank} comp`],
      ['form sub', `${worst.doubles!.wins}W ${worst.doubles!.losses}L · 53% · L12`],
    ] as const) {
      expect(await linesAt(text, { width: PANEL_TEXT, size: 16, band: 22 }), label).toBe(1);
    }

    // Both badge labels, at RankBadge's own font. 'OPEN DOUBLES' is the longer.
    for (const label of ['OPEN DOUBLES', 'OPEN SINGLES'] as const) {
      expect(
        await linesAt(label, { width: BADGE_TEXT, size: 13, band: 18, weight: 600, letterSpacing: 1.6 }),
        label,
      ).toBe(1);
    }

    // And the whole card still draws clean at that worst case.
    const { buf } = await render(worst, 'comp-worst');
    expect(bottomEdgeInk(buf)).toBeLessThan(CLEAN);
  }, 60_000);

  it('detects a tile sub-line too long for its panel', async () => {
    // THE TEST FOR THE TEST above. Half again as much text as the worst real
    // line takes a second band, and linesAt says so. If this goes green the
    // width measurement has stopped measuring and the check above is worthless.
    const PANEL_TEXT = (W - 90 - 3 * 12) / 4 - 32;
    expect(await linesAt('#1287 open · #964 comp · 148W 132L', { width: PANEL_TEXT, size: 16, band: 22 }))
      .toBeGreaterThan(1);
  }, 30_000);

  it('leaves a non-competitive member\'s tiles exactly as they were', async () => {
    // Most of the club is not competitive, and their card must not change. The
    // old shape put the record on the rank line; the comp shape moves it down.
    const casual = { ...base.doubles!, compRank: null };
    const comp = { ...base.doubles!, compRank: 1 };
    const { buf } = await render({ ...base, doubles: casual }, 'comp-none');
    expect(bottomEdgeInk(buf)).toBeLessThan(CLEAN);
    // Asserted through the card's own helpers via a render is not possible --
    // these are private. The shapes are pinned in discord-card.test.ts instead;
    // this case exists so the unchanged layout is actually DRAWN somewhere.
    expect(casual.compRank).toBeNull();
    expect(comp.compRank).toBe(1);
  }, 30_000);

  it('draws a bio on an unranked card too', async () => {
    // H + H_BIO is arithmetic no other case reaches: the unranked fixture
    // inherits base's null bio, and every bio case above is ranked. It is also
    // the case least likely to be caught if it were wrong -- the rail is pinned
    // with `marginTop: auto`, so a mis-sized short card shows as dead space
    // above it rather than as ink on the bottom edge.
    const unrankedWithBio: DiscordProfile = {
      ...base,
      ranked: false,
      doubles: null,
      singles: null,
      tournamentPoints: null,
      recent: [],
      rival: null,
      nights: null,
      bio: 'Just started. Looking for people to hit with on Thursdays.',
    };
    const { buf, height } = await render(unrankedWithBio, 'unranked-bio');
    expect(height).toBe(cardHeight({ ...unrankedWithBio, bio: null }) + H_BIO);
    expect(pngSize(buf)).toEqual({ width: W, height });
    expect(bottomEdgeInk(buf)).toBeLessThan(CLEAN);
  }, 30_000);

  it('fits a bio at the truncation limit into the two lines it is given', async () => {
    // THE ASSERTION THAT ACTUALLY HOLDS THE BIO BLOCK, and the reason it is not
    // another bottomEdgeInk check: the bio div is a fixed 48px and satori CLIPS
    // a flex box rather than overflowing it, so a bio of any length leaves the
    // bottom edge clean. Measured -- 599 characters reads 1.0, the same as 149.
    // The crop check has no teeth here at all.
    //
    // What a too-long bio does instead is lose its third line in silence, so
    // what has to be checked is the WRAP: how many 24px bands the text puts ink
    // in. Raising BIO_MAX past what the width holds fails this and nothing else.
    //
    // Both wrap extremes, because they fail in opposite directions: short words
    // wrap as late as possible and pack the most characters onto a line, long
    // unbroken ones break early and use the most lines.
    for (const [label, source] of [
      ['short words', 'word '.repeat(80)],
      ['long words', 'Wolfgang Schmidt-Bauer plays '.repeat(20)],
    ] as const) {
      const longest = cardBio(source);
      expect(longest).not.toBeNull();
      expect(longest!.length, label).toBe(BIO_MAX);
      expect(await bioLines(longest!), label).toBeLessThanOrEqual(2);
    }
  }, 60_000);

  it('detects a bio that needs more lines than the block has', async () => {
    // THE TEST FOR THE TEST above. Half again as much text as cardBio would
    // ever pass through takes a third line, and bioLines says so. If this ever
    // goes green the wrap measurement has stopped measuring and the check above
    // is worthless.
    expect(await bioLines('word '.repeat(45).trim())).toBeGreaterThan(2);
  }, 30_000);

  it('gives a member with no bio no extra height at all', async () => {
    // The failure this rules out is 66px of empty black under every card
    // belonging to somebody who never wrote a bio.
    expect(cardHeight({ ...base, bio: null })).toBe(cardHeight(base));
    expect(cardHeight({ ...base, bio: '   ' })).toBe(cardHeight(base));
  });

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
