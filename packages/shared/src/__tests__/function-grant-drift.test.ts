import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Every SECURITY DEFINER function this repo creates must revoke `anon` and
 * `authenticated` EXPLICITLY, not just `PUBLIC`.
 *
 * WHY THIS TEST EXISTS. Supabase ships
 *   ALTER DEFAULT PRIVILEGES IN SCHEMA public
 *     GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;
 * so a new function is born with EXPLICIT `anon=X` and `authenticated=X` ACL
 * entries. `REVOKE ... FROM PUBLIC` removes neither. The result reads as
 * "service role only" in the migration and is world-callable in the database.
 *
 * 00126 diagnosed this and fixed the functions that existed then. 00178-00185
 * reintroduced it across twelve new functions — including ones that take the
 * actor id as a parameter, which is an impersonation primitive the moment
 * `anon` can reach it. 00187 locked them. This test is what stops migration
 * 00188-and-onward doing it a third time, because the wrong form is the one
 * that looks correct on review.
 */

const MIGRATIONS_DIR = join(__dirname, '../../../../supabase/migrations');

/**
 * The rule is enforced from 00177 — the first migration of the 2026-08-28 audit
 * remediation, and this repo's baseline for "written knowing about the trap".
 */
const ENFORCED_FROM = '00176';

/**
 * KNOWN PRE-EXISTING DEBT, deliberately visible rather than hidden.
 *
 * These migrations pre-date the remediation and have the same defect: they
 * revoke only PUBLIC, so the functions they create are still executable by
 * `anon` on PRODUCTION TODAY.
 *
 * RE-MEASURED on the live production database 2026-08-28, because the earlier
 * figure recorded here (61 anon-executable, ~49 from these migrations) counted
 * TRIGGER FUNCTIONS, and a trigger function is not reachable by anybody —
 * Postgres refuses it with 0A000, "trigger functions can only be called as
 * triggers", verified by calling one as `anon`. Counting them inflated the
 * number by 17 and made the debt look worse than it is.
 *
 * The real shape, identical on prod and staging:
 *
 *   32  public functions anon can execute (excluding trigger functions)
 *    9  of those are SECURITY DEFINER — the only ones that escape the caller's
 *       own RLS and grants, and therefore the only ones that can be a hole
 *   23  run as the caller, so RLS still applies to everything they touch
 *
 * The nine: consume_discord_link_token, get_active_season, get_executives,
 * get_leaderboard, get_player_id, get_session_attendee_counts, is_admin,
 * is_admin_or_coach, session_checkin_open. Eight are reads that back public or
 * pre-login pages. consume_discord_link_token is the one mutator and was
 * checked specifically: 256-bit token, atomic single-use claim, and it refuses
 * a caller whose auth.uid() is NULL.
 *
 * They are NOT fixed by 00187, which is deliberately scoped to the twelve
 * functions the remediation itself created. Re-granting historical functions is
 * a behaviour change on a live app — some of these are anon-callable ON PURPOSE
 * (get_leaderboard, get_active_season, get_executives back public pages) and
 * telling them apart needs a per-function decision, not a sweep.
 *
 * The one that most deserves that decision is `consume_discord_link_token`
 * (00165): SECURITY DEFINER, anon-reachable, and it consumes a link token.
 *
 * Do not add to this list. A new entry means a new migration reintroduced the
 * bug; fix the migration instead.
 */
/**
 * The twelve functions created by 00178-00185 with the PUBLIC-only revoke, and
 * locked by 00187 instead.
 *
 * They are exempted BY NAME rather than by fixing the original files, because
 * 00177-00186 are already applied and recorded in public.schema_migrations with
 * their checksums. Editing an applied migration changes its checksum and the
 * F-012 preflight would report DRIFT on every environment — the runner is right
 * to treat that as tampering. A follow-up migration is the only correct repair
 * for an already-applied file.
 *
 * THIS LIST IS CLOSED. A thirteenth name here would mean a new migration
 * repeated the bug and someone silenced the guard instead of fixing it.
 */
const LOCKED_BY_00187 = new Set([
  // 00177 replaces a pre-existing function; CREATE OR REPLACE preserves the
  // original ACL, which 00126 had already stripped of anon. Verified on the
  // live database: apply_match_result :: postgres=X | authenticated=X | service_role=X
  'apply_match_result',
  'resolve_dispute_rated',
  'claim_dispute_for_resolution',
  'apply_placement_bonus',
  'merge_my_notification_preferences',
  'merge_notification_preferences_by_email',
  'issue_passkey_challenge',
  'consume_passkey_challenge',
  'create_challenge_atomic',
  'respond_to_challenge',
  'report_walkover_atomic',
  'reject_walkover_atomic',
  'enter_tournament_event',
]);

const KNOWN_PREEXISTING_DEBT = new Set([
  '00127', '00130', '00132', '00140', '00152',
  '00156', '00162', '00163', '00165', '00175',
]);

/**
 * Files exempt for a stated reason. Keep this list short and keep the reason
 * with it — an unexplained entry here is how the guard dies.
 */
const EXEMPT: Record<string, string> = {
  // 00187 IS the lock. It revokes anon/authenticated dynamically from the
  // catalogue rather than by literal signature, so the literal-text check
  // below cannot see it.
  '00187': 'the remediation itself; revokes dynamically via format() over pg_proc',
};

function migrationFiles(): string[] {
  return readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{5}_.*\.sql$/.test(f))
    .sort();
}

function versionOf(file: string): string {
  return file.slice(0, 5);
}

/** Function names created by a migration, e.g. CREATE OR REPLACE FUNCTION public.foo( */
function createdFunctions(sql: string): string[] {
  const names = new Set<string>();
  const re = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([a-z0-9_]+)\s*\(/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) names.add(m[1]!.toLowerCase());
  return [...names];
}

/**
 * A trigger function is never granted — it is invoked by the trigger, not by a
 * role — so it is not part of this rule. Detected by RETURNS TRIGGER.
 *
 * DETECTION IS PER STATEMENT, and it has to be. The obvious one-regex version
 * — `CREATE FUNCTION (name) ( [\s\S]*? RETURNS TRIGGER` — lets the lazy middle
 * run past the end of its own statement and pick up the RETURNS TRIGGER of a
 * LATER function in the same file. That mislabels in both directions, and the
 * dangerous direction is the quiet one: the earlier, ordinary function is
 * exempted from the anon-revoke check below, while the actual trigger function
 * is never reached by the scan and gets flagged instead. 00197 is exactly that
 * shape (delete_phase_matches, then a trigger function), and the guard was
 * silently not covering delete_phase_matches at all.
 *
 * So: split on the CREATE FUNCTION headers first, then ask each statement about
 * its own return type. A body can contain anything, but only the header — the
 * text before the AS $tag$ that opens the body — can carry the real RETURNS.
 */
function triggerFunctions(sql: string): Set<string> {
  const names = new Set<string>();
  const head = /CREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?([a-z0-9_]+)\s*\(/gi;
  const starts: Array<{ name: string; at: number }> = [];
  let m: RegExpExecArray | null;
  while ((m = head.exec(sql)) !== null) starts.push({ name: m[1]!.toLowerCase(), at: m.index });

  for (let i = 0; i < starts.length; i++) {
    const stmt = sql.slice(starts[i]!.at, starts[i + 1]?.at ?? sql.length);
    // Stop at the body opener so a `RETURNS TRIGGER` mentioned inside PL/pgSQL
    // (a comment, a nested CREATE in a DO block) cannot vote.
    const bodyAt = stmt.search(/\bAS\s+\$/i);
    const header = bodyAt === -1 ? stmt : stmt.slice(0, bodyAt);
    if (/\bRETURNS\s+TRIGGER\b/i.test(header)) names.add(starts[i]!.name);
  }
  return names;
}

/** Roles revoked from `fn` anywhere in this migration's REVOKE statements. */
function revokedRoles(sql: string, fn: string): Set<string> {
  const roles = new Set<string>();
  const re = new RegExp(
    String.raw`REVOKE\s+[\s\S]*?ON\s+FUNCTION\s+(?:public\.)?${fn}\s*\([\s\S]*?\)\s*FROM\s+([^;]+);`,
    'gi',
  );
  let m: RegExpExecArray | null;
  while ((m = re.exec(sql)) !== null) {
    for (const r of m[1]!.split(',')) roles.add(r.trim().toLowerCase());
  }
  return roles;
}

describe('function grant drift — anon must be revoked explicitly', () => {
  const files = migrationFiles()
    .filter((f) => versionOf(f) > ENFORCED_FROM)
    .filter((f) => !KNOWN_PREEXISTING_DEBT.has(versionOf(f)));

  it('finds migrations to check (guards against a broken glob)', () => {
    expect(files.length).toBeGreaterThan(5);
  });

  it('every function 00187 claims to lock is actually named in 00187', () => {
    const lock = readFileSync(join(MIGRATIONS_DIR, '00187_lock_new_function_grants.sql'), 'utf8');
    for (const fn of LOCKED_BY_00187) {
      // apply_match_result is exempt for a different reason (ACL preserved by
      // CREATE OR REPLACE), so 00187 does not and need not mention it.
      if (fn === 'apply_match_result') continue;
      expect(lock.includes(`'${fn}'`), `00187 does not mention ${fn}`).toBe(true);
    }
  });

  it('the pre-existing debt list is closed — no remediation migration may join it', () => {
    for (const version of KNOWN_PREEXISTING_DEBT) {
      expect(
        version < ENFORCED_FROM,
        `${version} is at or after the enforced baseline and must not be exempted`,
      ).toBe(true);
    }
  });

  for (const file of files) {
    const version = versionOf(file);
    if (EXEMPT[version]) continue;

    const sql = readFileSync(join(MIGRATIONS_DIR, file), 'utf8');
    const triggers = triggerFunctions(sql);
    const fns = createdFunctions(sql).filter((f) => !triggers.has(f));
    if (fns.length === 0) continue;

    it(`${file} revokes anon and authenticated from every function it creates`, () => {
      for (const fn of fns) {
        if (LOCKED_BY_00187.has(fn)) continue;
        const revoked = revokedRoles(sql, fn);
        // A function with no REVOKE at all is only acceptable when the migration
        // never granted it either — but a SECURITY DEFINER body always needs the
        // revoke, so treat the absence as the defect it is.
        expect(
          revoked.has('anon'),
          `public.${fn}() in ${file}: REVOKE does not name anon. ` +
            `REVOKE ... FROM PUBLIC does NOT remove Supabase's default anon grant — ` +
            `write "FROM PUBLIC, anon, authenticated". See 00126 and 00187.`,
        ).toBe(true);
        expect(
          revoked.has('authenticated'),
          `public.${fn}() in ${file}: REVOKE does not name authenticated. ` +
            `Grant it back explicitly afterwards if members are meant to call it.`,
        ).toBe(true);
      }
    });
  }
});
