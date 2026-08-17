// WHERE EVERY CAPABILITY IS ACTUALLY ENFORCED.
//
// 119 capabilities is 119 promises that something in the app checks something.
// This map is what keeps them honest: every entry names the file and function
// that stands behind it, and the drift test asserts the map is exhaustive, that
// no two capabilities claim the same enforcement point, and that any capability
// covering more than one call site says WHY those sites are one act.
//
// Without it the permission editor becomes a UI that lies — a tick box for
// something no gate reads.
//
// SEPARATE MODULE from ./access-level on purpose. The vocabulary is pulled into
// the EDGE middleware through canAccess(); this map is labels and prose, needed
// only by the editor and by tests, and there is no reason to ship it on every
// request. Same discipline as the deep import in the admin app's permissions.ts.
import { CAPABILITIES, type Area, type Capability } from './access-level';

export type CapabilityGate = {
  /** Shown to a human — in the editor, and in grant-closure refusals. */
  label: string;
  area: Area;
  /**
   * Tier-2 grouping for the editor. Non-null only where an area is too large to
   * render flat (tournaments at 44, fees at 18), and always the capability's
   * second path segment.
   */
  group: string | null;
  mode: 'page' | 'read' | 'write';
  /**
   * The enforcement point: `<file> <function>`, or `route <path>` where the
   * middleware's section check is the whole gate. `null` means NOT YET WIRED,
   * which is a loud state — see the assertion in the drift test. Nothing is
   * null any more: permissions.write was the last one, and it got its gate when
   * setPlayerPermissions landed.
   */
  gate: string | null;
  /** Further call sites this one capability gates. Requires `merged`. */
  also?: readonly string[];
  /** Why those sites are one capability rather than several. */
  merged?: string;
  /** Why this capability has no gate yet. Required when `gate` is null. */
  unwired?: string;
};

// Merge only where two sites are literally the same act reached twice. Never
// merge create with update; never merge a destructive act with a
// non-destructive one.
const MINT_A_TOKEN = 'Getting the token and rotating it are one act — minting a check-in secret.';
const MARK_OR_CLEAR = 'Marking and clearing an attendance mark are the same act in two directions.';

export const CAPABILITY_GATES: Record<Capability, CapabilityGate> = {
  // ---- players -----------------------------------------------------------
  'players.page': {
    label: 'Open the roster', area: 'players', group: null, mode: 'page',
    gate: 'route /players',
  },
  'players.read': {
    label: 'The roster', area: 'players', group: null, mode: 'read',
    gate: 'app/players/page.tsx roster fetch',
    also: [
      'app/players/[id]/page.tsx member record fetches',
      'app/dashboard/page.tsx active players count',
    ],
    merged: 'The list, one member’s record and the count of them are three renderings of the same rows.',
  },
  'players.approve.write': {
    label: 'Approve a pending member', area: 'players', group: null, mode: 'write',
    gate: 'actions/players.ts approvePlayer',
  },
  'players.create.write': {
    label: 'Add a member', area: 'players', group: null, mode: 'write',
    gate: 'actions/players.ts createPlayer',
  },
  'players.update.write': {
    label: 'Edit a member', area: 'players', group: null, mode: 'write',
    gate: 'actions/players.ts updatePlayer',
  },
  'players.waiver.resign.write': {
    label: 'Require a waiver re-signature', area: 'players', group: null, mode: 'write',
    gate: 'actions/players.ts requireWaiverResignature',
  },
  'players.ban.write': {
    label: 'Ban a member', area: 'players', group: null, mode: 'write',
    gate: 'actions/reinstatement.ts banPlayer',
  },
  'players.reinstate.write': {
    label: 'Reinstate a member', area: 'players', group: null, mode: 'write',
    gate: 'actions/reinstatement.ts reinstatePlayer',
  },
  'players.editor.varsitynotes.write': {
    label: 'Varsity notes', area: 'players', group: null, mode: 'write',
    gate: 'actions/varsity.ts createVarsityNote',
    also: ['actions/varsity.ts deleteVarsityNote'],
    merged: 'Writing and withdrawing a coaching record are one authority over the same log.',
  },
  'players.deletion.cancel.write': {
    label: 'Cancel an account deletion', area: 'players', group: null, mode: 'write',
    gate: 'actions/players.ts cancelAccountDeletion',
  },
  'players.remove.write': {
    label: 'Remove a member', area: 'players', group: null, mode: 'write',
    gate: 'actions/players.ts removePlayer',
  },
  'players.merge.write': {
    label: 'Merge duplicate members', area: 'players', group: null, mode: 'write',
    gate: 'actions/players.ts mergePlayers',
    also: ['actions/players.ts previewPlayerMerge'],
    merged: 'The preview is the dry run of the same act, over the same two rows.',
  },
  'players.reliability.write': {
    label: 'Adjust a reliability score', area: 'players', group: null, mode: 'write',
    gate: 'actions/reliability.ts adjustReliability',
  },
  'players.privilegedfields.write': {
    label: 'Privileged player fields', area: 'players', group: null, mode: 'write',
    gate: 'lib/player-field-access.ts assertPlayerFieldAccess',
  },
  // ONE GATE, AND IT HAS TO STAY ONE. This is the only place in the app that
  // reads this capability, and the reason it is safe to hand out at all is that
  // everything bounding it — closure on the target's set before and after, the
  // admin-only branches, the self-edit refusal — lives inside that one function.
  // A second reader would be a second place all of that has to be remembered.
  //
  // NOT assertPlayerFieldAccess, which is where the neighbouring capability is
  // read. The three level columns stay on PLAYER_FIELD_FLOOR there, refused to
  // everybody below admin and consulted by no capability. The member Edit dialog
  // does not offer console access at all any more, and updatePlayer refuses the
  // three columns from every caller, so this gate stands in front of the only
  // way a level is edited.
  'players.consoleaccess.write': {
    label: 'Give or take console access', area: 'players', group: null, mode: 'write',
    gate: 'actions/permissions.ts setConsoleAccess',
  },

  // ---- seasons -----------------------------------------------------------
  'seasons.page': {
    label: 'Open Seasons', area: 'seasons', group: null, mode: 'page',
    gate: 'app/seasons/page.tsx SeasonsPage',
  },
  'seasons.create.write': {
    label: 'Create a season', area: 'seasons', group: null, mode: 'write',
    gate: 'actions/seasons.ts createSeason',
  },
  'seasons.activate.write': {
    label: 'Make a season active', area: 'seasons', group: null, mode: 'write',
    gate: 'actions/seasons.ts setActiveSeason',
  },
  'seasons.end.write': {
    label: 'End a season', area: 'seasons', group: null, mode: 'write',
    gate: 'actions/seasons.ts endSeason',
  },
  'seasons.fees.write': {
    label: 'Set season fees', area: 'seasons', group: null, mode: 'write',
    gate: 'actions/seasons.ts updateSeasonFees',
  },

  // ---- sessions ----------------------------------------------------------
  'sessions.page': {
    label: 'Open Sessions', area: 'sessions', group: null, mode: 'page',
    gate: 'route /sessions',
  },
  'sessions.reminders.write': {
    label: 'Send session reminders', area: 'sessions', group: null, mode: 'write',
    gate: 'actions/sessions.ts sendSessionReminders',
  },
  'sessions.create.write': {
    label: 'Create a session', area: 'sessions', group: null, mode: 'write',
    gate: 'actions/sessions.ts createSession',
  },
  'sessions.update.write': {
    label: 'Edit a session', area: 'sessions', group: null, mode: 'write',
    gate: 'actions/sessions.ts updateSession',
  },
  'sessions.archive.write': {
    label: 'Archive a session', area: 'sessions', group: null, mode: 'write',
    gate: 'actions/sessions.ts archiveSession',
  },
  'sessions.checkin.token.write': {
    label: 'Session check-in token', area: 'sessions', group: null, mode: 'write',
    gate: 'actions/sessions.ts getOrCreateSessionCheckinToken',
    also: ['actions/sessions.ts rotateSessionCheckinToken'],
    merged: MINT_A_TOKEN,
  },
  'sessions.attendance.write': {
    label: 'Mark session attendance', area: 'sessions', group: null, mode: 'write',
    gate: 'actions/sessions.ts markAttendance',
    also: ['actions/sessions.ts clearAttendanceMark'],
    merged: MARK_OR_CLEAR,
  },
  'sessions.delete.write': {
    label: 'Delete a session', area: 'sessions', group: null, mode: 'write',
    gate: 'actions/sessions.ts deleteSession',
  },

  // ---- matches -----------------------------------------------------------
  'matches.page': {
    label: 'Open Ladder matches', area: 'matches', group: null, mode: 'page',
    gate: 'route /matches',
  },
  'matches.void.write': {
    label: 'Void a match', area: 'matches', group: null, mode: 'write',
    gate: 'actions/matches.ts voidMatch',
  },
  'matches.convert.write': {
    label: 'Convert a match to casual', area: 'matches', group: null, mode: 'write',
    gate: 'actions/matches.ts convertMatchToCasual',
  },
  'matches.create.write': {
    label: 'Record a match', area: 'matches', group: null, mode: 'write',
    gate: 'actions/matches.ts adminCreateMatch',
  },

  // ---- challenges --------------------------------------------------------
  'challenges.page': {
    label: 'Open Challenges', area: 'challenges', group: null, mode: 'page',
    gate: 'route /challenges',
  },
  'challenges.create.write': {
    label: 'Create a challenge', area: 'challenges', group: null, mode: 'write',
    gate: 'actions/matches.ts adminCreateChallenge',
  },
  'challenges.expire.write': {
    label: 'Force-expire a challenge', area: 'challenges', group: null, mode: 'write',
    gate: 'actions/matches.ts forceExpireChallenge',
  },

  // ---- announcements -----------------------------------------------------
  'announcements.page': {
    label: 'Open Announcements', area: 'announcements', group: null, mode: 'page',
    gate: 'route /announcements',
  },
  'announcements.create.write': {
    label: 'Post an announcement', area: 'announcements', group: null, mode: 'write',
    gate: 'actions/announcements.ts createAnnouncement',
  },
  'announcements.update.write': {
    label: 'Edit an announcement', area: 'announcements', group: null, mode: 'write',
    gate: 'actions/announcements.ts updateAnnouncement',
  },
  'announcements.delete.write': {
    label: 'Delete an announcement', area: 'announcements', group: null, mode: 'write',
    gate: 'actions/announcements.ts deleteAnnouncement',
  },

  // ---- tournaments · manage ----------------------------------------------
  // No group: a page belongs to its AREA, not to one of the area's four jobs.
  // It was `tournaments.manage.read` and it never gated the manage DATA — it
  // gated the section, which is what the name now says.
  'tournaments.page': {
    label: 'Open Tournaments', area: 'tournaments', group: null, mode: 'page',
    gate: 'app/tournaments/[id]/page.tsx TournamentDetailPage',
  },
  'tournaments.manage.create.write': {
    label: 'Create a tournament', area: 'tournaments', group: 'manage', mode: 'write',
    gate: 'actions/tournaments.ts createTournament',
  },
  'tournaments.manage.update.write': {
    label: 'Edit a tournament', area: 'tournaments', group: 'manage', mode: 'write',
    gate: 'actions/tournaments.ts updateTournament',
  },
  'tournaments.manage.status.write': {
    label: 'Change tournament status', area: 'tournaments', group: 'manage', mode: 'write',
    gate: 'actions/tournaments.ts updateTournamentStatus',
  },
  'tournaments.manage.suspend.write': {
    label: 'Suspend a tournament', area: 'tournaments', group: 'manage', mode: 'write',
    gate: 'actions/tournaments.ts suspendTournament',
  },
  'tournaments.manage.resume.write': {
    label: 'Resume a tournament', area: 'tournaments', group: 'manage', mode: 'write',
    gate: 'actions/tournaments.ts resumeTournament',
  },
  'tournaments.manage.archive.write': {
    label: 'Archive a tournament', area: 'tournaments', group: 'manage', mode: 'write',
    gate: 'actions/tournaments.ts archiveTournament',
  },
  'tournaments.manage.delete.write': {
    label: 'Delete a tournament', area: 'tournaments', group: 'manage', mode: 'write',
    gate: 'actions/tournaments.ts deleteTournament',
  },
  'tournaments.manage.event.create.write': {
    label: 'Create an event', area: 'tournaments', group: 'manage', mode: 'write',
    gate: 'tournament-actions/events.ts createTournamentEvent',
  },
  'tournaments.manage.event.update.write': {
    label: 'Edit an event', area: 'tournaments', group: 'manage', mode: 'write',
    gate: 'tournament-actions/events.ts updateTournamentEvent',
  },
  'tournaments.manage.event.delete.write': {
    label: 'Delete an event', area: 'tournaments', group: 'manage', mode: 'write',
    gate: 'tournament-actions/events.ts deleteTournamentEvent',
  },
  'tournaments.manage.event.status.write': {
    label: 'Change event status', area: 'tournaments', group: 'manage', mode: 'write',
    gate: 'tournament-actions/events.ts setEventStatus',
  },

  // ---- tournaments · draw ------------------------------------------------
  'tournaments.draw.participants.add.write': {
    label: 'Add a participant', area: 'tournaments', group: 'draw', mode: 'write',
    gate: 'tournament-actions/participants.ts addParticipantToEvent',
    also: ['tournament-actions/participants.ts addParticipantsToEvent'],
    merged: 'One entrant or a whole selection of them, added to an event: one act at two sizes.',
  },
  'tournaments.draw.participants.remove.write': {
    label: 'Remove a participant', area: 'tournaments', group: 'draw', mode: 'write',
    // ONE SITE AGAIN. This used to merge the event-level removal with a
    // tournament-level one in actions/tournaments.ts, which DELETEd from
    // legacy_tournament_participants. That action was deleted along with the
    // dialog that was its only caller, so there is no second scope left to
    // argue about and the `merged` prose went with it.
    gate: 'tournament-actions/participants.ts removeParticipantFromEvent',
  },
  'tournaments.draw.checkin.token.write': {
    label: 'Tournament check-in token', area: 'tournaments', group: 'draw', mode: 'write',
    gate: 'actions/tournament-checkin.ts getOrCreateTournamentCheckinToken',
    also: ['actions/tournament-checkin.ts rotateTournamentCheckinToken'],
    merged: MINT_A_TOKEN,
  },
  'tournaments.draw.checkin.mark.write': {
    label: 'Check a participant in', area: 'tournaments', group: 'draw', mode: 'write',
    gate: 'tournament-actions/participants.ts checkInParticipant',
    also: [
      'tournament-actions/participants.ts checkInPair',
      'tournament-actions/participants.ts bulkCheckIn',
    ],
    merged: 'Singles entrant, pair, or the whole event at once — one act, three shapes.',
  },
  'tournaments.draw.noshow.write': {
    label: 'Mark a no-show', area: 'tournaments', group: 'draw', mode: 'write',
    gate: 'tournament-actions/participants.ts markParticipantNoShow',
    also: ['tournament-actions/participants.ts markPairNoShow'],
    merged: 'The participant and pair variants of one operation.',
  },
  'tournaments.draw.exit.write': {
    label: 'Withdraw or disqualify', area: 'tournaments', group: 'draw', mode: 'write',
    gate: 'tournament-actions/participants.ts exitDrawImpl',
  },
  'tournaments.draw.pairs.add.write': {
    label: 'Add a pair', area: 'tournaments', group: 'draw', mode: 'write',
    gate: 'tournament-actions/participants.ts addPairToEvent',
  },
  'tournaments.draw.pairs.remove.write': {
    label: 'Remove a pair', area: 'tournaments', group: 'draw', mode: 'write',
    gate: 'tournament-actions/participants.ts removePairFromEvent',
  },
  'tournaments.draw.seed.set.write': {
    label: 'Set a seed', area: 'tournaments', group: 'draw', mode: 'write',
    gate: 'tournament-actions/seeding.ts updateParticipantSeed',
    also: ['tournament-actions/seeding.ts updatePairSeed'],
    merged: 'The participant and pair variants of one operation.',
  },
  'tournaments.draw.seed.auto.write': {
    label: 'Auto-seed by rating', area: 'tournaments', group: 'draw', mode: 'write',
    gate: 'tournament-actions/seeding.ts autoSeedEventByElo',
  },
  'tournaments.draw.seed.clear.write': {
    label: 'Clear all seeds', area: 'tournaments', group: 'draw', mode: 'write',
    gate: 'tournament-actions/seeding.ts clearSeeds',
  },
  'tournaments.draw.generate.write': {
    label: 'Generate the draw', area: 'tournaments', group: 'draw', mode: 'write',
    gate: 'tournament-actions/brackets.ts generateSingleEliminationBracket',
    also: ['tournament-actions/brackets.ts generateRoundRobinMatches'],
    merged: 'Knockout or round robin — the same act, chosen by the event format.',
  },
  'tournaments.draw.lock.write': {
    label: 'Lock the draw', area: 'tournaments', group: 'draw', mode: 'write',
    gate: 'tournament-actions/brackets.ts lockDraw',
  },
  'tournaments.draw.unlock.write': {
    label: 'Unlock the draw', area: 'tournaments', group: 'draw', mode: 'write',
    gate: 'tournament-actions/brackets.ts unlockDraw',
  },
  'tournaments.draw.waivers.read': {
    label: 'Who has signed the event waiver', area: 'tournaments', group: 'draw', mode: 'read',
    gate: 'app/tournaments/[id]/events/[eventId]/page.tsx event-waiver fetch',
  },
  'tournaments.draw.entrycounts.read': {
    label: 'How many events each entrant has taken', area: 'tournaments', group: 'draw', mode: 'read',
    gate: 'app/tournaments/[id]/page.tsx entry-count fetch',
  },

  // ---- tournaments · results ---------------------------------------------
  'tournaments.results.enter.write': {
    label: 'Enter a result', area: 'tournaments', group: 'results', mode: 'write',
    gate: 'tournament-actions/results.ts enterMatchResult',
  },
  'tournaments.results.walkover.write': {
    label: 'Enter a walkover', area: 'tournaments', group: 'results', mode: 'write',
    gate: 'tournament-actions/results.ts enterWalkover',
  },
  'tournaments.results.void.write': {
    label: 'Void a tournament match', area: 'tournaments', group: 'results', mode: 'write',
    gate: 'tournament-actions/results.ts voidMatch',
  },
  'tournaments.results.unvoid.write': {
    label: 'Un-void a tournament match', area: 'tournaments', group: 'results', mode: 'write',
    gate: 'tournament-actions/results.ts unvoidMatch',
  },
  'tournaments.results.undo.write': {
    label: 'Undo a result', area: 'tournaments', group: 'results', mode: 'write',
    gate: 'tournament-actions/results.ts undoMatchResult',
  },
  'tournaments.results.edit.write': {
    label: 'Edit a recorded result', area: 'tournaments', group: 'results', mode: 'write',
    gate: 'tournament-actions/results.ts editMatchResult',
  },
  'tournaments.results.entry.write': {
    label: 'Edit a match slot', area: 'tournaments', group: 'results', mode: 'write',
    gate: 'tournament-actions/results.ts setMatchEntry',
  },
  'tournaments.results.doublenoshow.write': {
    label: 'Record a double no-show', area: 'tournaments', group: 'results', mode: 'write',
    gate: 'tournament-actions/results.ts recordDoubleNoShow',
  },
  'tournaments.results.bonuses.write': {
    label: 'Apply placement bonuses', area: 'tournaments', group: 'results', mode: 'write',
    gate: 'tournament-actions/finalize.ts applyPlacementBonuses',
  },
  'tournaments.results.standings.write': {
    label: 'Recompute standings', area: 'tournaments', group: 'results', mode: 'write',
    gate: 'tournament-actions/finalize.ts recomputeEventStandings',
  },
  'tournaments.results.finalize.write': {
    label: 'Finalise an event', area: 'tournaments', group: 'results', mode: 'write',
    gate: 'tournament-actions/finalize.ts finalizeEvent',
  },

  // ---- tournaments · fees ------------------------------------------------
  'tournaments.fees.read': {
    label: 'Tournament entry fees', area: 'tournaments', group: 'fees', mode: 'read',
    gate: 'app/tournaments/[id]/fees/page.tsx TournamentFeesPage',
  },
  'tournaments.fees.tier.create.write': {
    label: 'Create a fee tier', area: 'tournaments', group: 'fees', mode: 'write',
    gate: 'actions/tournament-fees.ts createFeeTier',
  },
  'tournaments.fees.tier.update.write': {
    label: 'Edit a fee tier', area: 'tournaments', group: 'fees', mode: 'write',
    gate: 'actions/tournament-fees.ts updateFeeTier',
  },
  'tournaments.fees.tier.delete.write': {
    label: 'Delete a fee tier', area: 'tournaments', group: 'fees', mode: 'write',
    gate: 'actions/tournament-fees.ts deleteFeeTier',
  },
  'tournaments.fees.markpaid.write': {
    label: 'Mark an entry fee paid', area: 'tournaments', group: 'fees', mode: 'write',
    gate: 'actions/tournament-fees.ts markTournamentFeePaid',
  },
  'tournaments.fees.markunpaid.write': {
    label: 'Mark an entry fee unpaid', area: 'tournaments', group: 'fees', mode: 'write',
    gate: 'actions/tournament-fees.ts markTournamentFeeUnpaid',
  },

  // ---- fees --------------------------------------------------------------
  // The page and the Expenses ledger are two gates now, where they used to be
  // one. FeesPage admits anyone with the page; the ledger's own fetch is what
  // fees.expenses.read buys, and without it the tab renders the Add expense
  // control over no rows.
  'fees.page': {
    label: 'Open Finances', area: 'fees', group: null, mode: 'page',
    gate: 'app/fees/page.tsx FeesPage',
  },
  'fees.expenses.read': {
    label: 'Expenses', area: 'fees', group: 'expenses', mode: 'read',
    gate: 'app/fees/page.tsx expenses ledger fetch',
  },
  'fees.expenses.add.write': {
    label: 'File an expense', area: 'fees', group: 'expenses', mode: 'write',
    gate: 'actions/finance.ts addExpense',
  },
  'fees.expenses.update.write': {
    label: 'Edit an expense', area: 'fees', group: 'expenses', mode: 'write',
    gate: 'actions/finance.ts updateExpense',
  },
  'fees.expenses.reimburse.write': {
    label: 'Mark an expense reimbursed', area: 'fees', group: 'expenses', mode: 'write',
    gate: 'actions/finance.ts markExpenseReimbursed',
  },
  'fees.expenses.remove.write': {
    label: 'Delete an expense', area: 'fees', group: 'expenses', mode: 'write',
    gate: 'actions/finance.ts removeExpense',
  },
  'fees.otherincome.read': {
    label: 'Other income', area: 'fees', group: 'otherincome', mode: 'read',
    gate: 'app/fees/page.tsx other-income ledger fetch',
  },
  'fees.otherincome.add.write': {
    label: 'Record other income', area: 'fees', group: 'otherincome', mode: 'write',
    gate: 'actions/finance.ts addOtherIncome',
  },
  'fees.otherincome.remove.write': {
    label: 'Delete an other-income entry', area: 'fees', group: 'otherincome', mode: 'write',
    gate: 'actions/finance.ts removeOtherIncome',
  },
  'fees.clubfees.read': {
    label: 'Club fees', area: 'fees', group: 'clubfees', mode: 'read',
    gate: 'app/fees/page.tsx club-fee roster fetches',
  },
  'fees.clubfees.markpaid.write': {
    label: 'Mark a club fee paid', area: 'fees', group: 'clubfees', mode: 'write',
    gate: 'actions/fees.ts markFeePaid',
  },
  'fees.clubfees.markunpaid.write': {
    label: 'Mark a club fee unpaid', area: 'fees', group: 'clubfees', mode: 'write',
    gate: 'actions/fees.ts markFeeUnpaid',
  },
  'fees.clubfees.waive.write': {
    label: 'Waive a club fee', area: 'fees', group: 'clubfees', mode: 'write',
    gate: 'actions/fees.ts waiveFee',
  },
  'fees.clubfees.addmanual.write': {
    label: 'Add a manual fee', area: 'fees', group: 'clubfees', mode: 'write',
    gate: 'actions/fees.ts addManualFee',
  },
  'fees.clubfees.removemanual.write': {
    label: 'Delete a manual fee', area: 'fees', group: 'clubfees', mode: 'write',
    gate: 'actions/fees.ts removeManualFee',
  },
  'fees.reinstatements.read': {
    label: 'Reinstatement fees', area: 'fees', group: 'reinstatements', mode: 'read',
    gate: 'app/fees/page.tsx reinstatements fetch',
  },
  'fees.reinstatements.write': {
    label: 'Record a reinstatement payment', area: 'fees', group: 'reinstatements', mode: 'write',
    gate: 'actions/reinstatement.ts recordReinstatementPayment',
  },
  'fees.netposition.read': {
    label: 'Net position', area: 'fees', group: 'netposition', mode: 'read',
    gate: 'app/fees/page.tsx net-position strip',
    also: ['app/dashboard/page.tsx finance snapshot'],
    merged: 'Two renderings of one figure — income, expenses and the difference.',
  },
  'fees.playerflags.write': {
    label: 'Fee exemption flags', area: 'fees', group: 'playerflags', mode: 'write',
    gate: 'actions/fees.ts updatePlayerFlags',
  },

  // ---- legal -------------------------------------------------------------
  'legal.page': {
    label: 'Open Legal', area: 'legal', group: null, mode: 'page',
    gate: 'app/legal/page.tsx LegalPage',
  },
  'legal.reacceptance.write': {
    label: 'Require a re-signature', area: 'legal', group: null, mode: 'write',
    gate: 'actions/settings.ts requireReacceptance',
  },
  'legal.documents.write': {
    label: 'Edit a legal document', area: 'legal', group: null, mode: 'write',
    gate: 'actions/settings.ts updateLegalDocument',
  },
  'legal.waivertemplate.write': {
    label: 'Edit the event waiver template', area: 'legal', group: null, mode: 'write',
    gate: 'actions/settings.ts updateEventWaiverTemplate',
  },

  // ---- walkovers ---------------------------------------------------------
  'walkovers.page': {
    label: 'Open Walkovers', area: 'walkovers', group: null, mode: 'page',
    gate: 'route /walkovers',
  },
  'walkovers.confirm.write': {
    label: 'Confirm a walkover', area: 'walkovers', group: null, mode: 'write',
    gate: 'actions/walkovers.ts confirmWalkover',
  },
  'walkovers.reject.write': {
    label: 'Reject a walkover', area: 'walkovers', group: null, mode: 'write',
    gate: 'actions/walkovers.ts rejectWalkover',
  },

  // ---- disputes ----------------------------------------------------------
  'disputes.page': {
    label: 'Open Disputes', area: 'disputes', group: null, mode: 'page',
    gate: 'route /disputes',
  },
  'disputes.resolve.write': {
    label: 'Resolve a dispute', area: 'disputes', group: null, mode: 'write',
    gate: 'actions/disputes.ts resolveDispute',
  },

  // ---- permissions -------------------------------------------------------
  'permissions.page': {
    label: 'Open Permissions', area: 'permissions', group: null, mode: 'page',
    gate: 'app/permissions/page.tsx PermissionsPage',
  },
  'permissions.write': {
    label: 'Hand out permissions', area: 'permissions', group: null, mode: 'write',
    gate: 'actions/permissions.ts setPlayerPermissions',
  },

  // ---- audit / ratings / accounts ----------------------------------------
  'audit.page': {
    label: 'Open the Audit log', area: 'audit', group: null, mode: 'page',
    gate: 'route /audit',
  },
  'ratings.page': {
    label: 'Open Ratings', area: 'ratings', group: null, mode: 'page',
    gate: 'app/ratings/page.tsx RatingsPage',
  },
  'accounts.page': {
    label: 'Open Accounts', area: 'accounts', group: null, mode: 'page',
    gate: 'app/accounts/page.tsx AccountsPage',
  },

  // ---- platform ----------------------------------------------------------
  // THE ONE PAGE CAPABILITY WITH NO ROUTE. Platform settings have no section of
  // their own — the form is drawn inside /ratings and /accounts, each of which
  // is its own area — so this gates the FORM rather than a path, and both pages
  // render it only for a holder. Every area needs a page for the resolver's
  // invariant to be uniform, and an honest gate is the price of that.
  'platform.page': {
    label: 'Open Platform settings', area: 'platform', group: null, mode: 'page',
    gate: 'app/ratings/page.tsx platform settings form',
    also: ['app/accounts/page.tsx platform settings form'],
    merged: 'One form, rendered on the two pages that carry the settings it holds.',
  },
  'platform.settings.write': {
    label: 'Platform settings', area: 'platform', group: null, mode: 'write',
    gate: 'actions/settings.ts updatePlatformSettings',
  },
};

/**
 * Every distinct place in the app that asks a capability question. Pinned so
 * that deleting a gate without deleting its capability — which would leave the
 * editor offering a tick box nothing reads — fails the suite.
 */
export const ENFORCEMENT_POINTS: number = CAPABILITIES.reduce(
  (total, capability) => {
    const entry = CAPABILITY_GATES[capability];
    return total + (entry.gate === null ? 0 : 1) + (entry.also?.length ?? 0);
  },
  0,
);
