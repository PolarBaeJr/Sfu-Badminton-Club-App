import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

// A USER-SCOPED READ OF feedback_reports COMES BACK EMPTY, NOT BROKEN.
//
// 00172 revoked feedback_reports from anon and authenticated outright, so bug
// reports stay staff-only — the table grants nothing to `authenticated` and
// service_role is the only role with bypassrls. 00175 then folded the
// post-tournament survey INTO that table, and the survey is the one thing on it
// a signed-in member legitimately reads back (the form pre-fills with whatever
// they answered last time).
//
// So the hazard is specific and quiet: query feedback_reports with the
// request-scoped client and PostgREST returns an empty list with NO error. The
// form renders blank, the player re-submits, and nothing anywhere logs a
// failure. This already bit the tournament page once during the 00175 merge —
// the read was left on `supabase` and looked fine in every test that ran as
// superuser, because superuser bypasses grants.
//
// Reading the source as text is crude and deliberate: the failure has no
// runtime signal to assert on, so the only place to catch it is the call site.

const SRC = join(__dirname, '../..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    // This file names the table and the client in the same breath; scanning it
    // would make the guard check its own prose.
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full);
    return /\.tsx?$/.test(entry.name) ? [full] : [];
  });
}

describe('feedback_reports is only ever read with the service role', () => {
  it('has no request-scoped query of feedback_reports', () => {
    const offenders: string[] = [];
    const SERVICE_FACTORIES = /(createServiceRoleClient|createAdminClient)\(\)/;

    for (const file of sourceFiles(SRC)) {
      const raw = readFileSync(file, 'utf8');
      if (!raw.includes("from('feedback_reports')")) continue;

      // Strip comments before anything else. Two call sites carry an
      // explanatory comment between the client and `.from(`, and without this
      // the scan below reads the prose as the receiver.
      const text = raw.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

      // Which local bindings hold a service-role client. The call sites mostly
      // go through `const supabase = createServiceRoleClient()` rather than
      // calling the factory inline, so a receiver name has to be resolved
      // rather than pattern-matched.
      const serviceBindings = new Set<string>();
      for (const bind of text.matchAll(
        /(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:await\s+)?(createServiceRoleClient|createAdminClient)\(\)/g,
      )) {
        if (bind[1]) serviceBindings.add(bind[1]);
      }

      for (const match of text.matchAll(/([A-Za-z0-9_$]+(?:\(\))?)\s*\.from\('feedback_reports'\)/g)) {
        const receiver = match[1];
        if (!receiver) continue;
        const ok = SERVICE_FACTORIES.test(receiver) || serviceBindings.has(receiver);
        if (!ok) offenders.push(`${file.slice(SRC.length + 1)} :: ${receiver}.from('feedback_reports')`);
      }
    }

    expect(offenders).toEqual([]);
  });
});
