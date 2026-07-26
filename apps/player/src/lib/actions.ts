// Barrel re-export so existing call sites (`import { foo } from '@/lib/actions'`)
// keep working without churn. Real implementations live in ./actions/*.
//
// Each subfile is a 'use server' module owning one domain:
//   - challenges.ts  — create/accept/reject/cancel
//   - matches.ts     — submit/confirm/dispute, walkover
//   - profile.ts     — updateProfile, completeOnboarding,
//                      getLegalDocuments, acceptLegalDocuments,
//                      deleteMyAccount, restoreMyAccount
//   - notifications.ts — markNotificationRead / All / markAnnouncementRead
//   - sessions.ts    — checkInToSession / checkInWithToken (QR)
//   - calendar.ts    — getCalendarFeedToken / regenerateCalendarFeedToken
//   - _shared.ts     — requirePlayer / getPlayerProps / trackServerEvent
//                      (NOT 'use server' — internal helpers)
export {
  createChallenge,
  acceptChallenge,
  rejectChallenge,
  cancelChallenge,
} from './actions/challenges';

export {
  submitMatchResult,
  confirmMatchResult,
  disputeMatchResult,
  reportWalkover,
} from './actions/matches';

export {
  updateProfile,
  updateNotificationPreferences,
  completeOnboarding,
  getLegalDocuments,
  acceptLegalDocuments,
  deleteMyAccount,
  restoreMyAccount,
} from './actions/profile';

export {
  markNotificationRead,
  markAllNotificationsRead,
  markAnnouncementRead,
} from './actions/notifications';

export {
  checkInToSession,
  checkInWithToken,
  setSessionIntent,
} from './actions/sessions';

export {
  getCalendarFeedToken,
  regenerateCalendarFeedToken,
} from './actions/calendar';
