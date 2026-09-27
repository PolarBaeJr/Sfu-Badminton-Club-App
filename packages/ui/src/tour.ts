// THE GUIDED TOUR'S DECISIONS, with no React and no DOM, so a test can import
// them. The component in ./components/Tour.tsx does the measuring and the
// drawing; everything it has to DECIDE (which steps this person gets, which
// element a step points at, where the card goes, whether the tour starts on
// its own) is here.
//
// Shared by both apps. Each app writes its own steps (member-tour.ts in the
// player app, exec-tour.ts in the console) and passes them through selectSteps
// before handing them to the component.

export interface TourStepRequires {
  /** At least one of these club features is on, or held by key. */
  featuresAny?: readonly string[];
  /** Only for an approved member. A pending signup is not shown it. */
  approved?: boolean;
  /** Console capabilities, every one held. */
  capabilitiesAll?: readonly string[];
  /** Console capabilities, at least one held. */
  capabilitiesAny?: readonly string[];
}

export interface TourStep {
  id: string;
  title: string;
  body: string;
  /**
   * CSS selectors in priority order. The first one that matches a VISIBLE
   * element wins, which is how one step points at the phone's tab bar on a
   * phone and the top bar on a desktop without asking for the breakpoint.
   * Empty for a step with nothing to point at.
   */
  targets: readonly string[];
  /** What to do when no target is visible: leave the step out, or show it as a centred card. */
  missingTarget: 'skip' | 'center';
  requires?: TourStepRequires;
}

export interface TourContext {
  features: Record<string, boolean>;
  /** Switched-off features this viewer holds the key to (featureAccessFor). */
  featureAccess: readonly string[];
  approved: boolean;
  /** Console capabilities held. Empty in the player app. */
  held: ReadonlySet<string>;
}

/**
 * A feature counts as on when its switch is on OR the viewer holds its key,
 * which is the same answer featureGate() gives for a page: a key holder can
 * still open it, so the tour may still point at it.
 */
function featureOn(ctx: TourContext, id: string): boolean {
  return ctx.features[id] === true || ctx.featureAccess.includes(id);
}

export function requirementsMet(r: TourStepRequires | undefined, ctx: TourContext): boolean {
  if (!r) return true;
  if (r.featuresAny && !r.featuresAny.some((f) => featureOn(ctx, f))) return false;
  if (r.approved && !ctx.approved) return false;
  if (r.capabilitiesAll && !r.capabilitiesAll.every((c) => ctx.held.has(c))) return false;
  if (r.capabilitiesAny && !r.capabilitiesAny.some((c) => ctx.held.has(c))) return false;
  return true;
}

export function stepAllowed(step: TourStep, ctx: TourContext): boolean {
  return requirementsMet(step.requires, ctx);
}

/** The steps this person is shown, in order. */
export function selectSteps(steps: readonly TourStep[], ctx: TourContext): TourStep[] {
  return steps.filter((step) => stepAllowed(step, ctx));
}

/** The first selector whose element is visible, or null. */
export function resolveTarget(
  targets: readonly string[],
  isVisible: (selector: string) => boolean,
): string | null {
  for (const selector of targets) {
    if (isVisible(selector)) return selector;
  }
  return null;
}

export interface TourRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface TourPlacement {
  top: number;
  left: number;
  side: 'below' | 'above' | 'center';
}

/** Space kept between the card and the viewport edge, and between the card and its target. */
const EDGE = 12;
const GAP = 12;

function clamp(value: number, min: number, max: number): number {
  if (max < min) return min;
  return Math.min(Math.max(value, min), max);
}

/**
 * Where the card goes.
 *
 * Below the target when it fits, above when it does not, and otherwise
 * whichever side has more room, clamped on screen. A target inside the bottom
 * band (the phone's tab bar) always gets the card above it: below would be off
 * screen or under the bar. `reserved` is the space fixed chrome takes at each
 * edge, so the card never lands under it. No target means a centred card.
 */
export function placePopover(
  target: TourRect | null,
  popover: { width: number; height: number },
  viewport: { width: number; height: number },
  reserved: { top: number; bottom: number },
): TourPlacement {
  const minLeft = EDGE;
  const maxLeft = viewport.width - EDGE - popover.width;
  const minTop = reserved.top + EDGE;
  const maxTop = viewport.height - reserved.bottom - EDGE - popover.height;

  if (!target) {
    const band = viewport.height - reserved.top - reserved.bottom;
    return {
      top: clamp(reserved.top + (band - popover.height) / 2, minTop, maxTop),
      left: clamp((viewport.width - popover.width) / 2, minLeft, maxLeft),
      side: 'center',
    };
  }

  const left = clamp(target.left + target.width / 2 - popover.width / 2, minLeft, maxLeft);
  const targetBottom = target.top + target.height;
  const below = targetBottom + GAP;
  const above = target.top - GAP - popover.height;
  const inBottomBand = target.top >= viewport.height - reserved.bottom;

  if (!inBottomBand && below <= maxTop) return { top: below, left, side: 'below' };
  if (above >= minTop) return { top: above, left, side: 'above' };

  if (inBottomBand) return { top: clamp(above, minTop, maxTop), left, side: 'above' };
  const roomBelow = viewport.height - reserved.bottom - targetBottom;
  const roomAbove = target.top - reserved.top;
  return roomBelow >= roomAbove
    ? { top: clamp(below, minTop, maxTop), left, side: 'below' }
    : { top: clamp(above, minTop, maxTop), left, side: 'above' };
}

export interface AutoStartInput {
  tourKey: string;
  /** players.tours_seen: the server's record, across devices. */
  toursSeen: Record<string, unknown>;
  /** This device's record, kept in case the server write failed. */
  localSeen: boolean;
  pathname: string;
  /** Paths the tour may start on by itself, or '*' for any. */
  startPaths: readonly string[] | '*';
  /** Something else owns the screen (a waiver or deletion gate). */
  blocked: boolean;
  /** A replay asked for by URL. */
  forced: boolean;
}

/**
 * Whether the tour opens by itself. A replay wins over everything except a
 * blocking gate, which always wins: the tour must never sit on top of the
 * screen that says the rest of the app is closed.
 */
export function shouldAutoStart(input: AutoStartInput): boolean {
  if (input.blocked) return false;
  if (input.forced) return true;
  if (input.startPaths !== '*' && !input.startPaths.includes(input.pathname)) return false;
  if (Object.prototype.hasOwnProperty.call(input.toursSeen, input.tourKey)) return false;
  return !input.localSeen;
}
