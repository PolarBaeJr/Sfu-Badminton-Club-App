'use client';

import {
  computeRatingScale,
  buildRatingPath,
  buildRatingAreaPath,
  summarizeRatingSeries,
  seasonBoundaryX,
  formatSigned,
  type ChartBox,
  type RatingPoint,
} from '@/lib/stats-charts';

// The viewBox the line is drawn in. Fixed user units, stretched to whatever
// width the card gives it — 320 is roughly the inner width of a card at 390px,
// so on a phone the chart renders at about 1:1 and every stroke lands on a
// whole pixel.
const BOX: ChartBox = { width: 320, height: 120, padY: 14, padX: 6 };

// Only the last 40 matches are plotted. Past that, an index axis packs the
// points closer than the 2px stroke and the line stops being a series of
// matches and becomes a texture. The peak and low quoted beside it are the
// extremes OF THIS WINDOW, which is why the caption says "recent".
const MAX_POINTS = 40;

export interface RatingChartProps {
  points: RatingPoint[];
  /** The player's final rating in the season before this one, if one was archived. */
  priorRating: number | null;
  /** Name of that prior season, for the context line's label. */
  priorSeasonName: string | null;
  /** ISO start of the active season, used to place the divider. */
  seasonStart: string | null;
  /** Ratings below the provisional threshold are still settling; the chart says so. */
  provisional: boolean;
  label: string;
}

/**
 * The member's rating over their recent rated matches.
 *
 * The shape is SVG; every number printed on it is HTML positioned over the top
 * in percentage coordinates derived from the same scale. That split is
 * deliberate — text inside an SVG scales with the viewBox, so the same 10px
 * label would render at 10px on a phone and 20px on a wide card. Keeping the
 * type in HTML means it is 10px everywhere, which is the whole reason the
 * figures are legible at 390px.
 */
export function RatingChart({
  points,
  priorRating,
  priorSeasonName,
  seasonStart,
  provisional,
  label,
}: RatingChartProps) {
  const windowed = points.slice(Math.max(0, points.length - MAX_POINTS));

  if (windowed.length === 0) {
    return (
      <div className="empty" style={{ padding: '32px 20px' }}>
        <div className="empty-title">No rating history yet</div>
        <div className="empty-hint">
          Play a rated {label.toLowerCase()} match to start your chart. Every confirmed
          result adds a point.
        </div>
      </div>
    );
  }

  const scale = computeRatingScale(windowed, {
    box: BOX,
    // The prior-season rule has to be inside the domain or it is drawn on the
    // edge of the box and reads as a border rather than as a comparison.
    extra: priorRating === null ? [] : [priorRating],
  });
  const summary = summarizeRatingSeries(windowed)!;
  const boundaryX = seasonBoundaryX(windowed, seasonStart, scale);

  // Percentages, so the HTML labels track the SVG however wide it is drawn.
  const pctX = (x: number) => `${(x / BOX.width) * 100}%`;
  const pctY = (y: number) => `${(y / BOX.height) * 100}%`;

  const peakPoint = windowed[summary.peakIndex]!;
  const lowPoint = windowed[summary.lowIndex]!;
  const lastIndex = windowed.length - 1;
  // Peak and low collapse onto the same marker for a flat or single-match
  // series; drawing both stacks two labels on one dot.
  const showLow = summary.peakIndex !== summary.lowIndex;

  return (
    <div>
      <div style={{ position: 'relative', width: '100%' }}>
        <svg
          viewBox={`0 0 ${BOX.width} ${BOX.height}`}
          style={{ display: 'block', width: '100%', height: 'auto' }}
          role="img"
          aria-label={`${label} rating over the last ${windowed.length} matches. Currently ${summary.current}, peak ${summary.peak}, low ${summary.low}.`}
        >
          {/* The aspect ratio is preserved rather than stretched, so a wide card
              gets a taller chart instead of one whose markers are ovals: with
              preserveAspectRatio="none" the peak dot is squashed by exactly the
              factor the card is wider than 320, and at desktop widths that is a
              visibly elliptical blob sitting on the one point the eye goes to.
              Uniform scaling would also thicken every stroke, so each stroked
              element carries non-scaling-stroke and stays the width written
              here at any size. */}

          {priorRating !== null && (
            <line
              x1={0}
              x2={BOX.width}
              y1={scale.y(priorRating)}
              y2={scale.y(priorRating)}
              stroke="var(--mute)"
              strokeWidth={1}
              strokeDasharray="3 3"
              vectorEffect="non-scaling-stroke"
            />
          )}

          {boundaryX !== null && (
            <line
              x1={boundaryX}
              x2={boundaryX}
              y1={0}
              y2={BOX.height}
              stroke="var(--line-2)"
              strokeWidth={1}
              strokeDasharray="2 4"
              vectorEffect="non-scaling-stroke"
            />
          )}

          <path d={buildRatingAreaPath(windowed, scale)} fill="var(--red)" opacity={0.07} />
          <path
            d={buildRatingPath(windowed, scale)}
            fill="none"
            stroke="var(--red)"
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            vectorEffect="non-scaling-stroke"
          />

          {/* Individual matches are only dotted when they are far enough apart
              to be told from each other; past that the dots merge into a band
              along the line and add nothing. */}
          {windowed.length <= 24 &&
            windowed.map((p, i) => (
              <circle
                key={`${p.at}-${i}`}
                cx={scale.x(i)}
                cy={scale.y(p.rating)}
                r={1.6}
                fill="var(--red)"
                opacity={0.55}
              />
            ))}

        </svg>

        {/* The three markers that carry meaning are HTML, not SVG, for the same
            reason the figures are: a `<circle r="3">` is 6px on a phone and
            12px on a wide card, and a dot that grows with the container stops
            being a marker and becomes a blob. The per-match dots above are left
            in the SVG because their whole job is to scale with the line. */}
        <Marker
          left={pctX(scale.x(summary.peakIndex))}
          top={pctY(scale.y(peakPoint.rating))}
          border="var(--red)"
        />
        {showLow && (
          <Marker
            left={pctX(scale.x(summary.lowIndex))}
            top={pctY(scale.y(lowPoint.rating))}
            border="var(--mute)"
          />
        )}
        <Marker
          left={pctX(scale.x(lastIndex))}
          top={pctY(scale.y(summary.current))}
          border="var(--red)"
          fill="var(--red)"
        />

        {/* The figures, in HTML at a fixed size. translate(-50%, …) centres each
            on its marker; the peak sits above its dot and the low below, so
            neither ever covers the line it is describing. */}
        <ChartLabel
          left={pctX(scale.x(summary.peakIndex))}
          top={pctY(scale.y(peakPoint.rating))}
          above
          tone="var(--red)"
        >
          {summary.peak}
        </ChartLabel>
        {showLow && (
          <ChartLabel
            left={pctX(scale.x(summary.lowIndex))}
            top={pctY(scale.y(lowPoint.rating))}
            tone="var(--mute)"
          >
            {summary.low}
          </ChartLabel>
        )}

        {priorRating !== null && (
          <div
            className="mono"
            style={{
              position: 'absolute',
              right: 0,
              top: pctY(scale.y(priorRating)),
              transform: 'translateY(-115%)',
              fontSize: 10,
              color: 'var(--mute)',
              background: 'var(--surface)',
              padding: '0 3px',
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
            }}
          >
            {priorSeasonName ? `${priorSeasonName} END` : 'LAST SEASON'} {priorRating}
          </div>
        )}

        {boundaryX !== null && (
          <div
            className="mono"
            style={{
              position: 'absolute',
              left: pctX(boundaryX),
              top: 0,
              transform: 'translateX(-50%)',
              fontSize: 10,
              letterSpacing: '.08em',
              color: 'var(--mute)',
              background: 'var(--surface)',
              padding: '0 4px',
              whiteSpace: 'nowrap',
              pointerEvents: 'none',
            }}
          >
            NEW SEASON
          </div>
        )}
      </div>

      {/* The axis is the two dates the window spans. A tick per match would be
          unreadable at this width and the x axis is an index, not a timeline —
          labelling it densely would imply a scale it does not have. */}
      <div
        className="row mono muted"
        style={{ justifyContent: 'space-between', fontSize: 10, marginTop: 6 }}
      >
        <span>{shortDate(windowed[0]!.at)}</span>
        <span>
          {windowed.length} {windowed.length === 1 ? 'match' : 'matches'}
        </span>
        <span>{shortDate(windowed[lastIndex]!.at)}</span>
      </div>

      <div
        className="row"
        style={{
          gap: 0,
          marginTop: 14,
          borderTop: '1px solid var(--line)',
          paddingTop: 12,
          flexWrap: 'wrap',
        }}
      >
        <Figure label="CURRENT" value={String(summary.current)} />
        <Figure
          label="OVER WINDOW"
          value={formatSigned(summary.change)}
          tone={summary.change > 0 ? 'var(--win)' : summary.change < 0 ? 'var(--loss)' : undefined}
        />
        <Figure label="PEAK" value={String(summary.peak)} />
        <Figure label="LOW" value={String(summary.low)} />
      </div>

      {provisional && (
        <div className="mono muted" style={{ fontSize: 11, marginTop: 10 }}>
          Provisional — this rating is still settling and moves further per match.
        </div>
      )}
    </div>
  );
}

/** A fixed-size dot centred on a point of the line. */
function Marker({
  left,
  top,
  border,
  fill,
}: {
  left: string;
  top: string;
  border: string;
  fill?: string;
}) {
  return (
    <span
      aria-hidden
      style={{
        position: 'absolute',
        left,
        top,
        transform: 'translate(-50%, -50%)',
        width: 7,
        height: 7,
        borderRadius: '50%',
        border: `1.5px solid ${border}`,
        background: fill ?? 'var(--surface)',
        pointerEvents: 'none',
      }}
    />
  );
}

function ChartLabel({
  left,
  top,
  above,
  tone,
  children,
}: {
  left: string;
  top: string;
  above?: boolean;
  tone: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className="mono"
      style={{
        position: 'absolute',
        left,
        top,
        transform: `translate(-50%, ${above ? '-140%' : '40%'})`,
        fontSize: 10,
        fontWeight: 600,
        color: tone,
        background: 'var(--surface)',
        padding: '0 3px',
        whiteSpace: 'nowrap',
        pointerEvents: 'none',
      }}
    >
      {children}
    </span>
  );
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div style={{ flex: '1 1 25%', minWidth: 68 }}>
      <div className="stat-label" style={{ fontSize: 10 }}>
        {label}
      </div>
      <div className="mono" style={{ fontSize: 16, fontWeight: 600, color: tone ?? 'var(--ink)' }}>
        {value}
      </div>
    </div>
  );
}

/** `12 JAN`. Short enough for the two ends of a 320-unit axis at 10px. */
function shortDate(iso: string): string {
  return new Date(iso)
    .toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    .toUpperCase();
}
