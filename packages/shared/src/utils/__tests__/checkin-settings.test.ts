import { describe, it, expect } from 'vitest';
import { parseCheckinSettings, FALLBACK_CHECKIN_SETTINGS } from '../session-window';

// parseCheckinSettings has to reproduce session_checkin_open()'s coercion of
// the platform_settings 'session_attendance' row exactly
// (00008_richer_attendance.sql:56-58):
//
//   v_opens_minutes    := (v_settings->>'checkin_opens_minutes_before')::int;
//   v_duration_minutes := COALESCE((v_settings->>'default_duration_minutes')::int, 120);
//
// Any divergence puts the client's rendered window out of step with the RLS
// gate, which is the bug class this whole helper exists to close.
describe('parseCheckinSettings', () => {
  it('reads both values from a well-formed row', () => {
    expect(parseCheckinSettings({ default_duration_minutes: 60, checkin_opens_minutes_before: 30 })).toEqual({
      defaultDurationMinutes: 60,
      opensMinutesBefore: 30,
    });
  });

  it('treats an explicit null opens-before as "no opening edge"', () => {
    const s = parseCheckinSettings({ default_duration_minutes: 90, checkin_opens_minutes_before: null });
    expect(s.opensMinutesBefore).toBeNull();
    expect(s.defaultDurationMinutes).toBe(90);
  });

  it('falls back to 120 for a missing duration, matching the SQL COALESCE', () => {
    expect(parseCheckinSettings({ checkin_opens_minutes_before: 30 }).defaultDurationMinutes).toBe(120);
  });

  it('yields no opening edge when the key is absent, matching NULL::int in SQL', () => {
    expect(parseCheckinSettings({ default_duration_minutes: 60 }).opensMinutesBefore).toBeNull();
  });

  // A missing row leaves v_settings NULL in the SQL, so both coercions take
  // their null path. The whole-row-absent case must land in the same place.
  it.each([[null], [undefined], [{}]])('handles an absent row (%p) like the DB does', (value) => {
    expect(parseCheckinSettings(value)).toEqual({ defaultDurationMinutes: 120, opensMinutesBefore: null });
  });

  it('rejects unparseable values rather than propagating NaN', () => {
    const s = parseCheckinSettings({ default_duration_minutes: 'soon', checkin_opens_minutes_before: 'early' });
    expect(s.defaultDurationMinutes).toBe(120);
    expect(s.opensMinutesBefore).toBeNull();
  });

  it('accepts numeric strings, since jsonb ->> yields text before ::int', () => {
    expect(parseCheckinSettings({ default_duration_minutes: '60', checkin_opens_minutes_before: '30' })).toEqual({
      defaultDurationMinutes: 60,
      opensMinutesBefore: 30,
    });
  });

  // The fallback deliberately differs from the missing-row parse: it is a
  // snapshot of what prod is configured to, not what the DB does with no row.
  it('is deliberately distinct from the missing-row result', () => {
    expect(FALLBACK_CHECKIN_SETTINGS).not.toEqual(parseCheckinSettings(null));
  });
});
