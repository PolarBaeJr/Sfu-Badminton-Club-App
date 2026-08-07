// Barrel re-export so existing call sites (`import { foo } from '@/lib/tournament-actions'`)
// keep working without churn. Real implementations live in ./tournament-actions/*.
//
// Each subfile is a 'use server' module owning one domain:
//   - events.ts       — event CRUD + status transitions
//   - participants.ts — singles participants, doubles pairs, check-in / no-show
//   - seeding.ts      — manual seeds, auto-seed by Elo, clear seeds
//   - brackets.ts     — bracket / round robin generation, draw lock
//   - results.ts      — score entry, walkovers, void / restore / edit / undo
//                       results, manual draw-slot repair
//   - finalize.ts     — placement bonuses + event finalization
//   - _internal.ts    — private helpers (NOT 'use server' — revalidation,
//                       notifications, Elo apply/reverse, standings)
export {
  createTournamentEvent,
  updateTournamentEvent,
  deleteTournamentEvent,
  setEventStatus,
} from './tournament-actions/events';

export {
  addParticipantToEvent,
  addParticipantsToEvent,
  removeParticipantFromEvent,
  checkInParticipant,
  markParticipantNoShow,
  withdrawParticipant,
  disqualifyParticipant,
  withdrawPair,
  disqualifyPair,
  addPairToEvent,
  removePairFromEvent,
  checkInPair,
  markPairNoShow,
  bulkCheckIn,
} from './tournament-actions/participants';

export {
  updateParticipantSeed,
  updatePairSeed,
  autoSeedEventByElo,
  clearSeeds,
} from './tournament-actions/seeding';

export {
  generateSingleEliminationBracket,
  generateRoundRobinMatches,
  lockDraw,
  unlockDraw,
} from './tournament-actions/brackets';

export {
  enterMatchResult,
  enterWalkover,
  voidMatch,
  unvoidMatch,
  recordDoubleNoShow,
  setMatchEntry,
  editMatchResult,
  undoMatchResult,
} from './tournament-actions/results';

export {
  applyPlacementBonuses,
  finalizeEvent,
} from './tournament-actions/finalize';
