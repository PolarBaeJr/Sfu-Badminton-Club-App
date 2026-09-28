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
  /**
   * The page the step is shown on, app-relative (no base path) and concrete
   * (no `[param]`). A step without one stays on the page the step before it
   * used, and the first step on the page the tour was opened on.
   */
  href?: string;
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

/**
 * The part of a spotlight that is on screen, between the top of the viewport
 * (less `reserved.top`) and the bottom band. A table taller than the screen is
 * cut to what is visible, so the card is placed against that. A target that
 * starts inside the bottom band (the tab bar itself) is cut at the screen's
 * edge instead, or it would vanish. Null when none of it is on screen.
 */
export function clampRectToViewport(
  rect: TourRect,
  viewport: { width: number; height: number },
  reserved: { top: number; bottom: number },
): TourRect | null {
  const band = viewport.height - reserved.bottom;
  const top = Math.max(rect.top, reserved.top);
  const bottom = Math.min(rect.top + rect.height, rect.top >= band ? viewport.height : band);
  if (bottom <= top) return null;
  return { top, left: rect.left, width: rect.width, height: bottom - top };
}

// NAVIGATION. A step can name a page; the component opens it through the host's
// router and waits for it. Every decision about that wait is here.

/** How long a page may take to open before its step is skipped. Long, because the Pi renders on one thread. */
export const TOUR_NAV_TIMEOUT_MS = 10000;
/** How long a step waits for its target to appear once its page is open. */
export const TOUR_TARGET_TIMEOUT_MS = 3000;

/**
 * An app-relative path: the base path removed (only as a whole segment, so
 * `/admin` never strips `/administer`), the query and hash dropped, and no
 * trailing slash. The root is `/`.
 */
export function stripBasePath(path: string, basePath: string): string {
  let p = path.split(/[?#]/)[0] ?? '';
  const base = basePath.replace(/\/+$/, '');
  if (base && (p === base || p.startsWith(`${base}/`))) p = p.slice(base.length);
  p = p.replace(/\/+$/, '');
  return p === '' ? '/' : p;
}

const segments = (path: string) => path.split('/').filter(Boolean);

/**
 * Whether a pathname is on a step's page. A `[name]` segment in the pattern
 * matches any one segment.
 */
export function pathMatches(pathname: string, pattern: string, basePath = ''): boolean {
  const have = segments(stripBasePath(pathname, basePath));
  const want = segments(stripBasePath(pattern, basePath));
  if (have.length !== want.length) return false;
  return want.every((seg, i) => /^\[[^\]]+\]$/.test(seg) || seg === have[i]);
}

/** The page each step is shown on: its own href, else the one before it, else where the tour started. */
export function effectiveRoutes(steps: readonly TourStep[], startPath: string): string[] {
  let previous = startPath;
  return steps.map((step) => (previous = step.href ?? previous));
}

export interface RouteDecisionInput {
  route: string;
  pathname: string;
  basePath: string;
  /** The navigation this step started, or null if it has not started one. */
  nav: null | { fromPath: string; arrived: boolean; elapsedMs: number };
  timeoutMs: number;
}

/**
 * What a step does about its page. On it: ready. Not on it and not yet asked
 * for: navigate. Asked for and then left (a redirect after a loading screen),
 * or landed somewhere else: skip. Still where it started after the time limit
 * (a redirect back to the page it came from never changes the path): skip.
 */
export function routeDecision(input: RouteDecisionInput): 'ready' | 'navigate' | 'wait' | 'skip' {
  const { route, pathname, basePath, nav, timeoutMs } = input;
  if (pathMatches(pathname, route, basePath)) return 'ready';
  if (nav === null) return 'navigate';
  if (nav.arrived) return 'skip';
  if (stripBasePath(pathname, basePath) !== stripBasePath(nav.fromPath, basePath)) return 'skip';
  if (nav.elapsedMs >= timeoutMs) return 'skip';
  return 'wait';
}

/**
 * What a step does about its target once its page is open. A step with
 * nothing to point at is a centred card at once; otherwise it waits for its
 * target, and when time runs out it is a card or it is skipped, as it says.
 */
export function targetDecision(input: {
  hasTargets: boolean;
  found: boolean;
  elapsedMs: number;
  timeoutMs: number;
  missingTarget: 'skip' | 'center';
}): 'found' | 'wait' | 'center' | 'skip' {
  if (!input.hasTargets) return 'center';
  if (input.found) return 'found';
  if (input.elapsedMs < input.timeoutMs) return 'wait';
  return input.missingTarget;
}

/**
 * The step to try after one is skipped, in the direction the reader was
 * moving. Forward past the end finishes. Back past the front goes forward
 * again from the step the reader pressed Back on (`backOrigin`).
 */
export function skipTo(input: {
  index: number;
  direction: 1 | -1;
  length: number;
  backOrigin: number | null;
}): { index: number; direction: 1 | -1 } | 'finish' {
  const next = input.index + input.direction;
  if (next >= input.length) return 'finish';
  if (next >= 0) return { index: next, direction: input.direction };
  const origin = input.backOrigin ?? input.index;
  if (origin >= input.length) return 'finish';
  return { index: origin, direction: 1 };
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
