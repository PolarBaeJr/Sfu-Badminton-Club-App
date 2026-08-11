// The reading order of the /ratings screen: which platform_settings field
// appears under which heading, and in what order.
//
// EVERY SECTION HERE IS BACKED BY A KEY THAT EXISTS. The screen's design asked
// for sections this database has no home for — a single K-factor (there are
// four), a per-match-type weight table (the weights are IMMUTABLE SQL, not
// settings), "show provisional ratings" and rating decay (no such key, no such
// code). Those are not rendered rather than rendered empty, because a control
// that saves nowhere is worse than an absent one: it reads as configuration
// and behaves as decoration. See 00041, which is this codebase's own record of
// six such controls sitting in the console doing nothing for months.
//
// Deliberately dependency-free — imported by a server page, a client component
// and the tests.
import { FIELD_META } from './platform-setting-fields';

export interface RatingsSectionDef {
  /** Anchor id, and the rail entry's href. */
  id: string;
  /** Mono uppercase heading, and the rail label. */
  label: string;
  /** Editable fields, in render order. Empty for a reference section. */
  fields: { key: string; field: string }[];
  /**
   * A section with nothing to save — the engine constants, shown so the page
   * can tell the truth about what it does NOT control.
   */
  reference?: true;
}

export const RATINGS_SECTIONS: RatingsSectionDef[] = [
  {
    id: 'formula',
    label: 'The formula',
    fields: [
      { key: 'rating_defaults', field: 'default_elo' },
      { key: 'rating_defaults', field: 'min_elo' },
      { key: 'rating_defaults', field: 'max_elo' },
      { key: 'rating_defaults', field: 'sweep_margin_multiplier' },
    ],
  },
  {
    id: 'k-factors',
    label: 'K-factors',
    fields: [
      { key: 'rating_defaults', field: 'singles_k_provisional' },
      { key: 'rating_defaults', field: 'singles_k_established' },
      { key: 'rating_defaults', field: 'doubles_k_provisional' },
      { key: 'rating_defaults', field: 'doubles_k_established' },
    ],
  },
  {
    id: 'new-members',
    label: 'New members',
    fields: [{ key: 'rating_defaults', field: 'provisional_threshold' }],
  },
  {
    id: 'match-weighting',
    label: 'Match weighting',
    fields: [],
    reference: true,
  },
  {
    id: 'tournament-bonuses',
    label: 'Tournament bonuses',
    fields: [
      { key: 'tournament_bonuses', field: 'enabled' },
      { key: 'tournament_bonuses', field: 'singles_champion' },
      { key: 'tournament_bonuses', field: 'singles_finalist' },
      { key: 'tournament_bonuses', field: 'singles_semifinalist' },
      { key: 'tournament_bonuses', field: 'singles_quarterfinalist' },
      { key: 'tournament_bonuses', field: 'doubles_champion' },
      { key: 'tournament_bonuses', field: 'doubles_finalist' },
      { key: 'tournament_bonuses', field: 'doubles_semifinalist' },
      { key: 'tournament_bonuses', field: 'doubles_quarterfinalist' },
    ],
  },
  {
    id: 'season-reset',
    label: 'Season reset',
    fields: [
      { key: 'season_settings', field: 'soft_compression_enabled' },
      { key: 'season_settings', field: 'compression_factor' },
      { key: 'season_settings', field: 'tier_size' },
    ],
  },
];

/** Every `key.field` this page has a place for. */
const PLACED: ReadonlySet<string> = new Set(
  RATINGS_SECTIONS.flatMap((s) => s.fields.map((f) => `${f.key}.${f.field}`))
);

export function isPlaced(key: string, field: string): boolean {
  return PLACED.has(`${key}.${field}`);
}

function isScalar(v: unknown): boolean {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

export interface Leftovers {
  /**
   * Scalar fields on a key this page knows, that no section above claims —
   * a knob added to rating_defaults by a migration nobody wired into the
   * layout. Rendered generically rather than dropped.
   */
  fields: { key: string; field: string }[];
  /**
   * Whole rows this page cannot lay out at all: a key with no field metadata,
   * or one whose values are not scalars. Rendered as raw JSON, exactly as the
   * generic form does, so a new platform_settings row can never vanish from
   * the console with no error anywhere.
   */
  rawKeys: string[];
}

/**
 * What the hand-written layout above would otherwise swallow.
 *
 * The generic form's whole safety property is that an unrecognised row still
 * renders. A fixed field list gives that up unless it also reports what it did
 * not place — which is what this returns.
 */
export function leftoversFor<T extends { key: string; value: Record<string, unknown> }>(
  rows: T[]
): Leftovers {
  const fields: { key: string; field: string }[] = [];
  const rawKeys: string[] = [];

  for (const row of rows) {
    const meta = FIELD_META[row.key];
    const layoutable = meta && Object.entries(row.value).every(([f, v]) => meta[f] && isScalar(v));
    if (!layoutable) {
      rawKeys.push(row.key);
      continue;
    }
    for (const field of Object.keys(row.value)) {
      if (!isPlaced(row.key, field)) fields.push({ key: row.key, field });
    }
  }

  return { fields, rawKeys };
}
