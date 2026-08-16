// ============================================================
// THE DRAW, LAID OUT ONCE (the converging / "wall chart" bracket)
// ============================================================
//
// "for the tournament render it should come from the 2 sides and meet up in the
// middle" — the classic tennis/badminton wall chart. The top half of the draw
// runs left to right, the bottom half runs right to left, and the two meet at
// the final in the centre column.
//
// WHY THIS IS THE FIX, stated honestly, because the obvious claim about it is
// wrong: converging does NOT make a draw narrower. A linear draw of R rounds is
// R columns; a converging one is 2R-1. For a 32-entry draw that is 5 columns
// becoming 9. What converging halves is the HEIGHT — each side carries half the
// first round, so a 32-draw stacks 8 matches per side instead of 16, and a
// 64-draw 16 instead of 32.
//
// That is the whole point. A linear draw is a portrait chart (tall and narrow)
// and every screen it is read on is landscape, so the scale at which the whole
// thing fits is set by the height and is far below the scale at which the width
// would fit — which is why the console's existing "fit width" control leaves a
// 32-draw needing 1700px of vertical scrolling, and why the reader calls it
// unreadable. Converging turns the chart landscape, so fitting it is bounded by
// the width instead, and the usable zoom roughly doubles. The renderers must
// fit BOTH axes for any of this to pay off; fitting width alone makes a
// converging draw worse than a linear one, not better.
//
// WHY THIS FILE IS PURE AND SHARED. The player app and the console both draw
// this diagram, and until now each carried its own copy of the geometry — two
// sets of card heights, gaps, pitches and elbow offsets that had already
// drifted (92px vs 100px cards, 12px vs 16px gaps). They cannot share a
// RENDERER: one is a read-only server component in the player app's design
// tokens (--ink-2 / --line / --surface / .card-elevated) and the other is an
// interactive client component in the console's (--bg-card / --border /
// --text-muted), and the two token sets are disjoint. So the seam is here: the
// arithmetic that decides where every card and every line goes is written once,
// parameterised by the sizes each app wants, and each app owns only its markup.
//
// Nothing in here touches React, the DOM or the database.

// ============================================================
// Inputs
// ============================================================

/** The only three columns of `tournament_matches` the layout needs. */
export interface DrawInputMatch {
  id: string;
  round_number: number;
  bracket_position: number;
}

/**
 * The sizes an app draws at. Every offset the engine returns is derived from
 * these, so a card that grows is one edit and the elbows follow it.
 */
export interface DrawGeometry {
  /** Fixed outer height of one match card. Every card in a column must match. */
  cardH: number;
  /** Gap between sibling cards in the first round. */
  cardGap: number;
  /** Width of one round column. */
  colW: number;
  /** Width of the connector gutter between two columns. */
  linkW: number;
  /** Height of the round-heading strip above the body. */
  headH: number;
  /**
   * Room reserved under each CENTRE-COLUMN card that is not part of the tree —
   * the third-place playoff, and the final when only a half of the draw is
   * being laid out — for its heading and the sentence that explains it. Only
   * consulted when such a card is asked for.
   */
  playoffCaptionH?: number;
}

export interface DrawLayoutOptions {
  /**
   * True when the event has a third-place playoff. It is not part of the tree —
   * it feeds nothing — so it is not passed in `matches`; the engine only
   * reserves a slot for it and returns where that slot is.
   */
  thirdPlace?: boolean;
  /**
   * How many further cards to reserve in the centre column, ABOVE the
   * third-place slot and below the root.
   *
   * This exists for the player app's paged full screen, where a draw too large
   * for a projector is shown one HALF at a time. A half is the subtree under
   * one semi-final, fed back through this same function, so its root is that
   * semi-final and THE FINAL IS NOT IN IT — the final's other feeder is on the
   * other page. The final is repeated on both pages instead, and this is the
   * room it goes in: the same clear centre column, and for the same reason,
   * that the third-place playoff already uses.
   */
  centreSlots?: number;
}

// ============================================================
// Outputs
// ============================================================

/**
 * Which half of the draw a match belongs to. 'centre' is the final (and the
 * third-place slot beneath it), which belongs to neither half.
 *
 * Renderers use this for one thing beyond placement: a card on the right half
 * is mirrored — seed and score swap to the outside, the name aligns right — so
 * the two halves read as pointing inwards at the final rather than as one long
 * chart that happens to have a gap in it.
 */
export type DrawSide = 'left' | 'right' | 'centre';

export interface DrawNode<M extends DrawInputMatch> {
  match: M;
  id: string;
  roundNumber: number;
  /** 0 for the first round, `rounds - 1` for the final. */
  depth: number;
  side: DrawSide;
  /** Left edge, in diagram pixels, relative to the diagram's own origin. */
  x: number;
  /** Top edge, relative to the TOP OF THE BODY — i.e. below the heading strip. */
  y: number;
}

/**
 * One round heading. A converging draw shows most rounds TWICE — "Round of 32"
 * sits over the left column and over the right one — so this is keyed by side
 * as well as by depth, and the two share a `roundNumber`.
 */
export interface DrawColumn {
  key: string;
  depth: number;
  roundNumber: number;
  side: DrawSide;
  x: number;
}

/**
 * One straight line of the connector work, as an absolutely positioned box.
 * Horizontal segments have `h === 1`, vertical ones `w === 1`; a renderer paints
 * them with a background colour and needs no geometry of its own.
 *
 * `dashed` is the third-place playoff's link, which means "these two play in it"
 * rather than the solid lines' "the winner advances to here".
 */
export interface DrawConnector {
  key: string;
  x: number;
  y: number;
  w: number;
  h: number;
  dashed?: boolean;
}

export interface DrawLayout<M extends DrawInputMatch> {
  /**
   * 'converging' is the wall chart. 'linear' is the old left-to-right column
   * stack, and it is the fallback for draw data whose rounds do not halve —
   * see `computeDrawLayout`. Both modes return the same shapes, so a renderer
   * has one code path.
   */
  mode: 'converging' | 'linear';
  nodes: Array<DrawNode<M>>;
  columns: DrawColumn[];
  connectors: DrawConnector[];
  /** Where the third-place card goes, when one was asked for. */
  thirdPlace: { x: number; y: number } | null;
  /**
   * Where `options.centreSlots` asked for room, top to bottom, above the
   * third-place slot. Empty unless it was asked for.
   */
  centreSlots: Array<{ x: number; y: number }>;
  /** Total diagram width. */
  width: number;
  /** Total diagram height, heading strip included. */
  height: number;
  /** Height of the heading strip; the body starts here. */
  headH: number;
  /** Height of the body, third-place block included. */
  bodyH: number;
  /** Number of rounds in the tree. */
  rounds: number;
}

// ============================================================
// The engine
// ============================================================

/**
 * Lay a knockout draw out as a converging wall chart.
 *
 * `matches` must be the MAIN TREE only: the third-place playoff shares its
 * round_number with the final (00080) and would otherwise read as a round of
 * two, which is exactly the shape of "these two feed the next one" and exactly
 * the wrong claim. Callers filter it out and set `options.thirdPlace`.
 *
 * WHAT MAKES A DRAW CONVERGE. Three conditions, all checked rather than
 * assumed, because a diagram drawn from a wrong assumption points its lines at
 * the wrong cards and says something false about who plays whom:
 *
 *   1. the last round has exactly one match (there is a final to meet at),
 *   2. the round before it has exactly two (there is a half on each side), and
 *   3. every round is the ceiling of half the one below it, so child `i`
 *      feeding parent `floor(i/2)` is the real advancement wiring.
 *
 * Condition 3 is the generator's own shape: `generateBracket` builds
 * `bracketSize = nextPowerOf2(N)` slots and wires `winner_to_match_id` to
 * `Math.floor(pos / 2)` of the next round, so the tree is ALWAYS perfect and a
 * non-power-of-two entry count shows up only as first-round rows carrying
 * `is_bye` with one empty slot — which is a card like any other here. The
 * ceiling is the allowance for draw data that is not generator-shaped (a
 * hand-edited event, an older one); anything the ceiling cannot explain falls
 * back to 'linear', which needs no assumption about who feeds whom and simply
 * stacks the rounds it was given.
 */
export function computeDrawLayout<M extends DrawInputMatch>(
  matches: M[],
  geometry: DrawGeometry,
  options: DrawLayoutOptions = {},
): DrawLayout<M> {
  const pitch = geometry.cardH + geometry.cardGap;

  // Rounds, in play order, each sorted by bracket_position. `depth` is the
  // INDEX in this list rather than `round_number - 1`: the knockout half of a
  // pool_to_bracket event numbers its rounds from 1 like any other, but nothing
  // here needs to depend on that being true.
  const byRound = new Map<number, M[]>();
  for (const m of matches) {
    const list = byRound.get(m.round_number);
    if (list) list.push(m);
    else byRound.set(m.round_number, [m]);
  }
  const roundNumbers = Array.from(byRound.keys()).sort((a, b) => a - b);
  const levels = roundNumbers.map((rn) =>
    byRound.get(rn)!.slice().sort((a, b) => a.bracket_position - b.bracket_position),
  );
  const rounds = levels.length;

  if (rounds === 0) {
    return {
      mode: 'converging',
      nodes: [],
      columns: [],
      connectors: [],
      thirdPlace: null,
      centreSlots: [],
      width: 0,
      height: 0,
      headH: geometry.headH,
      bodyH: 0,
      rounds: 0,
    };
  }

  const halves = levels.every((level, d) =>
    d === 0 || level.length === Math.ceil(levels[d - 1]!.length / 2),
  );
  // A one-round draw (two entrants, final only) converges trivially: the single
  // card IS the centre column. Two rounds or more need a real half on each side.
  const converges =
    halves
    && levels[rounds - 1]!.length === 1
    && (rounds === 1 || levels[rounds - 2]!.length === 2);

  return converges
    ? layoutConverging(levels, roundNumbers, geometry, pitch, options)
    : layoutLinear(levels, roundNumbers, geometry, pitch, options, halves);
}

/** Children of parent `i` at the depth below: indices 2i and 2i+1, where they exist. */
function childIndices(parentIdx: number, childCount: number): number[] {
  const out: number[] = [];
  if (parentIdx * 2 < childCount) out.push(parentIdx * 2);
  if (parentIdx * 2 + 1 < childCount) out.push(parentIdx * 2 + 1);
  return out;
}

/**
 * Vertical placement, shared by both modes.
 *
 * First-round cards are stacked at one `pitch` each, and every later card sits
 * at the MEAN of the cards that feed it — the tidy-tree rule. It is used in
 * preference to the closed form `((2^d - 1) * pitch) / 2 + i * 2^d * pitch`
 * that both apps used before because the closed form is only correct on a
 * perfect tree: it is what put a card at half a pitch's offset from the pair it
 * was drawn as joining whenever a round was not exactly twice the next.
 *
 * `slotOf` maps a first-round index to its stacking slot, which is what lets
 * the two halves of a converging draw each start their own stack at zero.
 */
function computeRowY<M extends DrawInputMatch>(
  levels: M[][],
  pitch: number,
  slotOf: (idx: number) => number,
): number[][] {
  const y: number[][] = levels.map((level) => new Array<number>(level.length).fill(0));
  for (let i = 0; i < levels[0]!.length; i++) y[0]![i] = slotOf(i) * pitch;
  for (let d = 1; d < levels.length; d++) {
    for (let i = 0; i < levels[d]!.length; i++) {
      const kids = childIndices(i, levels[d - 1]!.length);
      // A card with no feeder at all cannot happen in generator-shaped data;
      // it is given the closed-form position rather than 0 so that malformed
      // data still produces a diagram somebody can read.
      y[d]![i] = kids.length
        ? kids.reduce((sum, k) => sum + y[d - 1]![k]!, 0) / kids.length
        : ((Math.pow(2, d) - 1) * pitch) / 2 + i * Math.pow(2, d) * pitch;
    }
  }
  return y;
}

/**
 * One child's link into its parent: a stub out of the child, a riser to the
 * parent's centre line, and the entry into the parent. Written once and handed
 * a direction, so the mirrored right-hand half cannot drift from the left.
 *
 * `dir` is +1 when the winner travels rightwards (the left half, and the left
 * half's entry into the final) and -1 when it travels leftwards (the right
 * half). Only the X axis mirrors: child `2i` is drawn ABOVE child `2i+1` on
 * both halves, because `winner_to_position` makes the even index slot 'a' and
 * a mirrored Y would put slot 'b' on top on one side of the sheet only.
 */
function linkSegments(
  key: string,
  childOuterEdge: number,
  parentInnerEdge: number,
  childCentreY: number,
  parentCentreY: number,
  dir: 1 | -1,
  linkW: number,
  dashed?: boolean,
): DrawConnector[] {
  const mid = childOuterEdge + (dir * linkW) / 2;
  const stubX = dir === 1 ? childOuterEdge : mid;
  const entryX = dir === 1 ? mid : parentInnerEdge;
  const out: DrawConnector[] = [
    { key: `${key}-stub`, x: stubX, y: childCentreY, w: linkW / 2, h: 1, dashed },
    { key: `${key}-entry`, x: entryX, y: parentCentreY, w: linkW / 2, h: 1, dashed },
  ];
  if (childCentreY !== parentCentreY) {
    out.push({
      key: `${key}-riser`,
      x: mid,
      y: Math.min(childCentreY, parentCentreY),
      w: 1,
      h: Math.abs(parentCentreY - childCentreY),
      dashed,
    });
  }
  return out;
}

/**
 * The cards that sit in the centre column BELOW the root and are not part of
 * the tree: whatever `centreSlots` asked for, and then the third-place playoff.
 * Each gets `playoffCaptionH` of room beneath it for the sentence that says
 * what it is, and the body grows to hold the stack.
 *
 * Written once and shared by both modes so the two cannot drift, and so the
 * order is fixed in one place: `centreSlots` first, because the only caller
 * that asks for one is a HALF of a draw asking for its final, and the final
 * belongs directly under the semi-final it follows on from — not under a
 * third-place playoff that neither of them feeds.
 */
function stackBelowRoot(
  anchor: { x: number; y: number },
  geometry: DrawGeometry,
  options: DrawLayoutOptions,
): {
  centreSlots: Array<{ x: number; y: number }>;
  thirdPlace: { x: number; y: number } | null;
  bottom: number;
} {
  const captionH = geometry.playoffCaptionH ?? 0;
  const centreSlots: Array<{ x: number; y: number }> = [];
  let y = anchor.y + geometry.cardH + geometry.cardGap * 2;
  for (let k = 0; k < (options.centreSlots ?? 0); k++) {
    centreSlots.push({ x: anchor.x, y });
    y += geometry.cardH + captionH;
  }
  let thirdPlace: { x: number; y: number } | null = null;
  if (options.thirdPlace) {
    thirdPlace = { x: anchor.x, y };
    y += geometry.cardH + captionH;
  }
  return { centreSlots, thirdPlace, bottom: y };
}

function layoutConverging<M extends DrawInputMatch>(
  levels: M[][],
  roundNumbers: number[],
  geometry: DrawGeometry,
  pitch: number,
  options: DrawLayoutOptions,
): DrawLayout<M> {
  const { cardH, cardGap, colW, linkW, headH } = geometry;
  const rounds = levels.length;
  const width = (2 * rounds - 1) * colW + (2 * rounds - 2) * linkW;

  // Column x. The centre is reached by either formula and they agree by
  // construction — leftX(rounds - 1) and rightX(rounds - 1) are the same number.
  const leftX = (d: number) => d * (colW + linkW);
  const rightX = (d: number) => width - colW - d * (colW + linkW);

  // SIDES ARE ASSIGNED FROM THE FINAL DOWNWARDS, not by cutting the first round
  // in half. Cutting the first round is only correct on a perfect tree, and it
  // has to agree with the advancement wiring anyway — so the wiring is what is
  // walked: the final is the centre, its two feeders are the two halves, and
  // every card below inherits the half of the card it feeds.
  const side: DrawSide[][] = levels.map((level) => new Array<DrawSide>(level.length).fill('centre'));
  if (rounds >= 2) {
    side[rounds - 2]![0] = 'left';
    side[rounds - 2]![1] = 'right';
    for (let d = rounds - 3; d >= 0; d--) {
      for (let i = 0; i < levels[d]!.length; i++) {
        side[d]![i] = side[d + 1]![Math.floor(i / 2)]!;
      }
    }
  }

  // Each half stacks its own first round from zero, which is where the height
  // saving comes from: 8 cards a side on a 32-draw rather than 16 in one column.
  const firstRound = levels[0]!;
  const slot = new Array<number>(firstRound.length).fill(0);
  let leftSlots = 0;
  let rightSlots = 0;
  for (let i = 0; i < firstRound.length; i++) {
    slot[i] = side[0]![i] === 'right' ? rightSlots++ : leftSlots++;
  }
  const y = computeRowY(levels, pitch, (i) => slot[i]!);

  const nodes: Array<DrawNode<M>> = [];
  for (let d = 0; d < rounds; d++) {
    for (let i = 0; i < levels[d]!.length; i++) {
      const s = side[d]![i]!;
      nodes.push({
        match: levels[d]![i]!,
        id: levels[d]![i]!.id,
        roundNumber: roundNumbers[d]!,
        depth: d,
        side: s,
        x: s === 'right' ? rightX(d) : leftX(d),
        y: y[d]![i]!,
      });
    }
  }

  const columns: DrawColumn[] = [];
  for (let d = 0; d < rounds; d++) {
    if (d === rounds - 1) {
      columns.push({ key: `centre-${d}`, depth: d, roundNumber: roundNumbers[d]!, side: 'centre', x: leftX(d) });
    } else {
      columns.push({ key: `left-${d}`, depth: d, roundNumber: roundNumbers[d]!, side: 'left', x: leftX(d) });
      columns.push({ key: `right-${d}`, depth: d, roundNumber: roundNumbers[d]!, side: 'right', x: rightX(d) });
    }
  }

  const connectors: DrawConnector[] = [];
  for (let d = 0; d + 1 < rounds; d++) {
    for (let p = 0; p < levels[d + 1]!.length; p++) {
      const parentSide = side[d + 1]![p]!;
      const parentY = y[d + 1]![p]! + cardH / 2;
      for (const c of childIndices(p, levels[d]!.length)) {
        const childSide = side[d]![c]!;
        // The direction is the CHILD's half, not the parent's: the final's two
        // feeders come at it from opposite sides, and that is the one place
        // where a parent's own side would give the wrong answer.
        const dir: 1 | -1 = childSide === 'right' ? -1 : 1;
        const childOuter = dir === 1 ? leftX(d) + colW : rightX(d);
        const parentInner =
          dir === 1
            ? (parentSide === 'right' ? rightX(d + 1) : leftX(d + 1))
            : (parentSide === 'right' ? rightX(d + 1) + colW : leftX(d + 1) + colW);
        connectors.push(
          ...linkSegments(
            `c${d}-${p}-${c}`,
            childOuter,
            parentInner,
            y[d]![c]! + cardH / 2,
            parentY,
            dir,
            linkW,
          ),
        );
      }
    }
  }

  let bodyH = 0;
  for (const n of nodes) bodyH = Math.max(bodyH, n.y + cardH);

  // THE THIRD-PLACE PLAYOFF LIVES IN THE CENTRE COLUMN, under the final. That
  // column holds one card, so a converging draw has a column of clear space
  // right where the reader is already looking — the only spare room on the
  // sheet, and the natural home for the other match that ends somebody's
  // tournament. It is deliberately NOT joined to the semi-finals by a line: in
  // a converging draw its two entrants are on OPPOSITE sides of the final, so
  // there is no single path back to "the semi-finals" to draw, and two elbows
  // crossing the final would say something about the final. The caption under
  // the card carries it instead.
  let thirdPlace: { x: number; y: number } | null = null;
  let centreSlots: Array<{ x: number; y: number }> = [];
  if (options.thirdPlace || options.centreSlots) {
    const finalNode = nodes.find((n) => n.depth === rounds - 1)!;
    const stacked = stackBelowRoot(finalNode, geometry, options);
    centreSlots = stacked.centreSlots;
    thirdPlace = stacked.thirdPlace;
    bodyH = Math.max(bodyH, stacked.bottom);
  }

  return {
    mode: 'converging',
    nodes,
    columns,
    connectors,
    thirdPlace,
    centreSlots,
    width,
    height: headH + bodyH,
    headH,
    bodyH,
    rounds,
  };
}

/**
 * The fallback: rounds stacked left to right, one column each, exactly the
 * shape both apps drew before. Reached only by draw data whose rounds do not
 * halve, where the converging layout would have to guess who feeds whom.
 * Connectors are omitted entirely in that case rather than guessed.
 */
function layoutLinear<M extends DrawInputMatch>(
  levels: M[][],
  roundNumbers: number[],
  geometry: DrawGeometry,
  pitch: number,
  options: DrawLayoutOptions,
  halves: boolean,
): DrawLayout<M> {
  const { cardH, cardGap, colW, linkW, headH } = geometry;
  const rounds = levels.length;
  const width = rounds * colW + Math.max(rounds - 1, 0) * linkW;
  const colX = (d: number) => d * (colW + linkW);

  const y = computeRowY(levels, pitch, (i) => i);

  const nodes: Array<DrawNode<M>> = [];
  const columns: DrawColumn[] = [];
  for (let d = 0; d < rounds; d++) {
    columns.push({ key: `left-${d}`, depth: d, roundNumber: roundNumbers[d]!, side: 'left', x: colX(d) });
    for (let i = 0; i < levels[d]!.length; i++) {
      nodes.push({
        match: levels[d]![i]!,
        id: levels[d]![i]!.id,
        roundNumber: roundNumbers[d]!,
        depth: d,
        side: 'left',
        x: colX(d),
        y: y[d]![i]!,
      });
    }
  }

  const connectors: DrawConnector[] = [];
  if (halves) {
    for (let d = 0; d + 1 < rounds; d++) {
      for (let p = 0; p < levels[d + 1]!.length; p++) {
        for (const c of childIndices(p, levels[d]!.length)) {
          connectors.push(
            ...linkSegments(
              `c${d}-${p}-${c}`,
              colX(d) + colW,
              colX(d + 1),
              y[d]![c]! + cardH / 2,
              y[d + 1]![p]! + cardH / 2,
              1,
              linkW,
            ),
          );
        }
      }
    }
  }

  let bodyH = 0;
  for (const n of nodes) bodyH = Math.max(bodyH, n.y + cardH);

  let thirdPlace: { x: number; y: number } | null = null;
  let centreSlots: Array<{ x: number; y: number }> = [];
  if ((options.thirdPlace || options.centreSlots) && rounds > 0) {
    const lastCol = colX(rounds - 1);
    const finalY = Math.max(...levels[rounds - 1]!.map((_, i) => y[rounds - 1]![i]!));
    const stacked = stackBelowRoot({ x: lastCol, y: finalY }, geometry, options);
    centreSlots = stacked.centreSlots;
    thirdPlace = stacked.thirdPlace;
    bodyH = Math.max(bodyH, stacked.bottom);
  }

  return {
    mode: 'linear',
    nodes,
    columns,
    connectors,
    thirdPlace,
    centreSlots,
    width,
    height: headH + bodyH,
    headH,
    bodyH,
    rounds,
  };
}

// ============================================================
// One half of a draw, on its own
// ============================================================

/**
 * Split a converging draw into its two halves, as the match lists each is made
 * of. Feed either list back through `computeDrawLayout` and you get that half
 * laid out as its OWN converging chart, meeting at what was the semi-final.
 *
 * WHY THIS IS WORTH HAVING, and it is not "the chart is too wide". A converging
 * draw is bounded by its HEIGHT: each side stacks half the first round, so a
 * 128 is 32 cards tall and 2384px, against 1012px of projector. Splitting it
 * into halves and converging EACH half is what buys the height back — the top
 * half of a 128 is 64 entrants meeting at a semi-final, which is the same shape
 * as a whole 64 draw and 1200px tall. Halving buys a size class, and it is the
 * only split that does: laying a half out as a plain ladder instead would keep
 * all 32 rows and gain nothing at all.
 *
 * NOTHING IS RE-DERIVED HERE. `computeDrawLayout` already assigns sides by
 * walking DOWN from the final rather than by cutting the first round in half —
 * the advancement wiring is what decides which half a card is in — so a half is
 * read straight off `node.side` and this cannot disagree with the chart it
 * came from.
 *
 * Returns null when there are no halves to take: a linear fallback layout has
 * no sides, and a one-round draw is a final with nothing under it.
 */
export function drawHalves<M extends DrawInputMatch>(
  layout: DrawLayout<M>,
): { top: M[]; bottom: M[] } | null {
  if (layout.mode !== 'converging' || layout.rounds < 2) return null;
  const top: M[] = [];
  const bottom: M[] = [];
  for (const node of layout.nodes) {
    // The final is skipped rather than assigned: it is the one card whose two
    // feeders are in DIFFERENT halves, so it belongs to neither list. A caller
    // showing one half is expected to repeat it — see `centreSlots`.
    if (node.side === 'left') top.push(node.match);
    else if (node.side === 'right') bottom.push(node.match);
  }
  return top.length && bottom.length ? { top, bottom } : null;
}

// ============================================================
// Fitting a diagram to a box
// ============================================================

/**
 * The scale at which the WHOLE diagram is on screen.
 *
 * BOTH AXES, and that is the entire reason the converging layout is worth
 * having. The console's control fitted the width only, so a 32-draw opened at
 * 92% and still needed 1700px of vertical scrolling — the number that made it
 * "unreadable above 32". Fitting both is what turns the halved height into a
 * bigger usable scale rather than into more empty screen.
 *
 * Never magnifies: a four-player draw blown up to fill a monitor looks broken,
 * and the point of the control is only to bring a big draw back into view.
 */
export function fitScale(
  layout: { width: number; height: number },
  viewportW: number,
  viewportH: number,
  min = 0.25,
): number {
  if (!layout.width || !layout.height || viewportW <= 0 || viewportH <= 0) return 1;
  return Math.min(1, Math.max(min, Math.min(viewportW / layout.width, viewportH / layout.height)));
}
