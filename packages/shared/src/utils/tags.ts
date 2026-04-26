// Class-name maps for the design's .tag primitive.
// These were copy-pasted across challenges/page.tsx,
// challenges/[id]/page.tsx, notifications/page.tsx, and the tournaments
// pages. Single source so adding a new status updates everywhere.

export const CHALLENGE_STATUS_TAG: Record<string, string> = {
  proposed: 'tag tag-gold',
  partially_confirmed: 'tag tag-gold',
  accepted: 'tag tag-win',
  completed: 'tag',
  walkover_confirmed: 'tag',
  walkover_pending: 'tag tag-red',
  disputed: 'tag tag-red',
  rejected: 'tag',
  cancelled: 'tag',
  expired: 'tag',
};

export const CHALLENGE_STATUS_LABEL: Record<string, string> = {
  proposed: 'Proposed',
  partially_confirmed: 'Partial',
  accepted: 'Accepted',
  completed: 'Completed',
  walkover_confirmed: 'Walkover',
  walkover_pending: 'Walkover review',
  disputed: 'Disputed',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  expired: 'Expired',
};

export const PARTICIPANT_CONFIRM_TAG: Record<string, string> = {
  accepted: 'tag tag-win',
  rejected: 'tag tag-red',
  pending: 'tag tag-gold',
};

export const TOURNAMENT_STATUS_TAG: Record<string, string> = {
  active: 'tag tag-win',
  registration: 'tag tag-gold',
  live: 'tag tag-win',
  bracket_generated: 'tag tag-gold',
  upcoming: 'tag tag-gold',
  checkin: 'tag tag-gold',
  completed: 'tag',
  cancelled: 'tag',
};

export const NOTIFICATION_TAG: Record<string, string> = {
  challenge_received: 'tag tag-red',
  challenge_accepted: 'tag tag-win',
  challenge_rejected: 'tag',
  challenge_cancelled: 'tag',
  result_pending: 'tag tag-gold',
  result_confirmed: 'tag tag-win',
  dispute_opened: 'tag tag-red',
  dispute_resolved: 'tag tag-win',
  rank_changed: 'tag tag-gold',
  session_reminder: 'tag',
  announcement: 'tag tag-gold',
  tournament_update: 'tag tag-gold',
  team_invite: 'tag tag-win',
  system: 'tag',
};
