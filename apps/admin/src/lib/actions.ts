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
//   - sessions.ts      — session CRUD
//   - announcements.ts — announcement CRUD
//   - fees.ts          — exec/exempt player flags + club-fee tracking
//   - tournament-fees.ts — tournament fee tiers + per-player entry-fee tracking
//   - reinstatement.ts — player ban / reinstatement (with reinstatement fee)
//   - varsity.ts       — varsity notes
//   - settings.ts      — updateLegalDocument (waiver / code of conduct)
//   - _shared.ts       — getAdminPlayer (NOT 'use server' — internal helper)
export {
  approvePlayer,
  createPlayer,
  updatePlayer,
  removePlayer,
  cancelAccountDeletion,
} from './actions/players';

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
  markAttendance,
  clearAttendanceMark,
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
} from './actions/reinstatement';

export {
  createVarsityNote,
  deleteVarsityNote,
} from './actions/varsity';

export {
  updateLegalDocument,
} from './actions/settings';
