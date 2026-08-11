import { describe, it, expect } from 'vitest';
import {
  AREAS,
  CAPABILITIES,
  EDITOR_OFFERABLE,
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

// 116 capabilities is 116 promises that something is enforced. This suite is
// what keeps the vocabulary closed: it pins the list literally, refuses the
// shapes that would let one capability quietly imply another, and asserts that
// every one of them names a place in the app that reads it.

const resourceOf = (capability: string) => capability.split('.').slice(0, -1);
const modeOf = (capability: string) => capability.split('.').at(-1)!;

describe('the capability vocabulary', () => {
  it('is exactly 116 entries, with no duplicates', () => {
    expect(CAPABILITIES.length).toBe(116);
    expect(new Set(CAPABILITIES).size).toBe(116);
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
  it('names 133 distinct enforcement points, none of them claimed twice', () => {
    const sites: string[] = [];
    for (const capability of CAPABILITIES) {
      const entry = CAPABILITY_GATES[capability];
      if (entry.gate !== null) sites.push(entry.gate);
      sites.push(...(entry.also ?? []));
    }
    expect(sites.length).toBe(133);
    expect(new Set(sites).size).toBe(133);
    expect(ENFORCEMENT_POINTS).toBe(133);
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
// Pinned LITERALLY, because these two lists are the deploy-day guarantee. They
// are a transcription of what an exec and a trainer could do the day before
// capabilities existed, and the only way to notice one drifting is to have
// written it down twice.

describe('baselines', () => {
  it('gives a trainer exactly the roster, its page, and varsity notes', () => {
    expect([...TRAINER_BASELINE]).toEqual([
      'players.page',
      'players.read',
      'players.editor.varsitynotes.write',
    ]);
  });

  it('gives an exec exactly 71 capabilities, pinned one by one', () => {
    expect([...EXEC_BASELINE]).toEqual([
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
    expect(EXEC_BASELINE.length).toBe(71);
  });

  // THE INVARIANT, CHECKED AGAINST THE BASELINES THEMSELVES. A baseline is fed
  // to permits() directly and never goes through the resolver, so a missing page
  // here would not be pruned — it would be a level quietly holding writes in a
  // section it cannot open, which is the shape of bug this suite exists to make
  // impossible to ship.
  it('carries the page for every area either baseline reaches', () => {
    for (const list of [EXEC_BASELINE, TRAINER_BASELINE]) {
      const held = new Set<Capability>(list);
      for (const capability of list) {
        expect(held.has(pageOf(capability)), `${capability} without its area page`).toBe(true);
      }
    }
  });

  it('keeps both baselines inside the vocabulary, with no duplicates', () => {
    for (const list of [EXEC_BASELINE, TRAINER_BASELINE]) {
      expect(new Set(list).size).toBe(list.length);
      for (const capability of list) expect(isCapability(capability)).toBe(true);
    }
  });

  // A trainer's level is a strict subset of an exec's — that was true of the
  // rungs and it has to stay true of the sets, or "exec" would stop meaning
  // "everything a trainer has, and more".
  it('keeps the trainer baseline inside the exec baseline', () => {
    const exec = new Set<Capability>(EXEC_BASELINE);
    for (const capability of TRAINER_BASELINE) expect(exec.has(capability)).toBe(true);
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
// THE PROPERTY THESE TESTS EXIST FOR: a role can never put somebody outside the
// exec baseline. Everything below is a way of writing that down so it cannot be
// lost by accident — the subset assertion is the security one, and the literal
// pinning is what makes a change to a role a reviewed diff rather than a
// discovery six months later.
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
  // The one that matters. A role that reached beyond the exec baseline would
  // let "pick Finance from a dropdown" hand out something no exec ever had,
  // with no grant to review and no audit row saying what it was.
  it('keeps every role inside the exec baseline, so a role can never exceed it', () => {
    const exec = new Set<Capability>(EXEC_BASELINE);
    for (const role of PERMISSION_ROLES) {
      for (const capability of ROLE_DEFAULTS[role]) {
        expect(exec.has(capability), `${role} grants ${capability}, which no exec holds`).toBe(true);
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
  // /announcements — intersected with the exec baseline. So they partition it
  // exactly, and that is not a coincidence to be preserved for its own sake: it
  // is the assertion that assigning a role does what assigning a portfolio did.
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
  it('partitions the exec baseline exactly, as the four portfolios did', () => {
    const fromRoles = PERMISSION_ROLES.flatMap((role) => [...ROLE_DEFAULTS[role]]);
    expect(new Set(fromRoles).size, 'two roles claim the same capability').toBe(fromRoles.length);
    expect([...fromRoles].sort()).toEqual([...EXEC_BASELINE].sort());
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
    expect(ROLE_DEFAULTS.tournaments.length).toBe(49);
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
// The ceiling this change ships with. Grant closure bounds what one person may
// hand another and cannot bound an ADMIN, who holds everything by level — so
// the set an admin may COMPOSE is capped at what execs already had, which is
// what keeps this change provably inside the envelope that shipped before it.

describe('EDITOR_OFFERABLE', () => {
  it('is exactly the exec baseline', () => {
    expect([...EDITOR_OFFERABLE]).toEqual([...EXEC_BASELINE]);
  });

  // Named one by one so that opening any of them is a diff somebody has to
  // read. These are the club's books, its rating and account rules, its audit
  // trail, and the ability to hand out permissions at all.
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
      'fees.clubfees.read',
      'fees.otherincome.read',
      'fees.netposition.read',
      'fees.reinstatements.read',
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
  it('makes an admin a superuser BY LEVEL, holding all 116', () => {
    for (const capability of CAPABILITIES) {
      expect(permits('admin', UNRESTRICTED, capability), capability).toBe(true);
    }
    expect(effectiveCapabilities('admin', UNRESTRICTED).size).toBe(116);
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

  it('is held by an unrestricted exec, exactly as it was before', () => {
    expect(permits('exec', UNRESTRICTED, VARSITY)).toBe(true);
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
