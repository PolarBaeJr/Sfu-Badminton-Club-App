import { describe, expect, it } from 'vitest';
import { readSupabaseConfig } from '../lib/config';

describe('readSupabaseConfig', () => {
  it('accepts an https URL and a key, trimming a trailing slash', () => {
    expect(
      readSupabaseConfig({ EXPO_PUBLIC_SUPABASE_URL: ' https://db.example.invalid/ ', EXPO_PUBLIC_SUPABASE_ANON_KEY: 'k' }),
    ).toEqual({ ok: true, url: 'https://db.example.invalid', anonKey: 'k' });
  });

  it('keeps a path prefix', () => {
    const c = readSupabaseConfig({
      EXPO_PUBLIC_SUPABASE_URL: 'https://example.invalid/supabase',
      EXPO_PUBLIC_SUPABASE_ANON_KEY: 'k',
    });
    expect(c.ok && c.url).toBe('https://example.invalid/supabase');
  });

  it('names both variables when both are missing', () => {
    expect(readSupabaseConfig({})).toEqual({
      ok: false,
      missing: ['EXPO_PUBLIC_SUPABASE_URL', 'EXPO_PUBLIC_SUPABASE_ANON_KEY'],
    });
  });

  it('refuses plain http, which would carry the session tokens in the clear', () => {
    expect(
      readSupabaseConfig({ EXPO_PUBLIC_SUPABASE_URL: 'http://example.invalid', EXPO_PUBLIC_SUPABASE_ANON_KEY: 'k' }),
    ).toEqual({ ok: false, missing: ['EXPO_PUBLIC_SUPABASE_URL'] });
  });

  it('treats a blank key as missing', () => {
    expect(
      readSupabaseConfig({ EXPO_PUBLIC_SUPABASE_URL: 'https://example.invalid', EXPO_PUBLIC_SUPABASE_ANON_KEY: '   ' }),
    ).toEqual({ ok: false, missing: ['EXPO_PUBLIC_SUPABASE_ANON_KEY'] });
  });
});
