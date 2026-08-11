// WHO MAY OPEN THE ADMIN CONSOLE — the one implementation.
//
// This used to live only in apps/admin/src/lib/permissions.ts, which meant the
// members' app could not import it and grew its own hand-rolled copies instead:
// one in the top bar (`is_exec || is_trainer || role === 'admin'`) and a second,
// narrower one on the settings page (`is_exec || role === 'admin'`) that had
// never been told varsity trainers exist. The two disagreed, so a trainer saw
// the console link in the top bar and not in settings.
//
// It lives in @badminton/shared so both apps ask the same function. The
// admin-only pieces — which path needs which capability — stay in the admin app.
//
// THREE ORDERED LEVELS — admin > exec > trainer. The ordering still exists, but
// it now decides only two things: whether someone reaches the console at all,
// and which BASELINE an unrestricted person holds. What a person may DO is a set
// of capabilities, not a rung — see permits() below.
//
// The string literals must stay byte-identical to what admin_access_level()
// returns in the database (migrations 00054, 00057); the admin middleware feeds
// that value straight into canAccess(). A mismatch resolves to null, fails
// closed, and locks the level out with no error surfaced anywhere.
export type AccessLevel = 'admin' | 'exec' | 'trainer';

// Higher number = more access. Used for every comparison so a new level is one
// entry here rather than a new branch in each caller.
const LEVEL_RANK: Record<AccessLevel, number> = {
  admin: 3,
  exec: 2,
  trainer: 1,
};

/** Does `level` reach at least `required`? The one place the ordering lives. */
export function atLeast(level: AccessLevel | null | undefined, required: AccessLevel): boolean {
  if (!level) return false;
  return LEVEL_RANK[level] >= LEVEL_RANK[required];
}

/** The role markers a player row carries. */
export type AccessLevelInput = {
  role?: string | null;
  is_exec?: boolean | null;
  is_trainer?: boolean | null;
};

// ---------------------------------------------------------------------------
// THE CAPABILITY VOCABULARY
// ---------------------------------------------------------------------------
// One capability per distinct enforced action. `area ('.' resource)* '.' mode`,
// segments lower-case alphanumeric, mode ∈ {page, read, write}, depth 2–5.
//
// THREE MODES, because "may open this section" and "may see the data in it" are
// different questions and the club needs them answered separately. The owner's
// case is somebody who comes in to ADD without browsing: "access the page to add
// stuff, but not see the details in them".
//
//  - `<area>.page`                   may open the section. Depth 2, exactly one
//                                    per area, and the only thing the route gate
//                                    and the nav ever ask for.
//  - `<area>.<resource>.read`        may see that particular data. Gates an
//                                    individual FETCH, never a page shell.
//  - `<area>.<resource>.<verb>.write` may perform that action.
//
// A `.read` exists only where something is actually gated on it. Several areas
// have a page and no read at all, and that is correct rather than an omission —
// inventing a read nothing checks would be a tick box the app does not honour.
//
// This replaces exec portfolios, which were a closed set of four VP jobs. Four
// jobs could only ever cut the console four ways, and the club's real question
// turned out to be per-action ("this treasurer may see club fees but not hand
// out permissions"), which no fixed set of jobs answers.
//
// FIVE THINGS KEEP THIS LIST CLOSED, and none of them is optional:
//
//  1. One `as const` array, and `Capability` is a union of its members — never
//     `string`. Every gate takes a Capability, so a typo is a compile error at
//     the call site rather than a gate that silently admits nobody.
//  2. Nothing hand-types a capability anywhere else. The baselines, the gates
//     and (later) the editor all reference this array or its type.
//  3. CAPABILITY_GATES in ./capability-gates.ts names the enforcement point for
//     every entry. A capability with no gate is a promise the app does not keep.
//  4. Drift tests: the literal list is pinned, no capability's resource path is
//     a strict prefix of another's at the same mode, every first segment is an
//     area, every area has exactly one `.page`, and both baselines are subsets
//     of this list.
//  5. REMOVAL IS A MIGRATION. Once permissions are stored (00087), deleting a
//     capability while a stored `permission_revokes` array still names it turns
//     a live revoke into a silent no-op — the one way this model can widen
//     somebody by accident. Any removal ships with SQL stripping the string.
//
// LEAVES ONLY, NO PREFIX IMPLICATION. Holding `tournaments.manage.read` does not
// imply `tournaments.fees.read`; the interior nodes are grouping labels for the
// editor and are never grantable. Resolve-time implication is how permission
// systems grant things nobody reviewed — adding
// `players.editor.medicalhistory.write` under a coarse `players.write` would
// reach every holder of it with no diff and no audit row. permits() is plain set
// membership, and the no-prefix test is the belt to that pair of braces.

export const AREAS = [
  'players',
  'seasons',
  'sessions',
  'matches',
  'challenges',
  'announcements',
  'tournaments',
  'fees',
  'legal',
  'walkovers',
  'disputes',
  'permissions',
  'audit',
  'ratings',
  'accounts',
  'platform',
] as const;

export type Area = (typeof AREAS)[number];

export const CAPABILITIES = [
  // ---- players -----------------------------------------------------------
  // THE OWNER'S CASE, on the page they asked for it on: "access the page to add
  // stuff, but not see the details in them". `players.page` opens the section
  // and `players.read` buys the ROSTER — the list, one member's record, and the
  // count of them on the dashboard. Somebody handed the page and
  // players.create.write comes in to add a member and browses nobody.
  //
  // The roster used to ride on the page key, which made that impossible here
  // and only here: /fees had five separate fetch gates and /players had none,
  // so the one section the club most wanted split was the one that could not be.
  //
  // NOT the player PICKERS. The lists behind the create-match, create-challenge,
  // session-attendance and tournament-entrant forms are fetched by their own
  // sections and stay there: somebody who may enter a match result must be able
  // to name the players in it, and moving those behind this capability would
  // also put `players.read` in two roles at once, which the partition test
  // refuses.
  'players.page',
  'players.read',
  'players.approve.write',
  'players.create.write',
  'players.update.write',
  'players.waiver.resign.write',
  'players.ban.write',
  'players.reinstate.write',
  'players.editor.varsitynotes.write',
  'players.deletion.cancel.write',
  'players.remove.write',
  'players.merge.write',
  'players.reliability.write',
  // The GRANTABLE half of the old ADMIN_ONLY_PLAYER_FIELDS. The other half —
  // role, is_exec, is_trainer and the three permission_* columns — is a hard
  // floor that no capability reaches; see player-field-access.ts.
  'players.privilegedfields.write',

  // ---- seasons -----------------------------------------------------------
  'seasons.page',
  'seasons.create.write',
  'seasons.activate.write',
  'seasons.end.write',
  'seasons.fees.write',

  // ---- sessions ----------------------------------------------------------
  'sessions.page',
  'sessions.reminders.write',
  'sessions.create.write',
  'sessions.update.write',
  'sessions.archive.write',
  'sessions.checkin.token.write',
  'sessions.attendance.write',
  'sessions.delete.write',

  // ---- matches -----------------------------------------------------------
  'matches.page',
  'matches.void.write',
  'matches.convert.write',
  'matches.create.write',

  // ---- challenges --------------------------------------------------------
  // Their own area rather than part of `matches`: the two admin-only challenge
  // actions live in actions/matches.ts, but /challenges is its own section and
  // its own boundary. Filing them under matches would have handed both to every
  // exec, because everything else in that file is exec work.
  'challenges.page',
  'challenges.create.write',
  'challenges.expire.write',

  // ---- announcements -----------------------------------------------------
  'announcements.page',
  'announcements.create.write',
  'announcements.update.write',
  'announcements.delete.write',

  // ---- tournaments -------------------------------------------------------
  // The largest area by a distance: 43 of the 116. Four groups, and the split
  // matters — running a draw, entering results and handling entry money are
  // three different jobs that happen to share a section.
  //
  // `tournaments.fees.read` is the one read that survives here, and it is a read
  // rather than a second page because a page is one per AREA: entry money sits
  // at /tournaments/<id>/fees, inside a section execs already reach, and its own
  // roster is the data being withheld.
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
  'tournaments.fees.read',
  'tournaments.fees.tier.create.write',
  'tournaments.fees.tier.update.write',
  'tournaments.fees.tier.delete.write',
  'tournaments.fees.markpaid.write',
  'tournaments.fees.markunpaid.write',

  // ---- fees --------------------------------------------------------------
  // Four ledgers plus the net position, each with its own read, under one page
  // key. /fees is a single section that has always been two boundaries: an exec
  // may file the expense they paid out of pocket, and nothing else on the page
  // is theirs.
  //
  // THE AREA THE THREE-MODE SPLIT WAS FOR. `fees.page` plus
  // `fees.expenses.add.write` and no read at all opens the section, shows no
  // ledger and no net position, and offers the Add expense form — the club
  // owner's "access the page to add stuff, but not see the details in them",
  // which the old model could not express at all.
  'fees.page',
  'fees.expenses.read',
  'fees.expenses.add.write',
  'fees.expenses.update.write',
  'fees.expenses.reimburse.write',
  'fees.expenses.remove.write',
  'fees.otherincome.read',
  'fees.otherincome.add.write',
  'fees.otherincome.remove.write',
  'fees.clubfees.read',
  'fees.clubfees.markpaid.write',
  'fees.clubfees.markunpaid.write',
  'fees.clubfees.waive.write',
  'fees.clubfees.addmanual.write',
  'fees.clubfees.removemanual.write',
  'fees.reinstatements.read',
  'fees.reinstatements.write',
  'fees.netposition.read',
  'fees.playerflags.write',

  // ---- legal -------------------------------------------------------------
  'legal.page',
  'legal.reacceptance.write',
  'legal.documents.write',
  'legal.waivertemplate.write',

  // ---- walkovers ---------------------------------------------------------
  'walkovers.page',
  'walkovers.confirm.write',
  'walkovers.reject.write',

  // ---- disputes ----------------------------------------------------------
  'disputes.page',
  'disputes.resolve.write',

  // ---- permissions -------------------------------------------------------
  // The dangerous pair. A holder of permissions.write can hand out any
  // capability they themselves hold — grant closure bounds that, but within the
  // bound it is unlimited and the audit log is the only trace.
  'permissions.page',
  'permissions.write',

  // ---- audit / ratings / accounts ----------------------------------------
  // Sections whose whole content is their page. Each is its own area so that
  // opening one to somebody does not open the others.
  'audit.page',
  'ratings.page',
  'accounts.page',

  // ---- platform ----------------------------------------------------------
  // THE ONE AREA WITH NO ROUTE OF ITS OWN. Platform settings are a form drawn
  // inside /ratings and /accounts, so `platform.page` gates that form rather
  // than a path in the section map. It exists because every capability in an
  // area requires that area's page — without it, platform.settings.write would
  // be pruned from anybody the resolver ever runs for.
  'platform.page',
  'platform.settings.write',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const ALL_CAPABILITIES: ReadonlySet<Capability> = new Set(CAPABILITIES);

/** Narrow an arbitrary stored string to a capability the vocabulary still has. */
export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && ALL_CAPABILITIES.has(value as Capability);
}

/**
 * The page capability of the area a capability belongs to — `fees.expenses.read`
 * → `fees.page`, and `fees.page` → itself.
 *
 * A plain first-segment lookup, which is the whole reason the new invariant
 * fires for every capability where the old `write ⊆ read` prune fired for two of
 * ninety-three: it never has to find a sibling that might not exist. Every area
 * has a page, pinned by a test, so the cast cannot be wrong.
 */
export function pageOf(capability: Capability): Capability {
  return `${capability.split('.')[0]}.page` as Capability;
}

// ---------------------------------------------------------------------------
// BASELINES — what a level holds when nobody has narrowed or composed it
// ---------------------------------------------------------------------------
// THE DEPLOY-DAY GUARANTEE. Every row ships unrestricted, so every exec resolves
// to EXEC_BASELINE and every trainer to TRAINER_BASELINE. These two lists are
// therefore not a design — they are a TRANSCRIPTION of what those levels could
// do the day before this shipped, and each entry was checked against the gate
// function that used to stand there (getExecOrAdmin = exec, getAdminPlayer =
// admin only). The capability-equivalence test writes the same fact out a second
// time, by hand, from the call sites; if the two derivations ever disagree,
// somebody has widened a level.
//
// "Unrestricted" is the LEVEL's baseline, not everything. An unrestricted exec
// holds 71 capabilities, not 116.
//
// EVERY AREA A BASELINE REACHES CARRIES THAT AREA'S `.page`. Not a style rule:
// the resolver prunes any capability whose area page is missing, so a baseline
// without one would be a level that can do nothing anywhere.

export const TRAINER_BASELINE: readonly Capability[] = [
  // The entire trainer level, and it always was: open the roster, READ it so you
  // can find the person you are writing about, and write the note. Matches
  // TRAINER_WRITABLE_PLAYER_FIELDS being empty — a trainer changes nothing on a
  // player record itself.
  //
  // The read is here because a trainer browses the roster today. It is the whole
  // reason they have a console at all, and leaving it out would have made
  // gating the roster fetch a change that took the section away from a level.
  'players.page',
  'players.read',
  'players.editor.varsitynotes.write',
];

export const EXEC_BASELINE: readonly Capability[] = [
  // Roster. Approve, add, edit, ban, reinstate, require a re-signature, and
  // write coaching notes. NOT: cancelling a deletion, removing, merging,
  // adjusting reliability, or any privileged field — all of those stood behind
  // getAdminPlayer().
  //
  // The read is here as well as the page for the same reason it is in the
  // trainer baseline: an exec browses the roster today, and the fetch behind it
  // is now asked for separately.
  'players.page',
  'players.read',
  'players.approve.write',
  'players.create.write',
  'players.update.write',
  'players.waiver.resign.write',
  'players.ban.write',
  'players.reinstate.write',
  'players.editor.varsitynotes.write',

  // Seasons, except setting the fees — money has always been admin work.
  'seasons.page',
  'seasons.create.write',
  'seasons.activate.write',
  'seasons.end.write',

  // Sessions, all of them.
  'sessions.page',
  'sessions.reminders.write',
  'sessions.create.write',
  'sessions.update.write',
  'sessions.archive.write',
  'sessions.checkin.token.write',
  'sessions.attendance.write',
  'sessions.delete.write',

  // Ladder matches, all of them. Challenges are NOT here: both challenge
  // actions live in the same file and both stood behind getAdminPlayer().
  'matches.page',
  'matches.void.write',
  'matches.convert.write',
  'matches.create.write',

  // Announcements, all of them.
  'announcements.page',
  'announcements.create.write',
  'announcements.update.write',
  'announcements.delete.write',

  // Tournaments: the whole of manage, draw and results. Entry fees are the one
  // group execs never reached — /tournaments/<id>/fees was the single
  // admin-only sub-route under an exec-allowed section, and it stays out of
  // reach because `tournaments.fees.read` is not here, not because the page is.
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
  // Placement bonuses, standings and finalising an event are exec work because
  // an exec who enters results already moves Elo on every match; finalising
  // applies the same authority once more. The admin/exec line on ratings is
  // about HAND-EDITING a rating, not about the engine applying one.
  'tournaments.results.bonuses.write',
  'tournaments.results.standings.write',
  'tournaments.results.finalize.write',

  // Money: the Expenses tab and nothing else on /fees. The club owner's rule
  // was "execs can add expenses", not "execs can see the books" — club fees,
  // other income, reinstatements and the net position stayed admin-only, and
  // /fees enforced that by skipping their FETCHES rather than hiding cards.
  //
  // The read is here as well as the page because an exec sees the expense
  // LEDGER today, not just the form. Dropping it would be the change this task
  // is forbidden to make.
  'fees.page',
  'fees.expenses.read',
  'fees.expenses.add.write',

  // Legal: open the documents and require a re-signature. Editing the text is
  // admin work.
  'legal.page',
  'legal.reacceptance.write',
];

const BASELINES: Record<AccessLevel, ReadonlySet<Capability>> = {
  // Admin is a superuser BY LEVEL, so a capability added next year is
  // automatically theirs and there is no list to keep in sync.
  admin: ALL_CAPABILITIES,
  exec: new Set(EXEC_BASELINE),
  trainer: new Set(TRAINER_BASELINE),
};

// ---------------------------------------------------------------------------
// ROLES
// ---------------------------------------------------------------------------
// The club's four VP jobs, kept as a closed list so that assigning one is a
// named act rather than a hand-assembled set of ticks.
//
// A role REPLACES the base rather than adding to it: the VP of Tournaments must
// not reach the books, and a purely additive role would need a dozen
// hand-written revokes to achieve that.
//
// EVERY ROLE IS A SUBSET OF EXEC_BASELINE, pinned by a test, and that is the
// whole property this table is built to have: a role is bounded by what execs
// could already do, so nothing beyond today's scope for an area (the club's
// books, reinstatements, the net position) can arrive from choosing a word. It
// is handed over per person by an explicit grant, which is a reviewed act with
// an audit row.
//
// THAT IS A BOUND, NOT A DIRECTION, and the difference started mattering when
// trainers became composable. While roles were exec-only the two were the same
// thing — the role was a subset of the target's OWN base, so picking one could
// only subtract, and this comment used to say assigning a role was never itself
// a widening. On a trainer it plainly is: ROLE_DEFAULTS.tournaments is fifty
// capabilities against a baseline of three, and giving a varsity trainer the
// club's competitive calendar without making them an exec is the reason
// composition was opened to them. What survives, unchanged and load-bearing, is
// the ceiling: whoever is composed, a role can only ever leave them inside the
// exec baseline.
//
// The four lists are NOT a new design. They are the old SECTION_PORTFOLIO map —
// the four VP jobs, each owning a set of sections — intersected with
// EXEC_BASELINE, and they still partition it exactly: finance had /fees,
// tournaments had /tournaments /matches /sessions, internal had /players
// /seasons, external had /legal /announcements. Deriving them that way rather
// than writing four fresh lists is what makes "assigning a role does the same
// thing the portfolio did" a fact instead of a hope.
//
// EVERY ROLE CARRIES THE PAGE FOR EVERY AREA IT TOUCHES. That is now an
// invariant of the resolver rather than a courtesy: a capability whose area page
// is absent is pruned, so a role missing one would grant nothing at all in that
// area. Pinned by a test.
//
// `custom` IS NOT A FIFTH VP JOB. It is the empty base — a role whose defaults
// are nothing, so the whole of a hand-picked set lives in `permission_grants`
// and reads back exactly as it was chosen.
//
// It exists because the storage cannot express a hand-picked set any other way.
// resolvePermissions() reads a NULL role as "not composed" and does not consult
// the deltas at all, so anything stored has to name a role — and before this
// existed, the editor's only way to hand somebody a set of its own was to borrow
// the closest VP name and paper over the difference with grants and revokes. A
// varsity trainer who ticked one session capability would have been stored as
// `finance` with three revokes of the club's expense capabilities: a row that
// says the trainer is the treasurer, an audit entry that says the same, and —
// the part that actually bites — membership of the blast radius of any future
// edit to ROLE_DEFAULTS.finance. An empty base has no blast radius, because
// there is nothing in it to change.
export type PermissionRole = 'finance' | 'tournaments' | 'internal' | 'external' | 'custom';

// The four jobs first and `custom` last, because this order is the order the
// editor offers them in and a named job is the choice to reach for first.
export const PERMISSION_ROLES: readonly PermissionRole[] = [
  'finance',
  'tournaments',
  'internal',
  'external',
  'custom',
] as const;

/**
 * Shown wherever a role is chosen or reported.
 *
 * `custom` is 'Hand-picked' rather than 'Custom' because the editor already uses
 * the word Custom for the STATE of a row that has been adjusted — "Custom —
 * Finance with 3 granted" — so a role called Custom reads back as "Custom —
 * Custom" in four places.
 */
export const PERMISSION_ROLE_LABELS: Record<PermissionRole, string> = {
  finance: 'Finance',
  tournaments: 'Tournaments',
  internal: 'Internal',
  external: 'External',
  custom: 'Hand-picked',
};

export const ROLE_DEFAULTS: Record<PermissionRole, readonly Capability[]> = {
  // The Expenses tab and nothing further — 00086's behaviour exactly. Club
  // money, other income, the net position and reinstatements are NOT here even
  // though a treasurer is the obvious person to hold them: the club owner's
  // rule was "execs can add expenses", and a role that reached the books would
  // be the first role to put somebody outside the exec baseline.
  finance: [
    'fees.page',
    'fees.expenses.read',
    'fees.expenses.add.write',
  ],

  // Running the club's competitive calendar: the draw, the ladder and the
  // weekly sessions. Entry money (`tournaments.fees.*`) is deliberately absent
  // — it was admin-only before and it stays admin-only, which is also why the
  // old portfolio could not reach /tournaments/<id>/fees.
  tournaments: [
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
  ],

  // The membership: who is on the roster and which term they are playing in.
  // `seasons.fees.write` is absent for the same reason `finance` stops at
  // expenses — setting what a term costs is admin work and always was.
  internal: [
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
  ],

  // What the club says to its members and what they sign. Opening the legal
  // documents and forcing a re-signature, but not editing the text — that split
  // predates capabilities and is unchanged.
  external: [
    'announcements.page',
    'announcements.create.write',
    'announcements.update.write',
    'announcements.delete.write',
    'legal.page',
    'legal.reacceptance.write',
  ],

  // EMPTY, AND THAT IS THE WHOLE DEFINITION. Everything a hand-picked person
  // holds is in their grants, so the row says what they hold rather than a name
  // plus two corrections. It satisfies the invariants above for free: the empty
  // set is inside the exec baseline, has no duplicates, and touches no area
  // whose page it could be missing.
  custom: [],
};

// WHAT THE EDITOR MAY HAND OUT — the exec baseline, and nothing above it.
//
// The one line that keeps composition provably inside the old envelope. Every
// capability outside EXEC_BASELINE (the club's books, reinstatements, audit,
// ratings, accounts, platform settings, permissions.write itself) is admin work
// today, and offering it here would put somebody outside everything an exec
// could already do. It ships with storage, grant closure and the editor proven
// first, and exposing the rest is its own small reviewable diff.
//
// A COMPOSED TRAINER IS BOUNDED BY THE SAME LINE, and it is the only thing
// bounding them: composing a trainer WIDENS them past their level, on purpose,
// so "nothing here can widen anyone" is not the property this constant has.
// The property it has is a ceiling — nobody, whatever their level, can be
// composed above what an exec already held.
//
// Grant closure would already stop a non-admin handing out anything they do not
// hold; this bounds what an ADMIN can hand out too, which closure by definition
// cannot.
export const EDITOR_OFFERABLE: readonly Capability[] = EXEC_BASELINE;

// ---------------------------------------------------------------------------
// CUSTOM BASELINES — the ones the club writes for itself
// ---------------------------------------------------------------------------
// ROLE_DEFAULTS is four VP jobs in a compile-time constant, so a fifth is a
// deploy, and the club owner asked for more: "I should be able to create new
// baselines, since we will have others."
//
// A CUSTOM BASELINE IS A NAMED CAPABILITY SET IN THE DATABASE
// (permission_baselines, 00093) THAT IS COPIED ONTO A ROW, NOT RESOLVED
// THROUGH. Assigning one writes permission_role = 'custom' — the empty base —
// and its capabilities into permission_grants. resolvePermissions() is
// untouched by this feature and does not know the table exists.
//
// THAT IS THE ANSWER TO THE CRUX, and the crux is real: the resolver is pure
// and synchronous and is reached from 22 places in the admin app. Passing the
// baseline in as a fourth argument would mean finding all 22, and a call site
// that forgot would resolve a person's entire base to nothing — safe, but
// silently so, in twenty-two places, including the edge middleware where the
// lookup would also become a per-request round trip.
//
// WHAT IS GIVEN UP: a baseline is a TEMPLATE PLUS EXPLICIT PROPAGATION rather
// than a live reference. Editing one re-copies to every holder inside the same
// action, each write closure-checked and audited — which is more traceable than
// ROLE_DEFAULTS, where changing what 'finance' means leaves no row anywhere.
//
// NOTHING BELOW IS A SECOND RESOLVER. These are the rules a stored set must
// satisfy to be worth storing, and every one of them is a rule the assignment
// path already enforces per person; they are here so a baseline is refused when
// it is WRITTEN rather than silently doing nothing when it is USED.

/** A named capability set as the console reads it back. */
export type CustomBaseline = {
  id: string;
  name: string;
  capabilities: readonly Capability[];
};

/** Matches the length CHECK on permission_baselines.name. */
export const BASELINE_NAME_MAX = 40;

/**
 * Why this cannot be a baseline name, or null.
 *
 * Uniqueness is NOT here: it is a question about the other rows, answered by
 * permission_baselines_name_key and reported by the action that met it.
 */
export function baselineNameRefusal(name: string): string | null {
  const trimmed = name.trim();
  if (trimmed === '') return 'A baseline needs a name.';
  if (trimmed.length > BASELINE_NAME_MAX) {
    return `A baseline name is at most ${BASELINE_NAME_MAX} characters.`;
  }
  return null;
}

/**
 * Why these capabilities cannot be a baseline, or null. Four rules, in the same
 * order setPlayerPermissions applies its equivalents.
 *
 * `held` IS THE AUTHOR'S OWN RESOLVED SET, and passing it in is what makes this
 * usable on both sides of the boundary without being the boundary. The server
 * action derives it from the actor's row through effectiveCapabilities(), which
 * is the single source of truth for grant closure; the editor passes the copy
 * the server already sent it, to refuse early. A caller who passed something
 * else would be checking a number it chose — which is exactly why the server
 * never takes this from the client.
 */
export function baselineCapabilityRefusal(
  capabilities: readonly string[],
  held: ReadonlySet<Capability>,
): string | null {
  const unknown = capabilities.filter((capability) => !isCapability(capability));
  if (unknown.length > 0) {
    return `Not something this console knows about: ${unknown.join(', ')}`;
  }
  const wanted = [...new Set(capabilities as readonly Capability[])];
  if (wanted.length === 0) {
    return 'A baseline needs at least one capability, or it is a name that does nothing.';
  }

  // GRANT CLOSURE, at authoring time. Without this an officer with a narrow
  // permissions.write could WRITE DOWN a baseline naming capabilities they do
  // not hold. Assigning it would be refused — setPlayerPermissions checks the
  // actor's set again, per person — so it is not an escalation; it is a saved,
  // named, unassignable thing, and the person who saved it has no way to tell
  // why. Refuse it where it is authored, in the same words.
  const cannotHold = wanted.filter((capability) => !held.has(capability));
  if (cannotHold.length > 0) {
    return `You cannot put ${cannotHold.join(', ')} in a baseline because you do not hold ${cannotHold.length === 1 ? 'it' : 'them'}.`;
  }

  // THE SAME CEILING THE EDITOR HAS. Closure cannot bound an admin, who holds
  // everything by level, so without this an admin could author a baseline
  // containing permissions.write — and then meet check 5 of
  // setPlayerPermissions every time they tried to assign it.
  const offerable = new Set<Capability>(EDITOR_OFFERABLE);
  const notOfferable = wanted.filter((capability) => !offerable.has(capability));
  if (notOfferable.length > 0) {
    return `${notOfferable.join(', ')} cannot be handed out yet — ${notOfferable.length === 1 ? 'it is' : 'they are'} admin-only.`;
  }

  // THE RESOLVER'S ONE STRUCTURAL INVARIANT, applied to the stored array.
  //
  // Expressible here, unlike on a player row, because a baseline has no revokes
  // and no base underneath it: the array IS the resolved set. Without this a
  // baseline of ['fees.expenses.add.write'] saves, assigns, audits — and
  // resolves to nothing at all, because the resolver prunes every capability
  // whose area page is absent.
  //
  // REFUSED RATHER THAN REPAIRED. Adding the missing page for the author would
  // be resolve-time implication by another name: a capability arriving in a set
  // somebody reviewed, without them reviewing it.
  const present = new Set(wanted);
  const missingPages = [
    ...new Set(wanted.map(pageOf).filter((page) => !present.has(page))),
  ];
  if (missingPages.length > 0) {
    return `Add ${missingPages.join(', ')} — nothing in an area applies without that area's page.`;
  }

  return null;
}

/** The array as it would be STORED: de-duplicated and sorted. */
export function normaliseBaselineCapabilities(
  capabilities: readonly Capability[],
): Capability[] {
  return [...new Set(capabilities)].sort();
}

// ---------------------------------------------------------------------------
// PERMISSIONS
// ---------------------------------------------------------------------------
// A TAGGED UNION so "unrestricted" can never be mistaken for "empty". The two
// mean opposite things — one is everything the level has always had, the other
// is nothing at all — and a bare Set<Capability> would spell them the same way
// the moment someone forgot to distinguish them.
export type Permissions =
  | { kind: 'unrestricted' }
  | { kind: 'restricted'; capabilities: ReadonlySet<Capability> };

/** The state every row is in until an admin composes one. Shared, frozen. */
export const UNRESTRICTED: Permissions = Object.freeze({ kind: 'unrestricted' as const });

/** Where the resolved permission triple is stored on a player row. */
export type PermissionsInput = {
  permission_role?: string | null;
  permission_grants?: string[] | null;
  permission_revokes?: string[] | null;
};

/**
 * Turn the stored triple into a set. Pure, LEVEL-AGNOSTIC and exported for
 * tests: it knows nothing about admins, execs or trainers, and the level enters
 * only at permits(), where it chooses which baseline an unrestricted person
 * holds. That is why varsity notes need no special case — one capability, three
 * baseline entries.
 *
 * Order is load-bearing. Pruning before subtraction would let a revoked page
 * keep the section it was supposed to close.
 */
export function resolvePermissions(
  role: string | null | undefined,
  grants: readonly string[],
  revokes: readonly string[],
): Permissions {
  // Not narrowed, and not COMPOSED either. The deltas are deliberately NOT
  // consulted: if an absent role meant an empty base, adding the first grant to
  // an unrestricted exec would flip their base from the whole exec baseline to
  // zero — a grant that removes fifty-odd capabilities, one click, silent, in
  // exactly the direction this feature exists to control.
  if (role == null || role === '') return UNRESTRICTED;

  // An unrecognised role gets NO defaults rather than the exec baseline. The
  // safe reading of a role nobody can interpret is "grants nothing".
  const base = (ROLE_DEFAULTS as Record<string, readonly Capability[]>)[role] ?? [];

  const effective = new Set<Capability>();
  for (const cap of base) effective.add(cap);
  // Intersecting with the vocabulary as we go: an element naming a capability
  // this build no longer has is dropped, inert rather than a member nothing
  // reads.
  for (const cap of grants) if (isCapability(cap)) effective.add(cap);
  // REVOKE BEATS GRANT. Disjointness is a database CHECK, but the resolver has
  // to be total — a row that somehow holds both must have one clear answer.
  for (const cap of revokes) if (isCapability(cap)) effective.delete(cap);

  // THE ONE STRUCTURAL INVARIANT: every capability in an area requires that
  // area's page. Applied AFTER subtraction, and that order is the whole reason
  // it is here rather than in a CHECK — revoking `fees.page` has to take the
  // ledgers and the ledger controls with it even when they came from the ROLE
  // and are named nowhere in either array. Closing a section has to close it.
  //
  // THIS REPLACES `write ⊆ read`, which is GONE and must not come back. Write
  // without read is now a supported state — the club owner asked for people who
  // can "access the page to add stuff, but not see the details in them", and the
  // old rule made exactly that impossible. It was also broken: it looked for an
  // exact sibling by swapping `.write` for `.read` at the same path, which only
  // two of the ninety-three writes had, so it fired for two and silently did
  // nothing for ninety-one. This one is a first-segment lookup, so it fires for
  // every capability there is.
  for (const cap of Array.from(effective)) {
    const page = pageOf(cap);
    if (cap === page) continue;
    if (!effective.has(page)) effective.delete(cap);
  }

  return { kind: 'restricted', capabilities: effective };
}

/**
 * Read the triple off a player row.
 *
 * ALL THREE COLUMNS ABSENT means unrestricted, and it is the first line on
 * purpose: this is the heir of `portfolioOf({}) === null`, and it is what makes
 * the code safe to deploy before the storage migration is applied. Treating a
 * missing column as "unknown, deny" would lock every exec out of the console the
 * moment this shipped.
 *
 * A ROLE WITH A MISSING ARRAY THROWS. The columns are NOT NULL, so this can only
 * come from a narrowed SELECT — a programming error, not a state. The obvious
 * `?? []` would silently discard revokes, and a discarded revoke can leave
 * somebody holding permissions.write.
 */
export function permissionsOf(player: PermissionsInput | null | undefined): Permissions {
  if (!player) return UNRESTRICTED;
  const hasRole = 'permission_role' in player;
  const hasGrants = 'permission_grants' in player;
  const hasRevokes = 'permission_revokes' in player;
  if (!hasRole && !hasGrants && !hasRevokes) return UNRESTRICTED;

  const role = player.permission_role ?? null;
  if (role === null || role === '') return UNRESTRICTED;

  if (!hasGrants || !hasRevokes) {
    throw new Error(
      'permissionsOf: player row has permission_role but not both delta columns — narrow the SELECT less',
    );
  }
  return resolvePermissions(role, player.permission_grants ?? [], player.permission_revokes ?? []);
}

/**
 * The stored triple as a plain object, or null for a row that predates the
 * storage migration.
 *
 * Exists because a resolved `Permissions` cannot cross the server/client
 * boundary: its payload is a Set, and the thing a server component hands a
 * client component has to be plain data. So the SERVER sends the same three
 * columns the database holds and the CLIENT calls permissionsOf() on them —
 * one resolver, run twice, rather than a second wire format that could
 * disagree with it.
 *
 * Returning null rather than an empty triple keeps the "columns absent means
 * unrestricted" reading intact across that boundary: an empty triple would
 * resolve identically today, but it says "this row is not narrowed" where null
 * says "this build has not been told", and only the second one stays true if
 * the meaning of an empty triple ever changes.
 */
export function permissionTripleOf(
  player: PermissionsInput | null | undefined,
): PermissionsInput | null {
  if (!player) return null;
  if (
    !('permission_role' in player)
    && !('permission_grants' in player)
    && !('permission_revokes' in player)
  ) {
    return null;
  }
  // Validated by the resolver rather than by a `?? []` here. A role with a
  // missing delta column throws, and it has to throw on this path too:
  // serialising it as an empty array would discard a revoke on the way to the
  // client, which is the one direction this model must never fail in.
  permissionsOf(player);
  return {
    permission_role: player.permission_role ?? null,
    permission_grants: player.permission_grants ?? [],
    permission_revokes: player.permission_revokes ?? [],
  };
}

const EMPTY_CAPABILITIES: ReadonlySet<Capability> = new Set<Capability>();

/**
 * Everything this person may do. permits() is defined in terms of this so the
 * gates and the "effective access" the editor shows can never be two
 * implementations that disagree.
 */
export function effectiveCapabilities(
  level: AccessLevel | null | undefined,
  permissions: Permissions,
): ReadonlySet<Capability> {
  if (!level) return EMPTY_CAPABILITIES;
  if (level === 'admin') return ALL_CAPABILITIES;
  if (permissions.kind === 'unrestricted') return BASELINES[level];
  return permissions.capabilities;
}

/**
 * The one authorisation question. Plain set membership — no prefix implication,
 * no ladder logic, and no minimum level: a trainer calling
 * tournaments.manage.create.write fails because it is not in TRAINER_BASELINE,
 * not because a rung was compared.
 */
export function permits(
  level: AccessLevel | null | undefined,
  permissions: Permissions,
  capability: Capability,
): boolean {
  return effectiveCapabilities(level, permissions).has(capability);
}

/** Standing is a separate question from level — see isInGoodStanding. */
export type StandingInput = {
  is_banned?: boolean | null;
  status?: string | null;
  active_flag?: boolean | null;
};

// The HIGHEST level the markers grant, so they compose: someone who is both a
// trainer and an exec is simply an exec, and a trainer who is also an admin is
// an admin. A restriction always applies to the level a person resolves TO,
// never to a flag in isolation.
//
// This answers "what level do these markers grant" and nothing else. It does
// NOT check standing — see hasConsoleAccess for the gate a UI should use.
export function accessLevelFor(player: AccessLevelInput | null | undefined): AccessLevel | null {
  if (!player) return null;
  if (player.role === 'admin') return 'admin';
  if (player.is_exec === true) return 'exec';
  if (player.is_trainer === true) return 'trainer';
  return null;
}

// Standing gate, mirroring admin_access_level() in migration 00057 and the
// checks in the admin app's getAuthenticatedAtLeast(). A banned, suspended,
// pending or deactivated account holds no console level at all.
//
// COALESCE semantics matter: a row that is missing is_banned/active_flag (a
// narrowed select) must read as "not banned, still active" exactly as the SQL
// does, or a partial select silently locks someone out.
export function isInGoodStanding(player: StandingInput | null | undefined): boolean {
  if (!player) return false;
  if (player.is_banned === true) return false;
  if (player.status === 'suspended' || player.status === 'pending_approval') return false;
  if (player.active_flag === false) return false;
  return true;
}

// Standing FIRST, then level — the composition the console actually enforces.
// Use this to decide whether to SHOW a route into the console; the server-side
// gates (admin_access_level() in the middleware, requireCapability() in server
// actions) remain the security boundary.
export function consoleAccessLevelFor(
  player: (AccessLevelInput & StandingInput) | null | undefined,
): AccessLevel | null {
  if (!isInGoodStanding(player)) return null;
  return accessLevelFor(player);
}

/** Any console access at all, standing included. */
export function hasConsoleAccess(
  player: (AccessLevelInput & StandingInput) | null | undefined,
): boolean {
  return consoleAccessLevelFor(player) !== null;
}
