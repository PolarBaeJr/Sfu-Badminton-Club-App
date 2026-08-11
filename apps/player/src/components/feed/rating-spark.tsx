import { sparklineGeometry, type RatingSeries } from '@/lib/feed-series';

// The rating line, drawn as bare SVG.
//
// There is no charting component in the design system and no chart library in
// this codebase, and the player-app guidelines ask for neither to be added — so
// this is a composition in the system's own idiom: one accent (--red) for the
// member, hairlines for context, no gridlines, no legend, no animation.
//
// WHY THE STROKES ARE MARKED non-scaling-stroke. The viewBox is a fixed
// 240 × 56 stretched to whatever width the card gives it
// (preserveAspectRatio="none"), which is the only way to fill a column whose
// width is unknown at render time. Without the vector-effect the horizontal
// scale would thicken the line, and it would be thicker on a desktop sidebar
// than on a phone.
//
// WHY THE CURRENT POINT IS A DASH AND NOT A DOT. Same non-uniform scale: a
// circle comes out as an ellipse, badly so at desktop widths. A horizontal
// segment's rendered thickness is a function of the vertical scale only, so it
// stays a clean 2px rule at any width. The rating itself is printed beside the
// chart in HTML — the guidelines are explicit that a shape without its figure
// is decoration.

const VIEW_W = 240;
const VIEW_H = 56;

export function RatingSpark({ series, label }: { series: RatingSeries; label: string }) {
  const geo = sparklineGeometry(series, VIEW_W, VIEW_H, 4);
  const last = geo.dots[geo.dots.length - 1];

  return (
    <svg
      viewBox={`0 0 ${VIEW_W} ${VIEW_H}`}
      width="100%"
      height={VIEW_H}
      preserveAspectRatio="none"
      role="img"
      aria-label={label}
      style={{ display: 'block', overflow: 'visible' }}
    >
      {geo.area && <path d={geo.area} fill="var(--red-wash)" />}

      {/* A rating only means something inside its season, so where one ended is
          context the line cannot carry on its own. Drawn between the two
          points it separates rather than on either of them. */}
      {geo.breaks.map((x) => (
        <line
          key={`break-${x}`}
          x1={x}
          x2={x}
          y1={0}
          y2={VIEW_H}
          stroke="var(--line-2)"
          strokeWidth={1}
          strokeDasharray="3 3"
          vectorEffect="non-scaling-stroke"
        />
      ))}

      {geo.polyline && (
        <polyline
          points={geo.polyline}
          fill="none"
          stroke="var(--red)"
          strokeWidth={2}
          strokeLinejoin="round"
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      )}

      {last && (
        <line
          x1={Math.max(0, last.x - 10)}
          x2={last.x}
          y1={last.y}
          y2={last.y}
          stroke="var(--red)"
          strokeWidth={3}
          strokeLinecap="round"
          vectorEffect="non-scaling-stroke"
        />
      )}
    </svg>
  );
}
