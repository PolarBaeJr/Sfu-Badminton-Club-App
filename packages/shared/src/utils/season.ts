// The three terms the club runs, ordered to match the ACADEMIC year: at a
// university the year starts in September, so Fall 2026 precedes Spring 2027.
// Mirrors the season_term enum added in 00043 — the enum's declaration order is
// what ORDER BY uses in SQL, and this is the same order for the UI.
export const SEASON_TERMS = [
  { value: 'fall', label: 'Fall' },
  { value: 'spring', label: 'Spring' },
  { value: 'summer', label: 'Summer' },
] as const;

export type SeasonTerm = (typeof SEASON_TERMS)[number]['value'];

export function formatSeasonLabel(term: string | null | undefined, year: number | null | undefined): string {
  const t = SEASON_TERMS.find((s) => s.value === term)?.label;
  if (!t || !year) return 'Unknown season';
  return `${t} ${year}`;
}
