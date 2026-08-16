import { calculateEloUpdate, FORMAT_WEIGHTS, EVENT_MULTIPLIERS } from '@badminton/shared/src/elo/engine';
import type { EloBounds } from '@badminton/shared/src/utils/constants';
import type { KFactors } from './k-factor-panel';

/**
 * WHAT THESE K-FACTORS ACTUALLY DO TO A MATCH.
 *
 * THE SCREEN WHERE SOMEBODY SETS K TO 200 BY ACCIDENT. Every other control on
 * /ratings names a thing an admin already understands — a starting rating, a
 * ceiling, a number of placement matches. "Singles K (provisional)" names a
 * coefficient, and the form's hint ("how fast a rating moves") is true but
 * unquantified: nothing on the page said whether 64 was gentle or violent, so
 * there was no way to tell 64 from 640 by looking. This panel is the units.
 *
 * REAL NUMBERS, NOT A RULE OF THUMB. Every figure is produced by
 * calculateEloUpdate — the same function that rates a tournament match, given
 * the same format weight and event multiplier a plain rated challenge carries
 * (single game to 21, FORMAT_WEIGHTS.single_21 x EVENT_MULTIPLIERS
 * .rated_challenge). So these are not illustrative: they are the deltas this
 * club's settings would produce, including the clamp at the configured bounds.
 * A hand-derived "K/2" would have been wrong the moment a format weight or an
 * event multiplier was involved, and would have drifted the first time either
 * changed.
 *
 * NO QUERY, and no state. The K-factors are already resolved from
 * platform_settings by the page (kFactorsOf), the bounds come from the same
 * fetched row, and everything below is arithmetic on them. This panel costs the
 * page nothing and answers to the capability its inputs already answered to —
 * `platform.page`, the same as the form it sits beside.
 *
 * TWO SCENARIOS, CHOSEN TO BRACKET THE DECISION:
 *
 *   EVEN MATCH — both players on the same rating. This is the pure "how big is
 *   K" reading: the expected score is 0.5, so the swing is half of K times the
 *   weights, and it is the number an admin should sanity-check against the
 *   width of the ladder. A club whose ratings span 400-1300 and whose even
 *   match moves 100 points has a ladder that reshuffles every night.
 *
 *   ONE TIER APART — the favourite is a full skill tier above (00127). This is
 *   the scenario the tiers created and the one that decides whether provisional
 *   K is doing its job: it shows what a member who UNDERSTATED their level
 *   gains per win against the people they are now mis-seeded among. On this
 *   ladder ELO_SCALE is 800, so a 400 gap is half a scale and the favourite is
 *   expected to win about 76% of the time — meaning they gain little for
 *   winning and lose heavily for losing, which is precisely the mechanism that
 *   drags a wrong tier back to the truth.
 */

/** A plain rated challenge, single game to 21 — the club's commonest match. */
const FORMAT_WEIGHT = FORMAT_WEIGHTS.single_21;
const EVENT_MULT = EVENT_MULTIPLIERS.rated_challenge;

/** One tier of separation (00127): 400 points, half of ELO_SCALE. */
const TIER_GAP = 400;

function swing(
  playerRating: number,
  opponentRating: number,
  kFactor: number,
  won: boolean,
  bounds: EloBounds | null,
): number {
  return calculateEloUpdate({
    playerRating,
    opponentRating,
    kFactor,
    formatWeight: FORMAT_WEIGHT,
    eventMultiplier: EVENT_MULT,
    won,
    bounds,
  }).delta;
}

function signed(n: number): string {
  return n > 0 ? `+${n}` : String(n);
}

const MONO_LABEL = 'font-mono text-[10px] uppercase tracking-[.14em] text-[var(--mute)]';

export function KImpactPanel({
  k,
  /** The club's starting rating — the midpoint both scenarios are measured at. */
  baseline,
  bounds,
  /** False when provisional K is switched off (00127). */
  provisionalKEnabled,
}: {
  k: KFactors;
  baseline: number;
  bounds: EloBounds | null;
  provisionalKEnabled: boolean;
}) {
  // The favourite sits a tier above the baseline so BOTH players stay inside a
  // realistic part of the ladder; measuring the gap downward from the baseline
  // would push the underdog under the floor on most configurations and the
  // clamp would then quietly flatten the figures.
  const under = baseline;
  const over = baseline + TIER_GAP;

  const rows = [
    // Provisional first, matching the form's order and the panel above. When
    // the switch is off these two rows are still shown, but labelled as not in
    // use — removing them would leave an admin editing a field with no reading
    // beside it, which is how the value gets tuned while it does nothing.
    { label: 'Singles · provisional', value: k.singlesProvisional, provisional: true },
    { label: 'Singles · established', value: k.singlesEstablished, provisional: false },
    { label: 'Doubles · provisional', value: k.doublesProvisional, provisional: true },
    { label: 'Doubles · established', value: k.doublesEstablished, provisional: false },
  ].map((row) => ({
    ...row,
    even: swing(baseline, baseline, row.value, true, bounds),
    favouriteWins: swing(over, under, row.value, true, bounds),
    underdogWins: swing(under, over, row.value, true, bounds),
    inUse: provisionalKEnabled || !row.provisional,
  }));

  return (
    <div className="space-y-3">
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-[13px]">
          <thead>
            <tr>
              <th className={`${MONO_LABEL} py-2 pr-3 text-left font-normal`}>K-factor</th>
              <th className={`${MONO_LABEL} py-2 px-2 text-right font-normal`}>Even</th>
              <th className={`${MONO_LABEL} py-2 px-2 text-right font-normal`}>Fav. wins</th>
              <th className={`${MONO_LABEL} py-2 pl-2 text-right font-normal`}>Upset</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <tr key={row.label} className="border-t border-[var(--line)]">
                <td className="py-2 pr-3 text-left align-baseline">
                  {/* Dimmed rather than hidden when the switch is off — the
                      field is still editable above, so it still needs a
                      reading. */}
                  <span className={row.inUse ? 'text-[var(--ink)]' : 'text-[var(--mute)] line-through'}>
                    {row.label}
                  </span>
                  <span className={`${MONO_LABEL} ml-2`}>K{row.value}</span>
                </td>
                <td className={`py-2 px-2 text-right font-mono align-baseline ${row.inUse ? 'text-[var(--ink)]' : 'text-[var(--mute)]'}`}>
                  {signed(row.even)}
                </td>
                <td className={`py-2 px-2 text-right font-mono align-baseline ${row.inUse ? 'text-[var(--ink)]' : 'text-[var(--mute)]'}`}>
                  {signed(row.favouriteWins)}
                </td>
                <td className={`py-2 pl-2 text-right font-mono align-baseline ${row.inUse ? 'text-[var(--ink)]' : 'text-[var(--mute)]'}`}>
                  {signed(row.underdogWins)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[13px] leading-[1.5] text-[var(--mute)]">
        Rating the winner gains in one rated challenge, single game to 21, starting from{' '}
        {baseline}. <span className="text-[var(--ink-2)]">Even</span> is two players on the same
        rating; <span className="text-[var(--ink-2)]">Fav. wins</span> and{' '}
        <span className="text-[var(--ink-2)]">Upset</span> are one skill tier apart ({TIER_GAP}{' '}
        points), which the favourite is expected to win about 76% of the time. The loser moves by
        the same amount in the opposite direction.
      </p>

      {/* THE SENTENCE THIS PANEL EXISTS FOR. Turning provisional K off is the
          change on this page with the least visible consequence and the most
          real one — nothing on screen moves, no rating changes, and the effect
          only shows up weeks later as a mis-seeded member sitting on a winning
          streak. Said here, next to the numbers that make it concrete. */}
      {!provisionalKEnabled && (
        <p className="border border-[var(--line)] bg-[var(--surface-2)] px-3 py-2 text-[13px] leading-[1.5] text-[var(--ink-2)]">
          Provisional K-factors are switched off, so every member moves on the established
          K-factors from their first match. A member who understates their skill level at signup
          will now take far longer to reach their true rating — and they climb by beating people
          they are already stronger than while they do it.
        </p>
      )}
    </div>
  );
}
