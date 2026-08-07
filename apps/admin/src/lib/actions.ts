// Barrel re-export so existing call sites (`import { foo } from '@/lib/actions'`)
// keep working without churn. Real implementations live in ./actions/*.
//
// Each subfile is a 'use server' module owning one domain:
//   - players.ts       — approve/create/update/remove player,
//                        cancelAccountDeletion
//   - matches.ts       — voidMatch, convertMatchToCasual, adminCreateMatch,
//                        adminCreateChallenge, forceExpireChallenge
//   - disputes.ts      — resolveDispute
//   - walkovers.ts     — confirmWalkover / rejectWalkover
//   - tournaments.ts   — tournament CRUD + legacy participant management
//   - seasons.ts       — createSeason / setActiveSeason / endSeason
//   - sessions.ts      — session CRUD + QR check-in tokens
//   - announcements.ts — announcement CRUD
//   - fees.ts          — exec/exempt player flags + club-fee tracking
//   - finance.ts       — other income (donations/grants) + club expenses
//   - tournament-fees.ts — tournament fee tiers + per-player entry-fee tracking
//   - reinstatement.ts — player ban / reinstatement (with reinstatement fee)
//   - varsity.ts       — varsity notes
//   - reliability.ts   — adjustReliability (manual reliability-counter edits)
//   - settings.ts      — updateLegalDocument (waiver / code of conduct),
//                        updatePlatformSettings (/ratings + /accounts)
//   - _shared.ts       — getAdminPlayer (NOT 'use server' — internal helper)
export {
  approvePlayer,
  createPlayer,
  updatePlayer,
  removePlayer,
  cancelAccountDeletion,
  requireWaiverResignature,
  previewPlayerMerge,
  mergePlayers,
} from './actions/players';
export type { MergePreviewRow } from './actions/players';

export {
  voidMatch,
  convertMatchToCasual,
  adminCreateMatch,
  adminCreateChallenge,
  forceExpireChallenge,
} from './actions/matches';

export {
  resolveDispute,
} from './actions/disputes';

export {
  confirmWalkover,
  rejectWalkover,
} from './actions/walkovers';

export {
  createTournament,
  updateTournamentStatus,
  updateTournament,
  suspendTournament,
  resumeTournament,
  archiveTournament,
  deleteTournament,
  addTournamentParticipant,
  removeTournamentParticipant,
} from './actions/tournaments';

export {
  createSeason,
  updateSeasonFees,
  setActiveSeason,
  endSeason,
} from './actions/seasons';
export type { SeasonEloPolicy } from './actions/seasons';

export {
  createSession,
  updateSession,
  archiveSession,
  deleteSession,
  sendSessionReminders,
  markAttendance,
  clearAttendanceMark,
  getOrCreateSessionCheckinToken,
  rotateSessionCheckinToken,
} from './actions/sessions';

export {
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
} from './actions/announcements';

export {
  updatePlayerFlags,
  markFeePaid,
  waiveFee,
  markFeeUnpaid,
  addManualFee,
  removeManualFee,
} from './actions/fees';

// Non-fee money ledgers (00073): donations/grants in, shuttles/courts out.
export {
  addOtherIncome,
  removeOtherIncome,
  addExpense,
  removeExpense,
} from './actions/finance';

export {
  createFeeTier,
  updateFeeTier,
  deleteFeeTier,
  markTournamentFeePaid,
  markTournamentFeeUnpaid,
} from './actions/tournament-fees';

export {
  banPlayer,
  reinstatePlayer,
  recordReinstatementPayment,
} from './actions/reinstatement';

export {
  createVarsityNote,
  deleteVarsityNote,
} from './actions/varsity';

export {
  adjustReliability,
} from './actions/reliability';

export {
  updateLegalDocument,
  requireReacceptance,
  updatePlatformSettings,
} from './actions/settings';
