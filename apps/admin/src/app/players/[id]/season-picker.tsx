'use client';

import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import { Select } from '@badminton/ui';
import { SEASON_TERMS } from '@badminton/shared';

export interface SeasonOption {
  id: string;
  term: string;
  year: number;
  active_flag: boolean;
}

// Two dropdowns rather than one list of season names: "Fall 2026" sorts before
// "Spring 2026" alphabetically, which is backwards, and a single list gets long
// fast. Term and year are separate columns as of 00043, so this picks them
// directly instead of parsing a label.
//
// State lives in the URL, not in React. The page is a server component that
// re-queries per season, so the selection has to survive a navigation — and it
// makes a particular season's view a link someone can share.
export function SeasonPicker({ seasons, selectedId }: { seasons: SeasonOption[]; selectedId: string | null }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();

  const selected = seasons.find((s) => s.id === selectedId) ?? null;
  const years = [...new Set(seasons.map((s) => s.year))].sort((a, b) => b - a);

  // Only terms that exist for the chosen year — offering "Summer" for a year
  // with no summer season just yields an empty page.
  const termsForYear = selected
    ? SEASON_TERMS.filter((t) => seasons.some((s) => s.year === selected.year && s.term === t.value))
    : [];

  function go(term: string, year: number) {
    const match = seasons.find((s) => s.term === term && s.year === year)
      // Changing year to one without the current term: fall back to that
      // year's first available term rather than navigating nowhere.
      ?? seasons.find((s) => s.year === year);
    if (!match) return;
    const next = new URLSearchParams(params.toString());
    next.set('season', match.id);
    router.push(`${pathname}?${next.toString()}`);
  }

  if (seasons.length === 0) return null;

  return (
    <div className="flex items-end gap-2">
      <Select
        label="Term"
        value={selected?.term ?? ''}
        options={termsForYear.map((t) => ({ value: t.value, label: t.label }))}
        onChange={(e) => selected && go(e.target.value, selected.year)}
      />
      <Select
        label="Year"
        value={selected ? String(selected.year) : ''}
        options={years.map((y) => ({ value: String(y), label: String(y) }))}
        onChange={(e) => selected && go(selected.term, Number(e.target.value))}
      />
    </div>
  );
}
