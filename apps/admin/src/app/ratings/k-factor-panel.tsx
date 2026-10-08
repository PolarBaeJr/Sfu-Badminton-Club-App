import { buildBars } from '@/lib/charts';
import { BarRows, ChartNote, count } from '@/components/charts';

/**
 * WHICH K-FACTOR ACTUALLY REACHES HOW MANY MEMBERS.
 *
 * THE QUESTION THIS PAGE EXISTS TO ANSWER AND COULD NOT. /ratings is the Elo
 * knobs: four K-factors and the placement-match threshold that decides which
 * pair of them a member is on. The form shows the K VALUES and the aside shows
 * the HEAD COUNTS, and nothing on the screen joins them — so an admin about to
 * halve the established singles K has no way to see whose ratings that slows
 * down. This is that join, and it is the only thing on this panel that is not
 * already printed somewhere above it.
 *
 * NOT THE LADDER HISTOGRAM, deliberately, and this is the one decision worth
 * recording. The spread of the club's ratings is a `players.read` question and
 * it already has a home on /admin/dashboard (see ../../lib/dashboard-ladder.ts,
 * whose header sets out at length why that capability and not this one).
 * /ratings is entered through `requireCapability('ratings.page')`, which is in
 * NO baseline — the club owner asked for the rating rules to be kept away from
 * execs entirely. So a second copy of the ladder here would be the same picture
 * shown to strictly fewer people, which is a duplicate that costs a query and
 * buys nothing. What belongs on the knobs page is the reach of the knobs.
 *
 * THE K VALUES COME FROM `platform_settings`, NEVER FROM THE ENGINE DEFAULTS.
 * getKFactor()'s fallbacks (80/48/64/36) are defaults for a club that has not
 * touched them, and staging has: its rating_defaults row carries
 * singles_k_established 36, not 48. Printing a constant beside a live head
 * count would be a chart lying about the club's own configuration, which is
 * worse than no chart. The caller therefore resolves each value THROUGH
 * getKFactor with the fetched settings passed in, so the fallback logic has one
 * implementation rather than two that can drift.
 *
 * NO QUERY OF ITS OWN — not one, not a count. `total` and the two provisional
 * counts are already fetched by loadLadder() for the figures above, and the
 * established counts are the subtraction: a rating is on the provisional
 * K-factors or it is on the established ones, and there is no third state. The
 * settings row is already fetched for the form. So this panel adds nothing to
 * the page's cost and answers to exactly the capabilities its inputs already
 * answered to — `players.read` for the counts, `platform.page` for the K
 * values. It renders inside the `ladder.state === 'ok'` branch so that
 * withholding stays ONE decision rather than two that could disagree.
 */

/** The four live K-factors, resolved from settings by the page. */
export interface KFactors {
  singlesProvisional: number;
  singlesEstablished: number;
  doublesProvisional: number;
  doublesEstablished: number;
}

export function KFactorPanel({
  total,
  singlesProvisional,
  doublesProvisional,
  k,
}: {
  /** Members with a ratings row at all. */
  total: number;
  /** On the provisional K-factors right now — the stored flag OR the threshold. */
  singlesProvisional: number;
  doublesProvisional: number;
  k: KFactors;
}) {
  if (total === 0) {
    return (
      <ChartNote>
        No member has a rating yet, so these settings reach nobody. A rating row appears the
        first time somebody plays a confirmed match.
      </ChartNote>
    );
  }

  // ONE ROW PER K-FACTOR, in the order the form lists them: singles then
  // doubles, provisional then established. Not sorted by size — the reading
  // order here is the settings' own order, so an admin can look from a field
  // they are editing straight down to the number of people it moves.
  //
  // `cents` is the BarPart field name and holds a member count here, not money;
  // `format={count}` is what keeps it out of the money formatter. The builder
  // is unit-agnostic by design (see @/lib/charts) and the field is only ever
  // named for its commonest caller.
  const rows = buildBars([
    {
      label: `Singles · provisional K${k.singlesProvisional}`,
      cents: singlesProvisional,
    },
    {
      // Every rated member is on one K-factor or the other, so the established
      // count is the complement rather than a fifth figure that could disagree
      // with the four already on screen.
      label: `Singles · established K${k.singlesEstablished}`,
      cents: total - singlesProvisional,
    },
    {
      label: `Doubles · provisional K${k.doublesProvisional}`,
      cents: doublesProvisional,
    },
    {
      label: `Doubles · established K${k.doublesEstablished}`,
      cents: total - doublesProvisional,
    },
  ]);

  return (
    <div className="space-y-3">
      <BarRows rows={rows} tone="var(--color-info)" format={count} />
      {/* Said, not drawn: the bars are measured against the largest row, so two
          disciplines whose splits differ cannot be read as shares of each
          other. The sentence is what stops "provisional" being mistaken for a
          problem — it is where every member starts. */}
      <p className="text-[13px] leading-[1.5] text-[var(--mute)]">
        Every rated member sits on one K-factor per discipline. Provisional is the higher pair
        and applies until the placement-match threshold is met.
      </p>
    </div>
  );
}
