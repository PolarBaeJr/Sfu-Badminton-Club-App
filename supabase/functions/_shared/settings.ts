// Deno cannot import the npm workspace — keep in sync with
// packages/shared/src/utils/tournament-bonuses.ts (settingNumber), which is the
// tested copy of this coercion.
//
// Edge functions had been reading platform_settings ad hoc, e.g.
// mark-inactive-players:
//     (setting?.value as Record<string, number>)?.x ?? CONST
// That is not defensive enough for an admin-editable JSONB blob: a stored
// string sails straight through to NaN, and a stored null resolves to null ??
// CONST = CONST only by luck of `??` — any code doing `?? 0` or `Number(...)`
// would silently produce 0. Route new reads through this helper instead.

// deno-lint-ignore no-explicit-any
type SettingsReader = { from: (table: string) => any };

/**
 * Coerce one JSONB scalar to a non-negative number, falling back when absent,
 * null, or unparseable. An explicit 0 is honoured; `Number(null)`,
 * `Number('')` and `Number([])` are all 0 and must NOT be.
 */
export function settingNumber(value: unknown, fallback: number): number {
  if (typeof value === 'number') {
    return Number.isFinite(value) && value >= 0 ? value : fallback;
  }
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    return Number.isFinite(n) && n >= 0 ? n : fallback;
  }
  return fallback;
}

/**
 * Read one numeric field out of a platform_settings section.
 *
 * Any failure — query error, missing row, missing field, garbage value — lands
 * on `fallback`, which callers pass as the hardcoded constant from
 * _shared/constants.ts. A cron function must never widen or collapse its own
 * window because a settings row was malformed.
 */
export async function getPlatformSettingNumber(
  supabase: SettingsReader,
  key: string,
  field: string,
  fallback: number,
): Promise<number> {
  try {
    const { data, error } = await supabase
      .from('platform_settings')
      .select('value')
      .eq('key', key)
      .maybeSingle();
    if (error) return fallback;
    const row = (data?.value ?? {}) as Record<string, unknown>;
    return settingNumber(row[field], fallback);
  } catch {
    return fallback;
  }
}
