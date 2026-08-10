import { describe, it, expect } from 'vitest';
import { CAPABILITIES, EXEC_BASELINE, TRAINER_BASELINE, UNRESTRICTED, permits, type Capability } from '../permissions';

// THE CAPABILITY-EQUIVALENCE PROOF.
//
// Portfolios could only narrow, so "this can never widen anyone" used to be a
// property of the mechanism. Capabilities are a set, and a set can gain a
// member — so that property is GONE, and this table is the thing that replaces
// it. The route matrix in ./permissions.test.ts is not enough on its own: it
// proves which SECTIONS open, and access is now decided per action.
//
// WRITTEN OUT BY HAND, one row per capability, and the third column is not
// reasoning about names — it is a transcription of WHICH GATE FUNCTION STOOD AT
// THAT CALL SITE before capabilities existed:
//
//   getExecOrAdmin(…)               admin ✓ exec ✓ trainer ✗
//   getAdminPlayer() /
//     getAuthenticatedAdmin()       admin ✓ exec ✗ trainer ✗
//   getAuthenticatedExecOrAdmin(…)  admin ✓ exec ✓ trainer ✗   (page reads)
//   SECTION_ACCESS 'exec'           admin ✓ exec ✓ trainer ✗   (route-only reads)
//   SECTION_ACCESS 'admin'          admin ✓ exec ✗ trainer ✗
//   SECTION_ACCESS 'trainer'        admin ✓ exec ✓ trainer ✓
//   isAdmin-gated fetch             admin ✓ exec ✗ trainer ✗
//
// Deriving this table from EXEC_BASELINE would make it pass by construction and
// prove nothing at all. It is deliberately a second, independent write-down of
// the same fact, and the last assertion in this file is the two of them being
// compared.
//
// WHEN `<area>.page` SPLIT OFF FROM `<area>.read`, fourteen rows were RENAMED
// and two were added — and not one existing row's admin/exec/trainer answer
// moved. That is the whole claim of that change and this is where it is checked:
// a page key that used to be a read gates the same door it always gated, and the
// two new keys (fees.page, platform.page) name doors that already existed and
// take the answers those doors already gave.

type Row = {
  capability: Capability;
  admin: boolean;
  exec: boolean;
  trainer: boolean;
  /** The gate that stood here before. */
  was: string;
};

const T = true;
const F = false;

const TODAY: Row[] = [
  // ---- players ---------------------------------------------------------
  { capability: 'players.page',                        admin: T, exec: T, trainer: T, was: "SECTION_ACCESS['/players'] = 'trainer'" },
  { capability: 'players.approve.write',               admin: T, exec: T, trainer: F, was: "getExecOrAdmin('internal') — players.ts:27" },
  { capability: 'players.create.write',                admin: T, exec: T, trainer: F, was: "getExecOrAdmin('internal') — players.ts:95" },
  { capability: 'players.update.write',                admin: T, exec: T, trainer: F, was: "getExecOrAdmin('internal') — players.ts:152" },
  { capability: 'players.waiver.resign.write',         admin: T, exec: T, trainer: F, was: "getExecOrAdmin('internal') — players.ts:299" },
  { capability: 'players.ban.write',                   admin: T, exec: T, trainer: F, was: "getExecOrAdmin('internal') — reinstatement.ts:26" },
  { capability: 'players.reinstate.write',             admin: T, exec: T, trainer: F, was: "getExecOrAdmin('internal') — reinstatement.ts:54" },
  // The one gate that admitted a trainer: getConsoleUser() composed by hand
  // with portfolioPermits(…, 'internal').
  { capability: 'players.editor.varsitynotes.write',   admin: T, exec: T, trainer: T, was: 'getVarsityAuthor() — varsity.ts:35' },
  { capability: 'players.deletion.cancel.write',       admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — players.ts:261' },
  { capability: 'players.remove.write',                admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — players.ts:340' },
  { capability: 'players.merge.write',                 admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — players.ts:387, 404' },
  { capability: 'players.reliability.write',           admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — reliability.ts:11' },
  { capability: 'players.privilegedfields.write',      admin: T, exec: F, trainer: F, was: 'ADMIN_ONLY_PLAYER_FIELDS — player-field-access.ts' },

  // ---- seasons ---------------------------------------------------------
  { capability: 'seasons.page',                        admin: T, exec: T, trainer: F, was: "getAuthenticatedExecOrAdmin('internal') — seasons/page.tsx:16" },
  { capability: 'seasons.create.write',                admin: T, exec: T, trainer: F, was: "getExecOrAdmin('internal') — seasons.ts:18" },
  { capability: 'seasons.activate.write',              admin: T, exec: T, trainer: F, was: "getExecOrAdmin('internal') — seasons.ts:88" },
  { capability: 'seasons.end.write',                   admin: T, exec: T, trainer: F, was: "getExecOrAdmin('internal') — seasons.ts:112" },
  { capability: 'seasons.fees.write',                  admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — seasons.ts:54' },

  // ---- sessions --------------------------------------------------------
  { capability: 'sessions.page',                       admin: T, exec: T, trainer: F, was: "SECTION_ACCESS['/sessions'] = 'exec'" },
  { capability: 'sessions.reminders.write',            admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — sessions.ts:44" },
  { capability: 'sessions.create.write',               admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — sessions.ts:61" },
  { capability: 'sessions.update.write',               admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — sessions.ts:147" },
  { capability: 'sessions.archive.write',              admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — sessions.ts:181" },
  { capability: 'sessions.checkin.token.write',        admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — sessions.ts:216, 254" },
  { capability: 'sessions.attendance.write',           admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — sessions.ts:284, 329" },
  { capability: 'sessions.delete.write',               admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — sessions.ts:365" },

  // ---- matches ---------------------------------------------------------
  { capability: 'matches.page',                        admin: T, exec: T, trainer: F, was: "SECTION_ACCESS['/matches'] = 'exec'" },
  { capability: 'matches.void.write',                  admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — matches.ts:28" },
  { capability: 'matches.convert.write',               admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — matches.ts:68" },
  { capability: 'matches.create.write',                admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — matches.ts:212" },

  // ---- challenges ------------------------------------------------------
  // Both live in actions/matches.ts, and both stood behind getAdminPlayer().
  // Filing them under `matches` would have handed them to every exec.
  { capability: 'challenges.page',                     admin: T, exec: F, trainer: F, was: "SECTION_ACCESS['/challenges'] = 'admin'" },
  { capability: 'challenges.create.write',             admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — matches.ts:386' },
  { capability: 'challenges.expire.write',             admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — matches.ts:464' },

  // ---- announcements ---------------------------------------------------
  { capability: 'announcements.page',                  admin: T, exec: T, trainer: F, was: "SECTION_ACCESS['/announcements'] = 'exec'" },
  { capability: 'announcements.create.write',          admin: T, exec: T, trainer: F, was: "getExecOrAdmin('external') — announcements.ts:69" },
  { capability: 'announcements.update.write',          admin: T, exec: T, trainer: F, was: "getExecOrAdmin('external') — announcements.ts:137" },
  { capability: 'announcements.delete.write',          admin: T, exec: T, trainer: F, was: "getExecOrAdmin('external') — announcements.ts:189" },

  // ---- tournaments · manage --------------------------------------------
  { capability: 'tournaments.page',                    admin: T, exec: T, trainer: F, was: "getAuthenticatedExecOrAdmin('tournaments') — tournaments/[id]/page.tsx:18" },
  { capability: 'tournaments.manage.create.write',     admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — tournaments.ts:24" },
  { capability: 'tournaments.manage.update.write',     admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — tournaments.ts:129" },
  { capability: 'tournaments.manage.status.write',     admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — tournaments.ts:68" },
  { capability: 'tournaments.manage.suspend.write',    admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — tournaments.ts:167" },
  { capability: 'tournaments.manage.resume.write',     admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — tournaments.ts:198" },
  { capability: 'tournaments.manage.archive.write',    admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — tournaments.ts:225" },
  { capability: 'tournaments.manage.delete.write',     admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — tournaments.ts:249" },
  { capability: 'tournaments.manage.event.create.write', admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — events.ts:84" },
  { capability: 'tournaments.manage.event.update.write', admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — events.ts:139" },
  { capability: 'tournaments.manage.event.delete.write', admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — events.ts:219" },
  { capability: 'tournaments.manage.event.status.write', admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — events.ts:243" },

  // ---- tournaments · draw ----------------------------------------------
  { capability: 'tournaments.draw.participants.add.write',    admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — participants.ts:25, 117; tournaments.ts:273" },
  { capability: 'tournaments.draw.participants.remove.write', admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — participants.ts:302; tournaments.ts:310" },
  { capability: 'tournaments.draw.checkin.token.write',       admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — tournament-checkin.ts:24, 59" },
  { capability: 'tournaments.draw.checkin.mark.write',        admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — participants.ts:335, 629, 700" },
  { capability: 'tournaments.draw.noshow.write',              admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — participants.ts:369, 669" },
  { capability: 'tournaments.draw.exit.write',                admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — participants.ts:427" },
  { capability: 'tournaments.draw.pairs.add.write',           admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — participants.ts:534" },
  { capability: 'tournaments.draw.pairs.remove.write',        admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — participants.ts:604" },
  { capability: 'tournaments.draw.seed.set.write',            admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — seeding.ts:10, 35" },
  { capability: 'tournaments.draw.seed.auto.write',           admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — seeding.ts:60" },
  { capability: 'tournaments.draw.seed.clear.write',          admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — seeding.ts:115" },
  { capability: 'tournaments.draw.generate.write',            admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — brackets.ts:363, 664" },
  { capability: 'tournaments.draw.lock.write',                admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — brackets.ts:796" },
  { capability: 'tournaments.draw.unlock.write',              admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — brackets.ts:822" },

  // ---- tournaments · results -------------------------------------------
  { capability: 'tournaments.results.enter.write',        admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — results.ts:241" },
  { capability: 'tournaments.results.walkover.write',     admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — results.ts:446" },
  { capability: 'tournaments.results.void.write',         admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — results.ts:515" },
  { capability: 'tournaments.results.unvoid.write',       admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — results.ts:709" },
  { capability: 'tournaments.results.undo.write',         admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — results.ts:1169" },
  { capability: 'tournaments.results.edit.write',         admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — results.ts:933" },
  { capability: 'tournaments.results.entry.write',        admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — results.ts:796" },
  { capability: 'tournaments.results.doublenoshow.write', admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — results.ts:606" },
  { capability: 'tournaments.results.bonuses.write',      admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — finalize.ts:85" },
  { capability: 'tournaments.results.standings.write',    admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — finalize.ts:506" },
  { capability: 'tournaments.results.finalize.write',     admin: T, exec: T, trainer: F, was: "getExecOrAdmin('tournaments') — finalize.ts:516" },

  // ---- tournaments · fees ----------------------------------------------
  // The one admin-only sub-route under an exec-allowed section. Entry money was
  // never exec work and it still is not.
  { capability: 'tournaments.fees.read',              admin: T, exec: F, trainer: F, was: 'getAuthenticatedAdmin() + ADMIN_ONLY_PATTERNS — tournaments/[id]/fees/page.tsx' },
  { capability: 'tournaments.fees.tier.create.write', admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — tournament-fees.ts:86' },
  { capability: 'tournaments.fees.tier.update.write', admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — tournament-fees.ts:143' },
  { capability: 'tournaments.fees.tier.delete.write', admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — tournament-fees.ts:192' },
  { capability: 'tournaments.fees.markpaid.write',    admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — tournament-fees.ts:218' },
  { capability: 'tournaments.fees.markunpaid.write',  admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — tournament-fees.ts:294' },

  // ---- fees ------------------------------------------------------------
  // The exec rows in this whole area are the club owner's "allow execs to add
  // expenses too", and nothing else on the page ever was.
  //
  // fees.page is one of the two capabilities in this table with no predecessor
  // to transcribe, because /fees was the one section whose page key did not
  // already exist under a `.read` name. Its exec answer is not a judgement: an
  // exec reaches /fees today, so an exec holds the key that admits them, or this
  // change would have taken the Expenses tab away from every exec in the club.
  { capability: 'fees.page',                          admin: T, exec: T, trainer: F, was: "SECTION_ACCESS['/fees'] = 'exec' — the route an exec already reaches" },
  { capability: 'fees.expenses.read',                 admin: T, exec: T, trainer: F, was: "getAuthenticatedExecOrAdmin('finance') — fees/page.tsx:59" },
  { capability: 'fees.expenses.add.write',            admin: T, exec: T, trainer: F, was: "getExecOrAdmin('finance') — finance.ts:171" },
  { capability: 'fees.expenses.update.write',         admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — finance.ts:247' },
  { capability: 'fees.expenses.reimburse.write',      admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — finance.ts:365' },
  { capability: 'fees.expenses.remove.write',         admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — finance.ts:420' },
  { capability: 'fees.otherincome.read',              admin: T, exec: F, trainer: F, was: 'isAdmin fetch — fees/page.tsx:251' },
  { capability: 'fees.otherincome.add.write',         admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — finance.ts:89' },
  { capability: 'fees.otherincome.remove.write',      admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — finance.ts:122' },
  { capability: 'fees.clubfees.read',                 admin: T, exec: F, trainer: F, was: 'isAdmin fetch — fees/page.tsx:141, 145, 157' },
  { capability: 'fees.clubfees.markpaid.write',       admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — fees.ts:57' },
  { capability: 'fees.clubfees.markunpaid.write',     admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — fees.ts:219' },
  { capability: 'fees.clubfees.waive.write',          admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — fees.ts:116' },
  { capability: 'fees.clubfees.addmanual.write',      admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — fees.ts:253' },
  { capability: 'fees.clubfees.removemanual.write',   admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — fees.ts:300' },
  { capability: 'fees.reinstatements.read',           admin: T, exec: F, trainer: F, was: 'isAdmin fetch — fees/page.tsx:125, 421' },
  { capability: 'fees.reinstatements.write',          admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — reinstatement.ts:218' },
  { capability: 'fees.netposition.read',              admin: T, exec: F, trainer: F, was: 'isAdmin fetch — fees/page.tsx:194, dashboard/page.tsx:67' },
  { capability: 'fees.playerflags.write',             admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — fees.ts:26' },

  // ---- legal -----------------------------------------------------------
  // requireReacceptance lives in actions/settings.ts but belongs to /legal —
  // the one exec gate in that file, and the reason this area is not uniform
  // with its file.
  { capability: 'legal.page',                         admin: T, exec: T, trainer: F, was: "getAuthenticatedExecOrAdmin('external') — legal/page.tsx:18" },
  { capability: 'legal.reacceptance.write',           admin: T, exec: T, trainer: F, was: "getExecOrAdmin('external') — settings.ts:185" },
  { capability: 'legal.documents.write',              admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — settings.ts:71' },
  { capability: 'legal.waivertemplate.write',         admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — settings.ts:124' },

  // ---- walkovers -------------------------------------------------------
  { capability: 'walkovers.page',                     admin: T, exec: F, trainer: F, was: "SECTION_ACCESS['/walkovers'] = 'admin'" },
  { capability: 'walkovers.confirm.write',            admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — walkovers.ts:15' },
  { capability: 'walkovers.reject.write',             admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — walkovers.ts:48' },

  // ---- disputes --------------------------------------------------------
  { capability: 'disputes.page',                      admin: T, exec: F, trainer: F, was: "SECTION_ACCESS['/disputes'] = 'admin'" },
  { capability: 'disputes.resolve.write',             admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — disputes.ts:18' },

  // ---- permissions -----------------------------------------------------
  { capability: 'permissions.page',                   admin: T, exec: F, trainer: F, was: 'getAuthenticatedAdmin() — permissions/page.tsx:18' },
  { capability: 'permissions.write',                  admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — portfolios.ts:32 (setPlayerPortfolio)' },

  // ---- audit / ratings / accounts --------------------------------------
  { capability: 'audit.page',                         admin: T, exec: F, trainer: F, was: "SECTION_ACCESS['/audit'] = 'admin'" },
  { capability: 'ratings.page',                       admin: T, exec: F, trainer: F, was: 'getAuthenticatedAdmin() — ratings/page.tsx:17' },
  { capability: 'accounts.page',                      admin: T, exec: F, trainer: F, was: 'getAuthenticatedAdmin() — accounts/page.tsx:12' },

  // ---- platform --------------------------------------------------------
  // The other capability with no predecessor. `platform` has no route, so its
  // page gates the settings FORM on /ratings and /accounts — both of which were
  // admin-only in every half, which is where this row's answers come from.
  { capability: 'platform.page',                      admin: T, exec: F, trainer: F, was: 'getAuthenticatedAdmin() — the form on ratings/page.tsx and accounts/page.tsx' },
  { capability: 'platform.settings.write',            admin: T, exec: F, trainer: F, was: 'getAdminPlayer() — settings.ts:14' },
];

describe('capability equivalence — nobody gained anything', () => {
  it('covers every capability exactly once', () => {
    expect(TODAY.length).toBe(CAPABILITIES.length);
    expect(new Set(TODAY.map((r) => r.capability)).size).toBe(TODAY.length);
    expect(TODAY.map((r) => r.capability).sort()).toEqual([...CAPABILITIES].sort());
  });

  for (const row of TODAY) {
    it(`${row.capability} — admin=${row.admin} exec=${row.exec} trainer=${row.trainer} (was ${row.was})`, () => {
      expect(permits('admin', UNRESTRICTED, row.capability)).toBe(row.admin);
      expect(permits('exec', UNRESTRICTED, row.capability)).toBe(row.exec);
      expect(permits('trainer', UNRESTRICTED, row.capability)).toBe(row.trainer);
      // Nobody without a console level holds anything, ever.
      expect(permits(null, UNRESTRICTED, row.capability)).toBe(false);
    });
  }

  // The levels were a ladder and the sets have to keep that shape: a capability
  // a trainer holds must be one an exec holds, and one an exec holds must be
  // one an admin holds.
  it('never gives a lower level something a higher one lacks', () => {
    for (const row of TODAY) {
      if (row.trainer) expect(row.exec, row.capability).toBe(true);
      if (row.exec) expect(row.admin, row.capability).toBe(true);
    }
  });

  // Every capability is held by SOMEBODY, and admins hold all of them. A row
  // with three falses would be a tick box nobody can ever satisfy.
  it('leaves nothing unreachable', () => {
    for (const row of TODAY) expect(row.admin, row.capability).toBe(true);
  });

  // The two independent write-downs, compared. This table was assembled from
  // the call sites; EXEC_BASELINE and TRAINER_BASELINE were assembled from the
  // areas. If they ever disagree, somebody has moved a boundary.
  it('agrees with the baselines, which were written down separately', () => {
    const execFromTable = TODAY.filter((r) => r.exec).map((r) => r.capability).sort();
    const trainerFromTable = TODAY.filter((r) => r.trainer).map((r) => r.capability).sort();
    expect(execFromTable).toEqual([...EXEC_BASELINE].sort());
    expect(trainerFromTable).toEqual([...TRAINER_BASELINE].sort());
  });

  // Type-level belt: every capability named above is a member of the union, so
  // a string that drifts out of the vocabulary is a compile error here as well
  // as a failing assertion.
  it('names only real capabilities', () => {
    const all = new Set<Capability>(CAPABILITIES);
    for (const row of TODAY) expect(all.has(row.capability), row.capability).toBe(true);
  });
});
