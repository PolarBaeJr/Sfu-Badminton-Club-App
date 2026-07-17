// Barrel re-export so existing call sites (`import { foo } from '@/lib/actions'`)
// keep working without churn. Real implementations live in ./actions/*.
//
// Each subfile is a 'use server' module owning one domain:
//   - players.ts       — approve/create/update/remove player
//   - matches.ts       — voidMatch, convertMatchToCasual, adminCreateMatch,
//                        adminCreateChallenge, forceExpireChallenge
//   - disputes.ts      — resolveDispute
//   - walkovers.ts     — confirmWalkover / rejectWalkover
//   - tournaments.ts   — tournament CRUD + legacy participant management
//   - seasons.ts       — createSeason / setActiveSeason / endSeason
//   - sessions.ts      — session CRUD
//   - announcements.ts — announcement CRUD
//   - fees.ts          — exec/exempt player flags + club-fee tracking
//   - varsity.ts       — varsity notes
//   - _shared.ts       — getAdminPlayer (NOT 'use server' — internal helper)
export {
  approvePlayer,
  createPlayer,
  updatePlayer,
  removePlayer,
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
  archiveTournament,
  deleteTournament,
  addTournamentParticipant,
  removeTournamentParticipant,
} from './actions/tournaments';

export {
  createSeason,
  setActiveSeason,
  endSeason,
} from './actions/seasons';

export {
  createSession,
  updateSession,
  archiveSession,
  deleteSession,
} from './actions/sessions';

export {
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
} from './actions/announcements';

export {
  updatePlayerFlags,
  markFeePaid,
  markFeeUnpaid,
} from './actions/fees';

export {
  createVarsityNote,
  deleteVarsityNote,
} from './actions/varsity';
