// Deno cannot import the npm workspace — keep in sync with packages/shared/src/utils/constants.ts
// Ladder is 400-nominal (see packages/shared). Season compression regresses
// ratings toward this baseline, so it MUST be 400 — 1200 drifted everyone up.
export const DEFAULT_ELO = 400;
// Fallback only — expire-walkover-pending reads
// platform_settings.walkover_rules.admin_review_window_hours and uses this
// value only when that row is missing or unparseable.
export const WALKOVER_REVIEW_HOURS = 48;
export const INACTIVITY_DAYS = 45;
