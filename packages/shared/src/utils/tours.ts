// THE GUIDED TOURS, by key. One member tour in the player app and one exec tour
// in the console, each versioned: a tour rewritten enough to be worth showing
// again ships under a new key (member_v2) and everybody sees it once more.
//
// The keys are also what mark_tour_seen() (00246) accepts, and it refuses
// anything not shaped `(member|exec)_v<n>`, so a key added here must keep that
// shape.
//
// Dependency-free, so a client component can import it deeply.

export const TOUR_KEYS = ['member_v1', 'exec_v1'] as const;

export type TourKey = (typeof TOUR_KEYS)[number];

export function isTourKey(value: unknown): value is TourKey {
  return typeof value === 'string' && (TOUR_KEYS as readonly string[]).includes(value);
}

/**
 * The localStorage key a device remembers a finished tour under. The two apps
 * share an origin in production, so they share one localStorage: the key is
 * namespaced, and it carries the app in the tour key itself (member_ in the
 * player app, exec_ in the console), so neither can silence the other.
 */
export function tourSeenStorageKey(key: TourKey): string {
  return `sfu-badminton:tour-seen:${key}`;
}
