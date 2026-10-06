import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// 00280 and 00281 read as text. Neither has run against a database in CI, so
// these pin the lines whose loss would be silent: a service-role twin that a
// browser key could reach acts as ANY member, and a draft table readable by
// `authenticated` hands out strangers' email addresses. Run turbo with --force:
// a cached pass does not re-read the migrations.

const MIGRATIONS = join(__dirname, '../../../../../supabase/migrations');
const strip = (sql: string) => sql.replace(/--[^\n]*/g, '');
const challenges = strip(readFileSync(join(MIGRATIONS, '00280_challenges_from_discord.sql'), 'utf8'));
const signup = strip(readFileSync(join(MIGRATIONS, '00281_discord_signup_drafts.sql'), 'utf8'));
const collapse = (sql: string) => sql.replace(/\s+/g, ' ');

describe('00280: challenges from Discord', () => {
  for (const name of ['create_challenge_for', 'submit_match_result_for']) {
    it(`${name} is service-role only`, () => {
      const flat = collapse(challenges);
      expect(flat).toMatch(new RegExp(`REVOKE ALL ON FUNCTION public\\.${name}\\([^)]*\\) FROM PUBLIC, anon, authenticated;`));
      expect(flat).toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\) TO service_role;`));
      expect(flat).not.toMatch(new RegExp(`GRANT EXECUTE ON FUNCTION public\\.${name}\\([^)]*\\) TO [^;]*(anon|authenticated)`));
    });
  }

  it('bounds the duration to 1 to 300 minutes', () => {
    expect(collapse(challenges)).toContain('duration_minutes IS NULL OR duration_minutes BETWEEN 1 AND 300');
  });

  it('offers no expiry parameter', () => {
    expect(challenges).not.toContain('p_expires_in_hours');
  });

  it('keeps the member functions on their member grants', () => {
    const flat = collapse(challenges);
    expect(flat).toMatch(/GRANT EXECUTE ON FUNCTION public\.create_challenge_atomic\([^)]*\) TO authenticated/);
    expect(flat).toMatch(/GRANT EXECUTE ON FUNCTION public\.submit_match_result\([^)]*\) TO authenticated/);
  });
});

describe('00281: Discord sign-up drafts', () => {
  for (const table of ['discord_signup_drafts', 'discord_signup_attempts']) {
    it(`${table} has RLS on, no policy, and nothing for anon or authenticated`, () => {
      expect(signup).toContain(`ALTER TABLE public.${table} ENABLE ROW LEVEL SECURITY;`);
      expect(signup).toContain(`REVOKE ALL ON TABLE public.${table} FROM PUBLIC, anon, authenticated;`);
      expect(signup).not.toMatch(new RegExp(`GRANT [^;]* ON TABLE public\\.${table} TO [^;]*(anon|authenticated)`));
    });
  }

  it('declares no policy and no foreign key', () => {
    expect(signup).not.toMatch(/CREATE POLICY/i);
    // The quoted 'REFERENCES' in the verify block is a privilege name, not a key.
    expect(signup).not.toMatch(/(?<!')REFERENCES\s+(public\.)?\w+/i);
  });

  it('tells "Open events only" apart from unanswered', () => {
    expect(signup).toMatch(/gender_answered\s+boolean NOT NULL DEFAULT false/);
    expect(signup).toMatch(/competition_category IS NULL OR competition_category IN \('mens', 'womens'\)/);
  });

  it('expires a draft after thirty minutes', () => {
    expect(signup).toMatch(/expires_at\s+timestamptz NOT NULL DEFAULT now\(\) \+ interval '30 minutes'/);
  });
});
