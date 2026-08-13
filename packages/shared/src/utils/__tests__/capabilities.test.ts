import { describe, it, expect } from 'vitest';
import {
  AREAS,
  CAPABILITIES,
  EDITOR_OFFERABLE,
  EXEC_ASSIGNABLE,
  EXEC_BASELINE,
  TRAINER_BASELINE,
  PERMISSION_ROLES,
  ROLE_DEFAULTS,
  UNRESTRICTED,
  effectiveCapabilities,
  isCapability,
  pageOf,
  permits,
  permissionsOf,
  permissionTripleOf,
  resolvePermissions,
  type Capability,
} from '../access-level';
import { CAPABILITY_GATES, ENFORCEMENT_POINTS } from '../capability-gates';

// 119 capabilities is 119 promises that something is enforced. This suite is
// what keeps the vocabulary closed: it pins the list literally, refuses the
// shapes that would let one capability quietly imply another, and asserts that
// every one of them names a place in the app that reads it.

const resourceOf = (capability: string) => capability.split('.').slice(0, -1);
const modeOf = (capability: string) => capability.split('.').at(-1)!;

describe('the capability vocabulary', () => {
  it('is exactly 119 entries, with no duplicates', () => {
    expect(CAPABILITIES.length).toBe(119);
    expect(new Set(CAPABILITIES).size).toBe(119);
  });

  it('has 16 areas, every one of them used', () => {
    expect(AREAS.length).toBe(16);
    expect(new Set(AREAS).size).toBe(16);
    for (const area of AREAS) {
      expect(
        CAPABILITIES.some((c) => c.split('.')[0] === area),
        `area ${area} has no capabilities`,
      ).toBe(true);
    }
  });

  it('starts every capability with a declared area', () => {
    const areas = new Set<string>(AREAS);
    for (const capability of CAPABILITIES) {
      expect(areas.has(capability.split('.')[0]!), `${capability} names no area`).toBe(true);
    }
  });

  it('ends every capability in page, read or write, at depth 2 to 5', () => {
    for (const capability of CAPABILITIES) {
      const segments = capability.split('.');
      expect(['page', 'read', 'write']).toContain(segments.at(-1));
      expect(segments.length, `${capability} depth`).toBeGreaterThanOrEqual(2);
      expect(segments.length, `${capability} depth`).toBeLessThanOrEqual(5);
      for (const segment of segments) {
        expect(segment, `${capability} segment`).toMatch(/^[a-z0-9]+$/);
      }
    }
  });

  // EXACTLY ONE PAGE PER AREA, AT DEPTH 2. The resolver deletes every capability
  // whose area page is absent from the resolved set, and pageOf() builds that
  // name by taking the first segment and appending '.page' — so an area with no
  // page is an area where nothing can ever be held, and an area with two is a
  // second name for the same door that only one of the two closes.
  it('gives every area exactly one page, and puts it at depth 2', () => {
    for (const area of AREAS) {
      const pages = CAPABILITIES.filter((c) => c.split('.')[0] === area && modeOf(c) === 'page');
      expect(pages, `area ${area}`).toEqual([`${area}.page`]);
    }
    expect(CAPABILITIES.filter((c) => modeOf(c) === 'page').length).toBe(AREAS.length);
  });

  // pageOf() is a first-segment lookup and the resolver's whole invariant rests
  // on it landing on a real capability for every input — including for a page,
  // which must map to itself or the rule would delete every page there is.
  it('maps every capability to its area’s page, and a page to itself', () => {
    for (const capability of CAPABILITIES) {
      const page = pageOf(capability);
      expect(isCapability(page), `${capability} → ${page}`).toBe(true);
      expect(page.split('.')[0]).toBe(capability.split('.')[0]);
      if (modeOf(capability) === 'page') expect(page).toBe(capability);
    }
  });

  // NO PREFIX IMPLICATION. Resolve-time implication is how permission systems
  // grant things nobody reviewed: a coarse `players.write` sitting above
  // `players.editor.medicalhistory.write` would reach every holder of it with
  // no diff and no audit row. permits() is plain set membership, so no such
  // implication exists — and this refuses the SHAPE as well, so nobody can
  // reintroduce it by naming a capability that reads like a parent of another.
  //
  // Compared within a mode: `fees.expenses.read` and `fees.expenses.add.write`
  // are a read and a write, which is the ordinary read/write pairing, not a
  // coarse capability over a fine one.
  it('never lets one capability be a prefix of another at the same mode', () => {
    for (const mode of ['page', 'read', 'write']) {
      const paths = CAPABILITIES.filter((c) => modeOf(c) === mode).map(resourceOf);
      for (const a of paths) {
        for (const b of paths) {
          if (a === b) continue;
          const isPrefix = a.length < b.length && a.every((seg, i) => seg === b[i]);
          expect(isPrefix, `${a.join('.')}.${mode} prefixes ${b.join('.')}.${mode}`).toBe(false);
        }
      }
    }
  });

  it('narrows only strings the vocabulary actually has', () => {
    expect(isCapability('players.page')).toBe(true);
    // BACK, AND MEANING SOMETHING ELSE. 00087 pinned `players.read` meaning "may
    // open the roster"; 00088 renamed every stored occurrence of it to
    // `players.page` and dropped it; 00089 reintroduces it meaning "may see the
    // roster data". Safe only because that rename ran first — a survivor from
    // 00087 would have changed meaning underneath its holder.
    expect(isCapability('players.read')).toBe(true);
    expect(isCapability('players.write')).toBe(false);
    expect(isCapability('')).toBe(false);
    expect(isCapability(null)).toBe(false);
    expect(isCapability(42)).toBe(false);
  });
});

describe('CAPABILITY_GATES', () => {
  it('covers every capability and nothing else', () => {
    expect(Object.keys(CAPABILITY_GATES).sort()).toEqual([...CAPABILITIES].sort());
  });

  it('agrees with each capability about its area and mode', () => {
    for (const capability of CAPABILITIES) {
      const entry = CAPABILITY_GATES[capability];
      expect(entry.area, capability).toBe(capability.split('.')[0]);
      expect(entry.mode, capability).toBe(modeOf(capability));
      expect(entry.label.length, `${capability} has no label`).toBeGreaterThan(0);
      // A group, where there is one, is the capability's own second segment —
      // it is a real interior node of the path, never a category invented for
      // the editor.
      if (entry.group !== null) expect(entry.group, capability).toBe(capability.split('.')[1]);
    }
  });

  // The count assertion. At one capability per gate this is near one-to-one, so
  // it is a real check rather than documentation: deleting a gate without
  // deleting its capability leaves the editor offering a tick box nothing
  // reads, and that is what this fails on.
  //
  // 134 BECAME 133 when the dead legacy removal was deleted. That is the count
  // moving in the direction this assertion WANTS: a call site went away and its
  // `also` entry went with it, so the map still names only places that exist.
  // The failure it guards against is the opposite one — a site disappearing
  // while the entry claiming it stays. `tournaments.draw.participants.remove.write`
  // itself survives, still gated on removeParticipantFromEvent, and no
  // capability was added or removed there: CAPABILITIES is 119 above, and the
  // one added by `players.consoleaccess.write` is the 134th site — setConsoleAccess,
  // which no other capability claims.
  it('names 134 distinct enforcement points, none of them claimed twice', () => {
    const sites: string[] = [];
    for (const capability of CAPABILITIES) {
      const entry = CAPABILITY_GATES[capability];
      if (entry.gate !== null) sites.push(entry.gate);
      sites.push(...(entry.also ?? []));
    }
    expect(sites.length).toBe(134);
    expect(new Set(sites).size).toBe(134);
    expect(ENFORCEMENT_POINTS).toBe(134);
  });

  // Merging two call sites into one capability is a decision, so it has to be
  // argued at the point it is made. Merge only where two sites are literally
  // the same act reached twice.
  it('makes every merge declare its reason', () => {
    for (const capability of CAPABILITIES) {
      const entry = CAPABILITY_GATES[capability];
      const merged = (entry.also?.length ?? 0) > 0;
      expect(merged, capability).toBe(typeof entry.merged === 'string');
      if (merged) expect(entry.merged!.length).toBeGreaterThan(20);
    }
  });

  // EVERY capability now names a place in the app that reads it.
  // permissions.write was the last one without a gate, and it kept the `unwired`
  // escape hatch honest by being the only user of it; setPlayerPermissions is
  // now behind it, so the honest assertion is that the escape hatch is unused.
  // A capability with nothing behind it is a tick box the app does not read —
  // which is how a permission editor becomes a UI that lies.
  it('leaves nothing unwired', () => {
    expect(CAPABILITIES.filter((c) => CAPABILITY_GATES[c].gate === null)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The baselines
// ---------------------------------------------------------------------------
// Pinned LITERALLY, because the only way to notice one drifting is to have
// written it down twice.
//
// THERE ARE THREE LISTS HERE NOW, NOT TWO, AND THE SPLIT IS THE WHOLE CHANGE.
// TRAINER_BASELINE and EXEC_ASSIGNABLE are the transcription — what a trainer
// and an exec could do the day before capabilities existed. EXEC_BASELINE used
// to be the second of those and is now something else entirely: the read-only
// FLOOR an officer holds before anybody assigns them anything. The literal pin
// that follows the 73 moved WITH the transcription, to EXEC_ASSIGNABLE, and a
// new literal pin was written for the twelve.

describe('baselines', () => {
  it('gives a trainer exactly the roster, its page, and varsity notes', () => {
    expect([...TRAINER_BASELINE]).toEqual([
      'players.page',
      'players.read',
      'players.editor.varsitynotes.write',
    ]);
  });

  // THE FLOOR, PINNED ONE BY ONE — the club owner's "everyone can read things,
  // but cant write it", written down so that a single write appearing here is a
  // diff somebody has to read. Eight pages and four reads; the only two reads
  // that are not an area's page are the expense ledger and the two tournament
  // reads that were never anything but reads.
  it('gives an exec exactly 12 capabilities, all of them reads, pinned one by one', () => {
    expect([...EXEC_BASELINE]).toEqual([
      'announcements.page',
      'fees.page',
      'fees.expenses.read',
      'legal.page',
      'matches.page',
      'players.page',
      'players.read',
      'seasons.page',
      'sessions.page',
      'tournaments.page',
      'tournaments.draw.entrycounts.read',
      'tournaments.draw.waivers.read',
    ]);
    expect(EXEC_BASELINE.length).toBe(12);
    // The property the list exists to have, asserted as a property rather than
    // read off the list above: NOT ONE WRITE.
    expect(EXEC_BASELINE.filter((c) => c.endsWith('.write'))).toEqual([]);
  });

  // THE TRANSCRIPTION, UNMOVED. This literal list is the one that used to be
  // asserted against EXEC_BASELINE, character for character and in the same
  // order — it is repointed rather than rewritten, because the SET did not
  // change, only which constant holds it. That is the anti-widening claim: what
  // an admin may hand out is exactly what an exec used to hold by default.
  it('leaves exactly 73 capabilities assignable, pinned one by one', () => {
    expect([...EXEC_ASSIGNABLE]).toEqual([
      'players.page',
      'players.read',
      'players.approve.write',
      'players.create.write',
      'players.update.write',
      'players.waiver.resign.write',
      'players.ban.write',
      'players.reinstate.write',
      'players.editor.varsitynotes.write',
      'seasons.page',
      'seasons.create.write',
      'seasons.activate.write',
      'seasons.end.write',
      'sessions.page',
      'sessions.reminders.write',
      'sessions.create.write',
      'sessions.update.write',
      'sessions.archive.write',
      'sessions.checkin.token.write',
      'sessions.attendance.write',
      'sessions.delete.write',
      'matches.page',
      'matches.void.write',
      'matches.convert.write',
      'matches.create.write',
      'announcements.page',
      'announcements.create.write',
      'announcements.update.write',
      'announcements.delete.write',
      'tournaments.page',
      'tournaments.manage.create.write',
      'tournaments.manage.update.write',
      'tournaments.manage.status.write',
      'tournaments.manage.suspend.write',
      'tournaments.manage.resume.write',
      'tournaments.manage.archive.write',
      'tournaments.manage.delete.write',
      'tournaments.manage.event.create.write',
      'tournaments.manage.event.update.write',
      'tournaments.manage.event.delete.write',
      'tournaments.manage.event.status.write',
      'tournaments.draw.participants.add.write',
      'tournaments.draw.participants.remove.write',
      'tournaments.draw.checkin.token.write',
      'tournaments.draw.checkin.mark.write',
      'tournaments.draw.noshow.write',
      'tournaments.draw.exit.write',
      'tournaments.draw.pairs.add.write',
      'tournaments.draw.pairs.remove.write',
      'tournaments.draw.seed.set.write',
      'tournaments.draw.seed.auto.write',
      'tournaments.draw.seed.clear.write',
      'tournaments.draw.generate.write',
      'tournaments.draw.lock.write',
      'tournaments.draw.unlock.write',
      'tournaments.draw.waivers.read',
      'tournaments.draw.entrycounts.read',
      'tournaments.results.enter.write',
      'tournaments.results.walkover.write',
      'tournaments.results.void.write',
      'tournaments.results.unvoid.write',
      'tournaments.results.undo.write',
      'tournaments.results.edit.write',
      'tournaments.results.entry.write',
      'tournaments.results.doublenoshow.write',
      'tournaments.results.bonuses.write',
      'tournaments.results.standings.write',
      'tournaments.results.finalize.write',
      'fees.page',
      'fees.expenses.read',
      'fees.expenses.add.write',
      'legal.page',
      'legal.reacceptance.write',
    ]);
    expect(EXEC_ASSIGNABLE.length).toBe(73);
    // NOBODY HOLDS IT BY DEFAULT, which is the difference between this list and
    // the one above. It is a ceiling on what may be assigned, never a grant.
    expect(effectiveCapabilities('exec', UNRESTRICTED).size).toBe(EXEC_BASELINE.length);
  });

  // THE FLOOR IS INSIDE THE TRANSCRIPTION, which is the narrowing stated as an
  // inclusion. If this ever fails, the "baseline" has grown something no exec
  // held before capabilities existed — the one direction it must never move.
  it('keeps the exec baseline strictly inside what an exec may be assigned', () => {
    const assignable = new Set<Capability>(EXEC_ASSIGNABLE);
    for (const capability of EXEC_BASELINE) {
      expect(assignable.has(capability), `${capability} is not historic exec work`).toBe(true);
    }
    expect(EXEC_BASELINE.length).toBeLessThan(EXEC_ASSIGNABLE.length);
  });

  // THE INVARIANT, CHECKED AGAINST THE BASELINES THEMSELVES. A baseline is fed
  // to permits() directly and never goes through the resolver, so a missing page
  // here would not be pruned — it would be a level quietly holding writes in a
  // section it cannot open, which is the shape of bug this suite exists to make
  // impossible to ship.
  it('carries the page for every area any of the three lists reaches', () => {
    for (const list of [EXEC_BASELINE, EXEC_ASSIGNABLE, TRAINER_BASELINE]) {
      const held = new Set<Capability>(list);
      for (const capability of list) {
        expect(held.has(pageOf(capability)), `${capability} without its area page`).toBe(true);
      }
    }
  });

  it('keeps all three lists inside the vocabulary, with no duplicates', () => {
    for (const list of [EXEC_BASELINE, EXEC_ASSIGNABLE, TRAINER_BASELINE]) {
      expect(new Set(list).size).toBe(list.length);
      for (const capability of list) expect(isCapability(capability)).toBe(true);
    }
  });

  // -------------------------------------------------------------------------
  // THE LADDER, AND THE ONE RUNG THE NARROWING BROKE
  // -------------------------------------------------------------------------
  // THIS USED TO BE ONE ASSERTION: "keeps the trainer baseline inside the exec
  // baseline", whose comment said a trainer's level is a strict subset of an
  // exec's, "or 'exec' would stop meaning 'everything a trainer has, and more'".
  //
  // WHAT IT WAS ACTUALLY PROTECTING is accessLevelFor(), which resolves is_exec
  // BEFORE is_trainer and returns ONE level. A row carrying both flags is
  // therefore an 'exec' and holds the exec baseline and nothing else — which was
  // free while that baseline contained the trainer's, and is not free now. The
  // containment was the thing making the collapse lossless.
  //
  // IT NO LONGER HOLDS, AT EXACTLY ONE CAPABILITY. `players.page` and
  // `players.read` are in the new twelve; `players.editor.varsitynotes.write` is
  // a write, so it left with every other write. The hole is pinned LITERALLY
  // below rather than the assertion being deleted or quietly repointed, because
  // a one-capability hole that nobody notices growing to five is precisely the
  // failure this suite exists to make impossible.
  //
  // IT IS LATENT RATHER THAN LIVE, and that is why the recommendation is to
  // record it rather than widen the baseline back. Every writer of these columns
  // is mutually exclusive — fromRoleValue() in the admin app writes
  // `is_trainer: false` for 'executive' and `is_exec: false` for 'trainer', and
  // both the member Edit dialog and /permissions go through it — so only a
  // legacy row or a hand-rolled admin payload can be both. The two repairs, if a
  // row is ever found: put the varsity note back in EXEC_BASELINE (one line, but
  // it hands every officer a write the club owner did not ask for), or stop
  // accessLevelFor() collapsing the two flags (correct, and a change to the
  // resolver rather than to a list).
  it('leaves exactly the varsity note outside the exec baseline — a REGRESSION, pinned so it cannot grow', () => {
    const exec = new Set<Capability>(EXEC_BASELINE);
    const outside = TRAINER_BASELINE.filter((capability) => !exec.has(capability));
    expect(outside).toEqual(['players.editor.varsitynotes.write']);
  });

  // AND THE CONTAINMENT THAT DOES SURVIVE, which is the one worth having: a
  // trainer's whole level is inside what an exec may be ASSIGNED. So promoting a
  // varsity trainer to executive-with-the-internal-role takes nothing from them,
  // and the ladder still holds everywhere authority is handed over deliberately.
  // It fails only where a single row silently claims two jobs at once.
  it('keeps the trainer baseline inside what an exec may be assigned', () => {
    const assignable = new Set<Capability>(EXEC_ASSIGNABLE);
    for (const capability of TRAINER_BASELINE) {
      expect(assignable.has(capability), capability).toBe(true);
    }
    // ...and the role that owns the roster is where it actually lands, so the
    // repair is a real assignment rather than a theoretical one.
    expect(ROLE_DEFAULTS.internal).toContain('players.editor.varsitynotes.write');
  });

  // The four VP jobs, and `custom` — which is not a fifth job but the empty
  // base, the only way the storage can express a hand-picked set. Pinned in
  // order, because that order is the order the editor offers them in.
  it('lists exactly the four VP jobs, and the hand-picked base', () => {
    expect([...PERMISSION_ROLES]).toEqual([
      'finance',
      'tournaments',
      'internal',
      'external',
      'custom',
    ]);
  });
});

// ---------------------------------------------------------------------------
// ROLE_DEFAULTS
// ---------------------------------------------------------------------------
// THE PROPERTY THESE TESTS EXIST FOR: a role can never put somebody outside
// what an exec could already do. Everything below is a way of writing that down
// so it cannot be lost by accident — the subset assertion is the security one,
// and the literal pinning is what makes a change to a role a reviewed diff
// rather than a discovery six months later.
//
// THE CONSTANT THESE TWO NAME MOVED FROM EXEC_BASELINE TO EXEC_ASSIGNABLE, and
// the property did not. While the baseline WAS the historic 73, "inside the exec
// baseline" and "inside what an exec could already do" were the same sentence
// written two ways; narrowing the baseline to twelve reads split them, and it is
// the second one these have always meant. Stating them against the twelve would
// have been a different and false claim — every VP role would exceed its own
// bound, and the assignment mechanism the narrowing depends on would be the
// thing these tests refused.
//
// It used to be stated as "assigning a role is never itself a widening", which
// was the same claim only while roles were exec-only: the role was a subset of
// the TARGET's own base, so picking one could only subtract. Trainers are
// composable now, and ROLE_DEFAULTS.tournaments against TRAINER_BASELINE is a
// widening by fifty capabilities — deliberately, because that is what lets a
// varsity trainer run sessions without being made an exec. The subset assertion
// below is unchanged and still the security one; only the sentence describing
// what it buys had to move from a direction to a ceiling.

describe('ROLE_DEFAULTS', () => {
  // The one that matters. A role that reached beyond the historic exec set would
  // let "pick Finance from a dropdown" hand out something no exec ever had,
  // with no grant to review and no audit row saying what it was.
  it('keeps every role inside what an exec may be assigned, so a role can never exceed it', () => {
    const assignable = new Set<Capability>(EXEC_ASSIGNABLE);
    for (const role of PERMISSION_ROLES) {
      for (const capability of ROLE_DEFAULTS[role]) {
        expect(
          assignable.has(capability),
          `${role} grants ${capability}, which no exec ever held`,
        ).toBe(true);
      }
    }
  });

  it('keeps every role inside the vocabulary, with no duplicates', () => {
    for (const role of PERMISSION_ROLES) {
      const list = ROLE_DEFAULTS[role];
      expect(new Set(list).size, role).toBe(list.length);
      for (const capability of list) expect(isCapability(capability), capability).toBe(true);
    }
  });

  // A role missing an area's page does not merely leave its holder outside the
  // section — the resolver DELETES everything the role gave them there. So this
  // is not a courtesy check any more: a role that failed it would be a named job
  // that silently confers nothing.
  it('gives every role the page for every area it touches', () => {
    for (const role of PERMISSION_ROLES) {
      const list = ROLE_DEFAULTS[role];
      const held = new Set<Capability>(list);
      for (const capability of list) {
        expect(
          held.has(pageOf(capability)),
          `${role} gives ${capability} but not ${pageOf(capability)}`,
        ).toBe(true);
      }
      // ...and the resolver agrees, which is the assertion that matters: an
      // unadjusted role must survive its own invariant intact.
      const resolved = resolvePermissions(role, [], []);
      expect(RESTRICTED(resolved), role).toEqual([...list].sort());
    }
  });

  // THE DERIVATION, WRITTEN DOWN. The four roles are the old SECTION_PORTFOLIO
  // map — finance owned /fees, tournaments owned /tournaments /matches
  // /sessions, internal owned /players /seasons, external owned /legal
  // /announcements — intersected with the historic exec set. So they partition
  // it exactly, and that is not a coincidence to be preserved for its own sake:
  // it is the assertion that assigning a role does what assigning a portfolio
  // did.
  //
  // IT STILL HOLDS EXACTLY, AND AGAINST EXEC_ASSIGNABLE — the same 73 the
  // baseline used to be, so nothing about the partition itself moved: 3 + 51 +
  // 13 + 6 + 0 = 73, checked below rather than asserted in prose.
  //
  // IT ALSO GAINED A SECOND JOB THE DAY THE BASELINE NARROWED. It was the proof
  // that a role hands out nothing an exec did not already have. It is now ALSO
  // the proof that the four roles between them hand BACK every write the
  // narrowing took away: an exact partition means no capability fell into the
  // gap between the read-only floor and the jobs that are meant to restore it.
  // A merely-inside-the-ceiling check would have let one go missing silently,
  // and the person who noticed would be an officer who could not do their job.
  //
  // The arithmetic moved by exactly one when page keys arrived: finance went
  // from two entries to three, because /fees was the one section whose page key
  // did not already exist under another name. The other three roles renamed
  // their reads and kept their counts, and the total tracked the exec baseline
  // from 69 to 70. It moved by one again when the roster fetch got its own read:
  // `internal` owns /players, so `players.read` went there and nowhere else —
  // which is also why the pickers on /matches and /tournaments are NOT behind
  // it. Gating those would put the same capability in two roles and this
  // assertion is what would refuse it.
  //
  // If a future capability genuinely belongs to two jobs, THIS half is the one
  // to relax. The subset assertion above is not.
  //
  // `custom` contributes nothing to either side, which is the arithmetic reason
  // an empty base was the right shape for it: a hand-picked set had to be
  // storable without claiming a slice of the partition that some VP job already
  // owns.
  it('partitions what an exec may be assigned, exactly, as the four portfolios did', () => {
    const fromRoles = PERMISSION_ROLES.flatMap((role) => [...ROLE_DEFAULTS[role]]);
    expect(new Set(fromRoles).size, 'two roles claim the same capability').toBe(fromRoles.length);
    expect([...fromRoles].sort()).toEqual([...EXEC_ASSIGNABLE].sort());
    // The arithmetic, so "exactly" is a sum somebody can check rather than a
    // word: finance 3, tournaments 51, internal 13, external 6, custom 0.
    expect(PERMISSION_ROLES.map((role) => ROLE_DEFAULTS[role].length)).toEqual([3, 51, 13, 6, 0]);
    expect(fromRoles.length).toBe(73);
  });

  // THE OTHER HALF OF THE PARTITION, AND IT IS NEW. The four roles cover the
  // ceiling; this says they also cover everything an officer LOST. Every write
  // that left EXEC_BASELINE is in exactly one VP job, so "assign them a role" is
  // a complete answer to "they cannot do their job any more" — there is no write
  // that requires a hand-picked grant merely because the roles forgot it.
  it('hands back, through the four roles, every write the baseline gave up', () => {
    const floor = new Set<Capability>(EXEC_BASELINE);
    const lost = EXEC_ASSIGNABLE.filter((capability) => !floor.has(capability));
    expect(lost.length).toBe(61);
    const fromRoles = new Set(PERMISSION_ROLES.flatMap((role) => [...ROLE_DEFAULTS[role]]));
    for (const capability of lost) {
      expect(fromRoles.has(capability), `${capability} is in no VP job`).toBe(true);
    }
  });

  // Pinned literally, because the club's answer to "what does the treasurer
  // get" is a decision and not a derivation. Finance stops at the Expenses tab
  // — 00086's behaviour exactly — and club money, other income, the net
  // position and reinstatements are handed over per person by explicit grant.
  it('gives finance today’s scope and nothing more', () => {
    expect([...ROLE_DEFAULTS.finance]).toEqual([
      'fees.page',
      'fees.expenses.read',
      'fees.expenses.add.write',
    ]);
  });

  it('gives external the announcements and the legal documents', () => {
    expect([...ROLE_DEFAULTS.external]).toEqual([
      'announcements.page',
      'announcements.create.write',
      'announcements.update.write',
      'announcements.delete.write',
      'legal.page',
      'legal.reacceptance.write',
    ]);
  });

  it('gives internal the roster and the seasons, but not the season fees', () => {
    expect([...ROLE_DEFAULTS.internal]).toEqual([
      'players.page',
      'players.read',
      'players.approve.write',
      'players.create.write',
      'players.update.write',
      'players.waiver.resign.write',
      'players.ban.write',
      'players.reinstate.write',
      'players.editor.varsitynotes.write',
      'seasons.page',
      'seasons.create.write',
      'seasons.activate.write',
      'seasons.end.write',
    ]);
    expect(ROLE_DEFAULTS.internal).not.toContain('seasons.fees.write');
  });

  it('gives tournaments the draw, the ladder and the sessions, but not entry money', () => {
    expect(ROLE_DEFAULTS.tournaments.length).toBe(51);
    expect([...ROLE_DEFAULTS.tournaments].slice(0, 12)).toEqual([
      'sessions.page',
      'sessions.reminders.write',
      'sessions.create.write',
      'sessions.update.write',
      'sessions.archive.write',
      'sessions.checkin.token.write',
      'sessions.attendance.write',
      'sessions.delete.write',
      'matches.page',
      'matches.void.write',
      'matches.convert.write',
      'matches.create.write',
    ]);
    for (const capability of ROLE_DEFAULTS.tournaments) {
      expect(capability.startsWith('tournaments.fees.'), capability).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// EDITOR_OFFERABLE
// ---------------------------------------------------------------------------
// The ceiling. Grant closure bounds what one person may hand another and cannot
// bound an ADMIN, who holds everything by level — so the set an admin may
// COMPOSE is capped here, which is the only thing bounding them.
//
// IT USED TO BE `= EXEC_BASELINE`, AND IT IS NOT ANY MORE. The constant was
// doing two jobs: transcribing what execs held, and capping what anybody may be
// composed up to. Editable roles (00104) pulled them apart — the club owner
// wants the exec baseline NOT to grow and Finance to exceed it, and both are
// true only once the ceiling is its own list.
//
// THE TRANSCRIPTION ITSELF DID NOT MOVE, and that is asserted below rather than
// assumed. The widening is four READS on /fees, enumerated in access-level.ts
// and pinned entry-by-entry in editable-roles.test.ts.
//
// THE CONSTANT IT SPREADS IS NOW EXEC_ASSIGNABLE, and this whole block is
// repointed for that reason and no other. `EDITOR_OFFERABLE = EXEC_BASELINE +
// widening` became `EXEC_ASSIGNABLE + widening` when the baseline narrowed —
// which changed the NAME of the first summand and nothing else, because
// EXEC_ASSIGNABLE holds the old EXEC_BASELINE verbatim and in order. The set
// this constant denotes is byte-for-byte what it denoted before, which is the
// whole anti-widening claim, and stating these against the twelve would have
// asserted the opposite of what they exist to assert.

describe('EDITOR_OFFERABLE', () => {
  it('contains everything assignable, in order, and then the widening', () => {
    expect([...EDITOR_OFFERABLE].slice(0, EXEC_ASSIGNABLE.length)).toEqual([...EXEC_ASSIGNABLE]);
  });

  // THE EXEC TRANSCRIPTION IS UNCHANGED. The whole risk of splitting the
  // constants is that a widening lands in the wrong one and reaches every exec
  // in the club without anybody choosing it.
  it('leaves the assignable set exactly as it was', () => {
    expect(EXEC_ASSIGNABLE.length).toBe(73);
    const offerableOnly = [...EDITOR_OFFERABLE].filter(
      (capability) => !new Set<Capability>(EXEC_ASSIGNABLE).has(capability),
    );
    for (const capability of offerableOnly) {
      expect(
        (EXEC_ASSIGNABLE as readonly Capability[]).includes(capability),
        `${capability} leaked into the assignable set`,
      ).toBe(false);
    }
  });

  // AND THE SECOND CONSTANT, GUARDED FROM THE OTHER DIRECTION. Now that there is
  // a floor as well as a ceiling, the mistake to catch is a widening landing in
  // the FLOOR — where it would reach every officer in the club by level, with
  // nobody choosing it. The floor holds no write at all, so the cheapest way to
  // say that is to say it again here, at the constant that bounds handing out.
  it('never lets the widening reach the exec baseline', () => {
    const floor = new Set<Capability>(EXEC_BASELINE);
    const assignable = new Set<Capability>(EXEC_ASSIGNABLE);
    for (const capability of EDITOR_OFFERABLE) {
      if (assignable.has(capability)) continue;
      expect(floor.has(capability), `${capability} reached the exec baseline`).toBe(false);
    }
    expect(EXEC_BASELINE.filter((c) => c.endsWith('.write'))).toEqual([]);
  });

  // Named one by one so that opening any of them is a diff somebody has to
  // read. These are the club's rating and account rules, its audit trail, the
  // ability to MOVE money, and the ability to hand out permissions at all.
  //
  // THE FOUR FINANCE READS CAME OFF THIS LIST, on purpose and as the whole
  // point of 00104: the club owner asked for a treasurer who can SEE money in as
  // well as out. Seeing is not moving, and every `fees.*.write` below stayed.
  //
  // `players.consoleaccess.write` IS OFFERABLE AND IS DELIBERATELY NOT BELOW —
  // 00105, the club owner's "also make role change a permission". It is the
  // first WRITE on the offerable list, and what bounds it is not this list: the
  // action reading it closure-checks the target's whole set on both sides and
  // still refuses the admin level outright, both pinned in
  // apps/admin/src/lib/__tests__/console-access-capability.test.ts. Handing out
  // the admin LEVEL remains the act no capability expresses, which is why
  // `permissions.write` is still below and this is not.
  it('withholds the admin-only half, permissions.write included', () => {
    const offerable = new Set<Capability>(EDITOR_OFFERABLE);
    for (const capability of [
      'permissions.write',
      'permissions.page',
      'audit.page',
      'ratings.page',
      'accounts.page',
      'platform.page',
      'platform.settings.write',
      'fees.clubfees.markpaid.write',
      'fees.clubfees.waive.write',
      'fees.otherincome.add.write',
      'fees.reinstatements.write',
      'fees.playerflags.write',
      'seasons.fees.write',
      'tournaments.fees.read',
      'players.privilegedfields.write',
      'players.merge.write',
      'players.remove.write',
      'challenges.page',
      'disputes.page',
      'walkovers.page',
    ] as const) {
      expect(offerable.has(capability), `${capability} is offerable`).toBe(false);
    }
  });

  it('holds nothing outside the vocabulary', () => {
    for (const capability of EDITOR_OFFERABLE) expect(isCapability(capability)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// permits / effectiveCapabilities
// ---------------------------------------------------------------------------

describe('permits', () => {
  it('makes an admin a superuser BY LEVEL, holding all 119', () => {
    for (const capability of CAPABILITIES) {
      expect(permits('admin', UNRESTRICTED, capability), capability).toBe(true);
    }
    expect(effectiveCapabilities('admin', UNRESTRICTED).size).toBe(119);
  });

  it('gives an unrestricted person their level baseline and nothing more', () => {
    expect(effectiveCapabilities('exec', UNRESTRICTED).size).toBe(EXEC_BASELINE.length);
    expect(effectiveCapabilities('trainer', UNRESTRICTED).size).toBe(TRAINER_BASELINE.length);
    expect(permits('exec', UNRESTRICTED, 'fees.clubfees.read')).toBe(false);
    expect(permits('trainer', UNRESTRICTED, 'players.update.write')).toBe(false);
  });

  it('gives somebody with no level nothing at all', () => {
    expect(effectiveCapabilities(null, UNRESTRICTED).size).toBe(0);
    expect(permits(null, UNRESTRICTED, 'players.page')).toBe(false);
    expect(permits(undefined, UNRESTRICTED, 'players.page')).toBe(false);
  });

  it('reads a restricted set literally, with no implication', () => {
    const permissions = {
      kind: 'restricted' as const,
      capabilities: new Set<Capability>(['players.page', 'players.update.write']),
    };
    expect(permits('exec', permissions, 'players.update.write')).toBe(true);
    // Holding the coarse-looking roster write does NOT reach a leaf beneath it.
    expect(permits('exec', permissions, 'players.editor.varsitynotes.write')).toBe(false);
    expect(permits('exec', permissions, 'players.approve.write')).toBe(false);
    // ...and an admin is still unaffected by anything stored.
    expect(permits('admin', permissions, 'players.approve.write')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// resolvePermissions
// ---------------------------------------------------------------------------

const RESTRICTED = (permissions: ReturnType<typeof resolvePermissions>) => {
  if (permissions.kind !== 'restricted') throw new Error('expected a restricted set');
  return [...permissions.capabilities].sort();
};

describe('resolvePermissions', () => {
  it('treats an absent role as unrestricted, DELTAS AND ALL', () => {
    // The decisive case: if an absent role meant an empty base, adding the
    // first grant to an unrestricted exec would flip their base from the whole
    // exec baseline to zero — a grant that removes fifty-odd capabilities, one
    // click, silent.
    expect(resolvePermissions(null, [], [])).toEqual(UNRESTRICTED);
    expect(resolvePermissions(null, ['audit.page'], [])).toEqual(UNRESTRICTED);
    // And a revoke stored while the role is NULL stays dormant rather than
    // biting — it must not remove anything now, nor wake up later without
    // somebody choosing a role.
    expect(resolvePermissions(null, [], ['players.page'])).toEqual(UNRESTRICTED);
    expect(resolvePermissions('', [], [])).toEqual(UNRESTRICTED);
  });

  // audit.page survives a lone grant with no role behind it because a page
  // requires only ITSELF — that is what makes it the thing you hand somebody
  // first, and the reason every stock grant in this suite is one.
  it('gives an unrecognised role no defaults, but still applies the deltas', () => {
    const resolved = resolvePermissions('treasurer', ['audit.page'], []);
    expect(RESTRICTED(resolved)).toEqual(['audit.page']);
  });

  // Every case below uses `finance`, whose defaults are the Finances page and
  // the two Expenses capabilities, so the expectations carry that base as well
  // as the delta under test. Deliberately not an empty-base role: a resolver
  // test against a role that gives nothing would pass identically if the base
  // were dropped on the floor.
  const FINANCE_BASE = ['fees.expenses.add.write', 'fees.expenses.read', 'fees.page'];

  it('lets a revoke beat a grant of the same capability', () => {
    const resolved = resolvePermissions('finance', ['audit.page'], ['audit.page']);
    expect(RESTRICTED(resolved)).toEqual(FINANCE_BASE);
  });

  it('lets a revoke reach into the role’s own defaults', () => {
    const resolved = resolvePermissions('finance', [], ['fees.expenses.add.write']);
    expect(RESTRICTED(resolved)).toEqual(['fees.expenses.read', 'fees.page']);
  });

  it('drops an element the vocabulary no longer has, without throwing', () => {
    const resolved = resolvePermissions('finance', ['players.write', 'audit.page'], ['nonsense']);
    expect(RESTRICTED(resolved)).toEqual([...FINANCE_BASE, 'audit.page'].sort());
  });

  // WRITE WITHOUT READ IS THE POINT, and this is the test that says so. The old
  // model pruned a write whose `.read` sibling was missing; the club owner's
  // rule is ".page would be required to have .write, but .read isnt required",
  // so somebody handed the Finances page and the ability to file an expense
  // keeps it while holding no view of the ledger at all.
  it('keeps a write with no read of its own', () => {
    const resolved = resolvePermissions(
      'finance',
      ['fees.reinstatements.write'],
      ['fees.expenses.read'],
    );
    expect(RESTRICTED(resolved)).toEqual([
      'fees.expenses.add.write',
      'fees.page',
      'fees.reinstatements.write',
    ]);
  });

  // Revoking a read takes that read and NOTHING ELSE. This is the exact case
  // the old `write ⊆ read` prune existed for, inverted deliberately.
  it('leaves the write behind when the matching read is revoked', () => {
    const resolved = resolvePermissions(
      'finance',
      ['fees.otherincome.read', 'fees.otherincome.add.write'],
      ['fees.otherincome.read'],
    );
    expect(RESTRICTED(resolved)).toEqual([...FINANCE_BASE, 'fees.otherincome.add.write'].sort());
  });

  // THE ONE INVARIANT, in the direction it exists for. A grant in an area whose
  // page the person does not hold is pruned — a control on a screen they cannot
  // reach is not access, it is a promise the route gate would refuse.
  it('prunes a granted capability whose area page is not held', () => {
    const resolved = resolvePermissions('finance', ['players.approve.write'], []);
    expect(RESTRICTED(resolved)).toEqual(FINANCE_BASE);
    // ...and it is the PAGE that was missing, not the capability: hand that over
    // and the write comes with it.
    const withPage = resolvePermissions('finance', ['players.page', 'players.approve.write'], []);
    expect(RESTRICTED(withPage)).toEqual(
      [...FINANCE_BASE, 'players.page', 'players.approve.write'].sort(),
    );
  });

  // REVOKING THE PAGE CLOSES THE WHOLE AREA, reads and writes alike, including
  // the ones the ROLE gave and neither array names. This is why the invariant
  // runs after subtraction rather than before: pruning first would leave the
  // ledger and its controls standing behind a door that had just been shut.
  it('takes every capability in an area with that area’s page', () => {
    const resolved = resolvePermissions(
      'finance',
      ['fees.clubfees.read', 'fees.clubfees.waive.write'],
      ['fees.page'],
    );
    expect(RESTRICTED(resolved)).toEqual([]);
  });

  it('is pure — the same inputs give the same answer and nothing is mutated', () => {
    const grants = ['audit.page'];
    const revokes: string[] = [];
    const first = RESTRICTED(resolvePermissions('finance', grants, revokes));
    const second = RESTRICTED(resolvePermissions('finance', grants, revokes));
    expect(first).toEqual(second);
    expect(grants).toEqual(['audit.page']);
    expect(revokes).toEqual([]);
  });
});

describe('permissionsOf', () => {
  // The heir of the old portfolioOf({}) === null. This is what makes the code
  // safe to deploy before the storage migration is applied: a missing column
  // must read as "not narrowed", because the alternative locks every exec out
  // of the console the moment the app ships.
  it('reads a row with none of the columns as unrestricted', () => {
    expect(permissionsOf({})).toEqual(UNRESTRICTED);
    expect(permissionsOf(null)).toEqual(UNRESTRICTED);
    expect(permissionsOf(undefined)).toEqual(UNRESTRICTED);
  });

  it('reads a null role as unrestricted', () => {
    expect(permissionsOf({ permission_role: null, permission_grants: [], permission_revokes: [] }))
      .toEqual(UNRESTRICTED);
  });

  // The columns are NOT NULL, so a role with a missing array can only come from
  // a narrowed SELECT — a programming error, not a state. The obvious `?? []`
  // would silently discard revokes, and a discarded revoke can leave somebody
  // holding permissions.write.
  it('THROWS on a role with a missing delta column', () => {
    expect(() => permissionsOf({ permission_role: 'finance' })).toThrow(/narrow the SELECT less/);
    expect(() => permissionsOf({ permission_role: 'finance', permission_grants: [] }))
      .toThrow(/narrow the SELECT less/);
  });

  it('resolves a complete row', () => {
    const resolved = permissionsOf({
      permission_role: 'finance',
      permission_grants: ['audit.page'],
      permission_revokes: [],
    });
    expect(RESTRICTED(resolved)).toEqual(
      ['audit.page', 'fees.expenses.add.write', 'fees.expenses.read', 'fees.page'],
    );
  });
});

describe('permissionTripleOf', () => {
  // A resolved Permissions carries a Set, and a Set is not plain data — so what
  // a server component hands the sidebar is the stored TRIPLE, resolved again
  // on the other side by the same function. Null for a row from before the
  // storage migration, which the client then reads as unrestricted.
  it('returns null for a row that predates the storage migration', () => {
    expect(permissionTripleOf({})).toBeNull();
    expect(permissionTripleOf(null)).toBeNull();
    expect(permissionTripleOf(undefined)).toBeNull();
  });

  it('carries the triple through unchanged', () => {
    expect(
      permissionTripleOf({
        permission_role: 'finance',
        permission_grants: ['audit.page'],
        permission_revokes: ['players.page'],
      }),
    ).toEqual({
      permission_role: 'finance',
      permission_grants: ['audit.page'],
      permission_revokes: ['players.page'],
    });
  });

  // The same throw permissionsOf makes, and for the same reason: serialising a
  // missing delta column as an empty array would DISCARD A REVOKE on the way to
  // the client, and a discarded revoke can leave somebody holding
  // permissions.write. A `?? []` here would have been the quiet way to
  // reintroduce exactly the bug the resolver throws to prevent.
  it('THROWS rather than serialise a role with a missing delta column', () => {
    expect(() => permissionTripleOf({ permission_role: 'finance' }))
      .toThrow(/narrow the SELECT less/);
  });
});

// ---------------------------------------------------------------------------
// Varsity notes, end to end
// ---------------------------------------------------------------------------
// The one capability that used to need a hand-composed gate — getVarsityAuthor
// called the console-level check and the portfolio check and joined them by
// hand, and its own comment said so. It needs no special case now, and these
// four cases are why: the resolver is LEVEL-AGNOSTIC, and the level enters only
// at permits(), where it picks which baseline an unrestricted person holds. One
// rule, three baseline entries.

describe('varsity notes', () => {
  const VARSITY = 'players.editor.varsitynotes.write';

  it('is held by a trainer — it is most of their level', () => {
    expect(permits('trainer', UNRESTRICTED, VARSITY)).toBe(true);
  });

  // THE EXPECTATION FLIPPED, AND IT IS THE NARROWING ITSELF. This test used to
  // read "is held by an unrestricted exec, exactly as it was before" and assert
  // TRUE. The varsity note is a WRITE, so it left the exec floor with all sixty
  // others: an officer with no permission_role can find the player and read the
  // roster, and cannot write about them.
  //
  // IT IS NOT A LOSS FOR TRAINERS — the case above still passes and is the level
  // that owns this capability. What it IS, is the one place the trainer level is
  // no longer inside the exec level; see the pinned hole in `baselines` above.
  it('is NOT held by an unrestricted exec any more — the write left the floor', () => {
    expect(permits('exec', UNRESTRICTED, VARSITY)).toBe(false);
    // The two roster READS did not: an officer can still find the person, which
    // is what makes assigning the note afterwards a coherent act rather than a
    // second thing they also have to be given.
    expect(permits('exec', UNRESTRICTED, 'players.page')).toBe(true);
    expect(permits('exec', UNRESTRICTED, 'players.read')).toBe(true);
  });

  // ...and it comes back with the job that owns it. This is the whole mechanism
  // in three lines: the write is not gone, it is assigned.
  it('is held again by an exec given the role that owns the roster', () => {
    const internal = resolvePermissions('internal', [], []);
    expect(permits('exec', internal, VARSITY)).toBe(true);
  });

  it('is NOT held by an exec narrowed to finance', () => {
    const finance = resolvePermissions('finance', [], []);
    expect(permits('exec', finance, VARSITY)).toBe(false);
    // ...and the roster page goes with it, so they cannot even find the person.
    expect(permits('exec', finance, 'players.page')).toBe(false);
  });

  // The page has to come with it. Granting the note alone would be pruned —
  // there is no roster area for that person to hold a capability in — which is
  // the invariant behaving exactly as intended and worth showing here, because
  // this is the capability people will reach for first.
  it('is held again the moment it and the roster page are granted', () => {
    expect(permits('exec', resolvePermissions('finance', [VARSITY], []), VARSITY)).toBe(false);
    const granted = resolvePermissions('finance', ['players.page', VARSITY], []);
    expect(permits('exec', granted, VARSITY)).toBe(true);
  });

  it('is held by an admin by LEVEL, with nothing stored', () => {
    expect(permits('admin', resolvePermissions('finance', [], []), VARSITY)).toBe(true);
  });
});
