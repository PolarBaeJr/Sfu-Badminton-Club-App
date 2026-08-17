import type { MatchFormat, EventType } from '../types/database';
import {
  clampElo,
  DEFAULT_ELO,
  PROVISIONAL_THRESHOLD,
  SWEEP_MARGIN_MULTIPLIER,
  derivedFormatWeight,
  getEventRules,
  hasTypedFormat,
  type EloBounds,
  type EventMatchShape,
} from '../utils/constants';

export const FORMAT_WEIGHTS: Record<MatchFormat, number> = {
  bo3_21: 1.25,
  single_21: 1.0,
  single_15: 0.75,
  single_11: 0.5,
};

// Logistic divisor for the win-probability curve. The classic ELO value is 400;
// this ladder uses 800 to stretch the rating spread 2x (nominal 400, top ~1300).
// A rating gap of ELO_SCALE means the higher player wins ~91% of the time.
export const ELO_SCALE = 800;

export const EVENT_MULTIPLIERS: Record<EventType, number> = {
  rated_challenge: 1.0,
  trial: 1.15,
  tournament: 1.15,
  admin_entered: 1.0,
  casual: 0.0,
};

export interface EloCalcInput {
  playerRating: number;
  opponentRating: number;
  kFactor: number;
  formatWeight: number;
  eventMultiplier: number;
  won: boolean;
  eloWeightOverride?: number;
  /** Margin-of-victory scaling — see getMarginMultiplier(). Defaults to 1.0. */
  marginMultiplier?: number;
  /** Configured rating range; falls back to [MIN_ELO, MAX_ELO] when absent. */
  bounds?: EloBounds | null;
}

export interface EloCalcResult {
  newRating: number;
  delta: number;
  expected: number;
}

export function calculateExpected(playerRating: number, opponentRating: number): number {
  return 1.0 / (1.0 + Math.pow(10, (opponentRating - playerRating) / ELO_SCALE));
}

// Margin-of-victory scaling, deliberately coarse: a clean sweep counts slightly
// more than a match that went the distance, and nothing else does.
//
// Scaling by GAMES rather than points is a safety decision, not a modelling one.
// Scores here are self-reported and confirmed by the opponent, so any factor
// that rewards a bigger margin also rewards inflating one — points-based
// scaling would make forged scorelines directly profitable and give players a
// reason to run the score up on a weaker clubmate. Sweep-vs-not is a single bit
// of information: nearly worthless to manipulate, but still enough to separate
// "beat them twice cleanly" from "scraped through in three".
//
// Single-game formats have no margin to speak of and are always 1.0.
// `sweepMultiplier` comes from platform_settings.rating_defaults
// (sweep_margin_multiplier) so admins can tune it; the constant is only the
// fallback. Bounded to [1, 2] to match get_margin_multiplier() in SQL — a
// malformed setting must not scale every rating change arbitrarily.
export function getMarginMultiplier(
  gamesWon: number,
  gamesLost: number,
  sweepMultiplier: number = SWEEP_MARGIN_MULTIPLIER,
): number {
  const total = gamesWon + gamesLost;
  if (total < 2) return 1.0;                      // single-game format
  if (gamesWon > 0 && gamesLost > 0) return 1.0;  // went the distance
  const m = Number.isFinite(sweepMultiplier) ? sweepMultiplier : SWEEP_MARGIN_MULTIPLIER;
  return Math.min(2.0, Math.max(1.0, m));         // clean sweep, either side
}

// JS Math.round breaks ties toward +Infinity (-34.5 -> -34) while Postgres
// ROUND() breaks them away from zero (-34.5 -> -35). Both engines rate real
// matches — SQL for challenges, this one for tournaments — so a disagreement
// means the same scoreline moves ratings differently depending on where it was
// played, and a winner/loser pair can differ by a point (leaking rating into
// the ladder). Match Postgres.
function roundHalfAwayFromZero(n: number): number {
  return Math.sign(n) * Math.round(Math.abs(n));
}

export function calculateEloUpdate(input: EloCalcInput): EloCalcResult {
  const actual = input.won ? 1.0 : 0.0;
  const expected = calculateExpected(input.playerRating, input.opponentRating);
  const weight = input.eloWeightOverride ?? 1.0;
  const margin = input.marginMultiplier ?? 1.0;
  const rawDelta = roundHalfAwayFromZero(
    input.kFactor * input.formatWeight * input.eventMultiplier * weight * margin * (actual - expected)
  );

  // Clamp the resulting rating to [MIN_ELO, MAX_ELO], then derive the delta from
  // the clamped rating so newRating and delta stay consistent at the bounds.
  const newRating = clampElo(input.playerRating + rawDelta, input.bounds);
  const delta = newRating - input.playerRating;

  return {
    newRating,
    delta,
    expected,
  };
}

export function getFormatWeight(format: MatchFormat): number {
  return FORMAT_WEIGHTS[format];
}

export function getEventMultiplier(eventType: EventType): number {
  return EVENT_MULTIPLIERS[eventType];
}

// ============================================================
// THE TWO WEIGHT TABLES, AND WHY THEY ARE ALLOWED TO DISAGREE
// ============================================================
//
// There are two ways to get a format weight in this codebase and they do not
// agree:
//
//   * a match with a TYPED shape (games_per_match / points_per_game set — every
//     custom challenge, everything knockoutLadder() stamps, every per-round
//     override) is weighed by the FORMULA, derivedFormatWeight =
//     (target / 21) x (1.25 for a best-of), clamped to [0.25, 1.5];
//   * a match that INHERITS an enum is weighed by the FORMAT_WEIGHTS TABLE
//     above.
//
// They agree exactly on the two shapes anybody plays by default and disagree on
// the two short ones:
//
//     shape            table    formula        derivation
//     best of 3 to 21   1.25     1.25          (21/21) x 1.25
//     1 game to 21      1.00     1.00          21/21
//     1 game to 15      0.75     0.7142857…    15/21
//     1 game to 11      0.50     0.5238095…    11/21
//
// RULING (2026-08-17): BOTH STAY. This is not a display bug to reconcile, it is
// a faithful mirror of the write path, and the write path is in SQL:
//
//     -- trigger_set_match_weights, migration 00031
//     IF NEW.points_per_game IS NOT NULL THEN
//       NEW.format_weight := derived_format_weight(...);   -- the formula
//     ELSE
//       NEW.format_weight := get_format_weight(NEW.format); -- the table
//     END IF;
//
// and get_format_weight (00003_functions.sql) is FORMAT_WEIGHTS entry for
// entry: 1.25 / 1.00 / 0.75 / 0.50. Changing either table in TypeScript would
// make what members are SHOWN disagree with what the ladder APPLIES, which is
// the opposite of the point. Changing the SQL side is a migration and a
// restatement of what a shape is worth — the owner's call, not this module's,
// and it is called out in the report rather than done quietly here.
//
// The disagreement is locked by a test (engine.test.ts, "the two weight tables")
// so that "fixing" one of them fails loudly instead of silently re-pricing
// every short match.
//
// resolvedFormatWeight below picks the same branch the trigger picks, so it is
// the ONE function both rateTournamentMatch and every place that prints a
// weight go through.

/** Tournament match_format enum -> the ladder's own enum. */
function toEloFormat(mf: string): MatchFormat | null {
  switch (mf) {
    case 'best_of_3_to_21': return 'bo3_21';
    case 'one_game_21': return 'single_21';
    case 'one_game_15': return 'single_15';
    case 'one_game_11': return 'single_11';
    // Already an engine format (the challenge side passes these), or something
    // the CHECK constraint does not allow. Named rather than cast, so an unknown
    // string falls through to the derived formula below instead of indexing the
    // table with a miss and multiplying a rating change by undefined.
    default: return mf in FORMAT_WEIGHTS ? (mf as MatchFormat) : null;
  }
}

/**
 * The format weight the rating engine will actually use for a resolved match
 * shape. Pass the output of `resolveMatchShape(match, event)`.
 *
 * DELIBERATELY UNQUANTIZED — do not wrap this in storedWeight(). The tournament
 * path computes its deltas here in TypeScript and hands
 * apply_tournament_match_rating the finished integers (see
 * applyTournamentMatchElo), so nothing ever narrows this number to two
 * decimals. Rounding it would make the console print a weight the tournament
 * ladder does not use. The challenge path is the one that quantizes, and it does
 * so inside previewEloChange, where the column that causes it lives.
 */
export function resolvedFormatWeight(shape: EventMatchShape): number {
  const rules = getEventRules(shape);
  if (hasTypedFormat(shape)) return derivedFormatWeight(rules.bestOf, rules.target);
  const mapped = toEloFormat(String(shape.match_format));
  return mapped ? FORMAT_WEIGHTS[mapped] : derivedFormatWeight(rules.bestOf, rules.target);
}

/**
 * How wide the `matches` weight columns are. `format_weight` and
 * `event_multiplier` are both NUMERIC(4,2) (00001_schema.sql).
 */
export const STORED_WEIGHT_DECIMALS = 2;

/**
 * A weight as the CHALLENGE path will actually apply it.
 *
 * apply_match_result (00127) rates a challenge off the STORED column —
 * `v_format_weight := v_match.format_weight` — not off the expression that
 * produced it, and that column is NUMERIC(4,2). derived_format_weight returns
 * full precision, so the number the ladder multiplies by is its 2-decimal
 * rounding: a custom shape to 15 is written as 0.71, not 0.714285714…
 *
 * That gap is small but it is not cosmetic, because the delta is ROUNDed to an
 * integer afterwards, so a fraction of a percent can move the answer by a whole
 * point. Best of 3 to 15, two members level at 1200, production's provisional
 * singles K of 64:
 *
 *     preview, unquantized:  64 x 0.892857… x 1.0 x 0.5 = 28.571 -> +29
 *     ladder, as stored:     64 x 0.89      x 1.0 x 0.5 = 28.480 -> +28
 *
 * Every challenge takes the derived branch — the New Challenge form always
 * sends games_per_match / points_per_game — so this applied to every custom
 * shape whose weight was not already a round two decimals.
 *
 * Rounds half away from zero for the same reason roundHalfAwayFromZero exists:
 * NUMERIC is exact decimal and rounds that way, and elo_multiplier is allowed
 * to be negative.
 */
export function storedWeight(weight: number): number {
  const scale = 10 ** STORED_WEIGHT_DECIMALS;
  return (Math.sign(weight) * Math.round(Math.abs(weight) * scale)) / scale;
}

/**
 * An event's Elo multiplier, coerced the way the rating path coerces it.
 *
 * `tournament_events.elo_multiplier` is DECIMAL(4,2), which PostgREST hands
 * back as a STRING, and it has no CHECK constraint. `Number(x) || 1.25` is
 * deliberately reproduced rather than improved: it is what rateTournamentMatch
 * does, including reading an explicit 0 as "unset" — a display that treated 0
 * as 0 would promise an unrated round that the engine still rates at 1.25.
 */
export function eventEloMultiplier(raw: unknown): number {
  return Number(raw) || 1.25;
}

/**
 * Both halves of a round's rating weight, plus the only number that means
 * anything on its own: their product.
 *
 * The engine multiplies kFactor x formatWeight x eventMultiplier x ... , so the
 * round's own weight is only half the answer — an event at 1.25 rates its game
 * to 11 (0.52) harder than a rated challenge to 21 rates itself (1.00 x 1.00).
 * Showing the weight alone is what let a game to 11 be read as "a quarter".
 *
 * No predicted point swing is offered, and that is deliberate: the delta also
 * needs the K-factor, both ratings and the sweep multiplier, so any "+/-N" here
 * would be a number nobody could reproduce.
 */
export function eloWeightBreakdown(shape: EventMatchShape, rawMultiplier: unknown): {
  weight: number;
  multiplier: number;
  product: number;
  /** "0.52 x 1.25 = 0.65x" */
  short: string;
  /** The same thing said out loud, for a screen reader. */
  spoken: string;
} {
  const weight = resolvedFormatWeight(shape);
  const multiplier = eventEloMultiplier(rawMultiplier);
  const product = weight * multiplier;
  return {
    weight,
    multiplier,
    product,
    short: `${weight.toFixed(2)} × ${multiplier.toFixed(2)} = ${product.toFixed(2)}×`,
    spoken:
      `Rating weight ${weight.toFixed(2)} for this round, times ${multiplier.toFixed(2)} for the event, `
      + `is ${product.toFixed(2)} times. A rated challenge played to 21 is 1.00 times.`,
  };
}

/**
 * Configured K-factors and provisional threshold, from
 * platform_settings.rating_defaults. Every field is optional; anything missing
 * or non-numeric falls back to the hardcoded default, so a malformed settings
 * row degrades to today's behaviour rather than zeroing out rating movement.
 */
export interface RatingSettings {
  provisional_threshold?: number | null;
  singles_k_provisional?: number | null;
  singles_k_established?: number | null;
  doubles_k_provisional?: number | null;
  doubles_k_established?: number | null;
  min_elo?: number | null;
  max_elo?: number | null;
  // Sweep bonus, read by getMarginMultiplier(). Present here because the SQL
  // side reads it out of the SAME platform_settings row
  // (get_margin_multiplier() selects value->>'sweep_margin_multiplier'), and a
  // caller that fetches rating_defaults for the K-factors has already paid for
  // it — leaving it off the type is how the TS engine ended up defaulting the
  // multiplier to 1.0 while SQL applied 1.15 to the identical scoreline.
  sweep_margin_multiplier?: number | null;
  /**
   * Whether the provisional K-factors apply at all (00127). Default ON — the
   * behaviour of every club before this setting existed.
   *
   * Turning it OFF makes every player take the ESTABLISHED K regardless of how
   * few matches they have played. It deliberately does NOT change the
   * provisional flags or the threshold that clears them: /ratings counts heads
   * off `flag OR matches_played < threshold`, and suppressing the flag would
   * make those figures lie about members who are still, factually, in their
   * placement window.
   */
  provisional_k_enabled?: boolean | null;
}

function num(value: unknown, fallback: number): number {
  const n = Number(value);
  // A K of 0 would freeze every rating, so it is treated as unset rather than
  // honoured — same reasoning as the SQL side's bounds check.
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function getKFactor(
  matchType: 'singles' | 'doubles',
  provisional: boolean,
  matchesPlayed?: number,
  settings?: RatingSettings | null,
): number {
  // Provisional threshold: fewer than PROVISIONAL_THRESHOLD matches = provisional
  // K-factor. Uses the shared constant so tuning it can't silently drift from
  // the rest of the app.
  const threshold = num(settings?.provisional_threshold, PROVISIONAL_THRESHOLD);
  // The 00127 switch. `=== false` and not a truthiness test: a malformed value
  // — a string, a null, a key that was never written — must degrade to today's
  // behaviour (provisional K ON), the same convention num() follows above. Only
  // an explicit false turns it off.
  //
  // Mirrors the `v_provisional_k AND (...)` guard in apply_match_result
  // (00127). Both engines must agree: challenges rate through the SQL function
  // and tournaments through this one, so honouring the switch in only one would
  // apply a different K to the same player depending on where they played.
  const provisionalKEnabled = settings?.provisional_k_enabled !== false;
  const isProvisional =
    provisionalKEnabled &&
    (provisional || (matchesPlayed !== undefined && matchesPlayed < threshold));
  // Defaults are doubled from the classic 40/24 (singles) and 32/18 (doubles)
  // to match the 2x-stretched ELO_SCALE — this keeps each delta the same
  // fraction of the scale, so convergence speed and volatility are unchanged.
  // They are now only defaults; the live values come from settings.
  if (matchType === 'singles') {
    return isProvisional
      ? num(settings?.singles_k_provisional, 80)
      : num(settings?.singles_k_established, 48);
  }
  return isProvisional
    ? num(settings?.doubles_k_provisional, 64)
    : num(settings?.doubles_k_established, 36);
}

export function calculateTeamRating(ratings: number[]): number {
  // Guard against an empty team — dividing by 0 yields NaN, which would poison
  // any downstream rating write.
  if (ratings.length === 0) return DEFAULT_ELO;
  return Math.round(ratings.reduce((a, b) => a + b, 0) / ratings.length);
}

/**
 * What ONE side stands to gain or lose, for a match that has not been played.
 *
 * This is a promise made to a member before they accept a challenge, so it has
 * to be the number apply_match_result will actually write. Everything the two
 * engines can agree on is threaded through `settings`; the one thing they
 * cannot is the MARGIN MULTIPLIER, which needs a scoreline that does not exist
 * yet. The preview therefore reports the un-swept figure, which is the SMALLER
 * of the two outcomes on production (sweep_margin_multiplier is 1.15) — under-
 * promising a gain is the safe direction for a figure somebody is deciding on.
 *
 * The delta is the VIEWER'S. The other side is rated with its own K off its own
 * matches played, so the two are not mirror images and nothing here should be
 * labelled as what the opponent stands to lose.
 */
export function previewEloChange(
  playerRating: number,
  opponentRating: number,
  format: MatchFormat,
  // THE MULTIPLIER ITSELF, NOT THE EVENT TYPE — and that is the fix, not a
  // convenience. This used to take an `eventType` and look it up in
  // EVENT_MULTIPLIERS, which is right for a challenge (SQL's
  // get_event_multiplier is that table entry for entry) and WRONG for a
  // tournament, because tournament_events.elo_multiplier is a per-event column
  // an exec can edit and applyTournamentMatchElo rates off that column. Anybody
  // previewing a tournament match through the enum would have quoted the
  // table's 1.15 against the column's default of 1.25.
  //
  // Made an explicit number rather than an optional override alongside the enum
  // so there is exactly one source: a challenge caller passes
  // getEventMultiplier(...), a tournament caller passes
  // eventEloMultiplier(event.elo_multiplier), and neither can be silently
  // wrong. Changing the parameter's TYPE rather than adding one means an
  // un-updated caller fails to compile instead of previewing the old number.
  //
  // NOT coerced or defaulted here. 0 is a legitimate value — it is what an
  // unrated casual match is worth — so `|| 1` would turn "this moves nothing"
  // into "this moves everything".
  eventMultiplier: number,
  matchType: 'singles' | 'doubles',
  provisional: boolean,
  eloWeightOverride?: number,
  matchesPlayed?: number,
  // Custom shape ("best of X to Y"): when present the weight is derived rather
  // than looked up. Without this the preview passed a format the table has no
  // entry for, so the weight came back undefined and every figure rendered NaN.
  custom?: { gamesPerMatch: number; pointsPerGame: number },
  // The club's configured knobs, from platform_settings.rating_defaults.
  //
  // OPTIONAL, AND THAT IS THE WHOLE POINT OF THE PARAMETER. Omitting it was not
  // a caller forgetting to pass something; it was the preview quietly computing
  // its K from the hardcoded fallbacks while apply_match_result computed the
  // REAL delta from the settings row. On production those disagree by most of a
  // factor of two — the fallbacks are 80/48 for singles, the configured values
  // are 64/36 — so a member deciding whether to accept a challenge was shown a
  // number the ladder was never going to apply.
  //
  // Threaded rather than fetched here because this module is pure and runs on
  // both sides of the client boundary; the caller reads the row (server-side)
  // and hands it down. Passing null or nothing reproduces the old behaviour
  // exactly, which is what a settings read that failed should degrade to.
  settings?: RatingSettings | null,
): { winDelta: number; lossDelta: number } {
  // The same four arguments apply_match_result assembles (00041/00127): the
  // configured K pair, the provisional threshold, and the 00127 off switch.
  const k = getKFactor(matchType, provisional, matchesPlayed, settings);
  // storedWeight(), because a challenge is rated off matches.format_weight and
  // that column is NUMERIC(4,2) — see storedWeight for the arithmetic and for
  // the +29-vs-+28 case this was getting wrong. Applied to BOTH branches: the
  // table's entries are already exact two-decimal values, so it is a no-op
  // there, and doing it unconditionally means the preview cannot be right on one
  // branch and wrong on the other.
  const fw = storedWeight(
    custom
      ? derivedFormatWeight(custom.gamesPerMatch, custom.pointsPerGame)
      : (getFormatWeight(format) ?? FORMAT_WEIGHTS.single_21),
  );
  // Same column, same width: matches.event_multiplier is NUMERIC(4,2) too.
  const em = storedWeight(eventMultiplier);
  // The configured rating range, for the same reason. calculateEloUpdate derives
  // its delta from the CLAMPED rating, so a preview that fell back to the
  // MIN_ELO/MAX_ELO constants would understate the gain for anybody near 1500 on
  // a club whose ceiling is 3001 — and would do it silently, since the figure
  // still looks like a plausible delta.
  const bounds = settings ? { min: settings.min_elo, max: settings.max_elo } : undefined;

  const winResult = calculateEloUpdate({
    playerRating,
    opponentRating,
    kFactor: k,
    formatWeight: fw,
    eventMultiplier: em,
    won: true,
    eloWeightOverride,
    bounds,
  });

  const lossResult = calculateEloUpdate({
    playerRating,
    opponentRating,
    kFactor: k,
    formatWeight: fw,
    eventMultiplier: em,
    won: false,
    eloWeightOverride,
    bounds,
  });

  return { winDelta: winResult.delta, lossDelta: lossResult.delta };
}
