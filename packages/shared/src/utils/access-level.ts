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
// segments lower-case alphanumeric, mode ∈ {read, write}, depth 2–5.
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
//     area, every area has at least one capability, and both baselines are
//     subsets of this list.
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
  'seasons.read',
  'seasons.create.write',
  'seasons.activate.write',
  'seasons.end.write',
  'seasons.fees.write',

  // ---- sessions ----------------------------------------------------------
  'sessions.read',
  'sessions.reminders.write',
  'sessions.create.write',
  'sessions.update.write',
  'sessions.archive.write',
  'sessions.checkin.token.write',
  'sessions.attendance.write',
  'sessions.delete.write',

  // ---- matches -----------------------------------------------------------
  'matches.read',
  'matches.void.write',
  'matches.convert.write',
  'matches.create.write',

  // ---- challenges --------------------------------------------------------
  // Their own area rather than part of `matches`: the two admin-only challenge
  // actions live in actions/matches.ts, but /challenges is its own section and
  // its own boundary. Filing them under matches would have handed both to every
  // exec, because everything else in that file is exec work.
  'challenges.read',
  'challenges.create.write',
  'challenges.expire.write',

  // ---- announcements -----------------------------------------------------
  'announcements.read',
  'announcements.create.write',
  'announcements.update.write',
  'announcements.delete.write',

  // ---- tournaments -------------------------------------------------------
  // The largest area by a distance: 43 of the 113. Four groups, and the split
  // matters — running a draw, entering results and handling entry money are
  // three different jobs that happen to share a section.
  'tournaments.manage.read',
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
  // Four ledgers plus the net position, each with its own read. /fees is a
  // single section that has always been two boundaries: an exec may file the
  // expense they paid out of pocket, and nothing else on the page is theirs.
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
  'legal.read',
  'legal.reacceptance.write',
  'legal.documents.write',
  'legal.waivertemplate.write',

  // ---- walkovers ---------------------------------------------------------
  'walkovers.read',
  'walkovers.confirm.write',
  'walkovers.reject.write',

  // ---- disputes ----------------------------------------------------------
  'disputes.read',
  'disputes.resolve.write',

  // ---- permissions -------------------------------------------------------
  // The dangerous pair. A holder of permissions.write can hand out any
  // capability they themselves hold — grant closure bounds that, but within the
  // bound it is unlimited and the audit log is the only trace.
  'permissions.read',
  'permissions.write',

  // ---- audit / ratings / accounts ----------------------------------------
  // Read-only sections. Each is its own area so that opening one to somebody
  // does not open the others.
  'audit.read',
  'ratings.read',
  'accounts.read',

  // ---- platform ----------------------------------------------------------
  'platform.settings.write',
] as const;

export type Capability = (typeof CAPABILITIES)[number];

const ALL_CAPABILITIES: ReadonlySet<Capability> = new Set(CAPABILITIES);

/** Narrow an arbitrary stored string to a capability the vocabulary still has. */
export function isCapability(value: unknown): value is Capability {
  return typeof value === 'string' && ALL_CAPABILITIES.has(value as Capability);
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
// holds 69 capabilities, not 113.

export const TRAINER_BASELINE: readonly Capability[] = [
  // The entire trainer level, and it always was: read the roster so you can
  // find the person you are writing about, and write the note. Matches
  // TRAINER_WRITABLE_PLAYER_FIELDS being empty — a trainer changes nothing on a
  // player record itself.
  'players.read',
  'players.editor.varsitynotes.write',
];

export const EXEC_BASELINE: readonly Capability[] = [
  // Roster. Approve, add, edit, ban, reinstate, require a re-signature, and
  // write coaching notes. NOT: cancelling a deletion, removing, merging,
  // adjusting reliability, or any privileged field — all of those stood behind
  // getAdminPlayer().
  'players.read',
  'players.approve.write',
  'players.create.write',
  'players.update.write',
  'players.waiver.resign.write',
  'players.ban.write',
  'players.reinstate.write',
  'players.editor.varsitynotes.write',

  // Seasons, except setting the fees — money has always been admin work.
  'seasons.read',
  'seasons.create.write',
  'seasons.activate.write',
  'seasons.end.write',

  // Sessions, all of them.
  'sessions.read',
  'sessions.reminders.write',
  'sessions.create.write',
  'sessions.update.write',
  'sessions.archive.write',
  'sessions.checkin.token.write',
  'sessions.attendance.write',
  'sessions.delete.write',

  // Ladder matches, all of them. Challenges are NOT here: both challenge
  // actions live in the same file and both stood behind getAdminPlayer().
  'matches.read',
  'matches.void.write',
  'matches.convert.write',
  'matches.create.write',

  // Announcements, all of them.
  'announcements.read',
  'announcements.create.write',
  'announcements.update.write',
  'announcements.delete.write',

  // Tournaments: the whole of manage, draw and results. Entry fees are the one
  // group execs never reached — /tournaments/<id>/fees was the single
  // admin-only sub-route under an exec-allowed section.
  'tournaments.manage.read',
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
  'fees.expenses.read',
  'fees.expenses.add.write',

  // Legal: read the documents and require a re-signature. Editing the text is
  // admin work.
  'legal.read',
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
// ROLE_DEFAULTS IS EMPTY UNTIL THE STORAGE MIGRATION (00087) LANDS, and that is
// deliberate rather than unfinished. Nothing can assign a role yet —
// permission_role does not exist as a column and every caller passes
// UNRESTRICTED — so a populated table here would be unreviewable content that
// nothing exercises. An empty base is also the fail-closed reading, which is
// what an unrecognised role gets too.
export type PermissionRole = 'finance' | 'tournaments' | 'internal' | 'external';

export const PERMISSION_ROLES: readonly PermissionRole[] = [
  'finance',
  'tournaments',
  'internal',
  'external',
] as const;

export const ROLE_DEFAULTS: Record<PermissionRole, readonly Capability[]> = {
  finance: [],
  tournaments: [],
  internal: [],
  external: [],
};

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
 * Order is load-bearing. Pruning before subtraction would let a revoked read
 * keep its write.
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

  // write ⊆ read, applied AFTER subtraction. This is no longer expressible in
  // SQL because it is a property of the RESOLVED set, so it lives here: taking
  // away someone's view of a ledger has to take away their ability to write to
  // it, or they keep a control they cannot see the consequences of.
  for (const cap of Array.from(effective)) {
    if (!cap.endsWith('.write')) continue;
    const sibling = `${cap.slice(0, -'.write'.length)}.read`;
    if (isCapability(sibling) && !effective.has(sibling)) effective.delete(cap);
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
