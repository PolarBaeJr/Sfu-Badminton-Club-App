import type { ClubEventSignupState } from '@badminton/shared';

// What the members' club event pages read and say, shared by the list and the
// detail page. Explicit columns, never `*`: created_by is not a member's
// business, and the player app never selects it.
export const CLUB_EVENT_COLUMNS =
  'id, title, kind, description, location, starts_at, ends_at, capacity, cost_cents, signup_opens_at, signup_closes_at, status, cancelled_reason';

export type ClubEventRow = {
  id: string;
  title: string;
  kind: string;
  description: string | null;
  location: string | null;
  starts_at: string;
  ends_at: string | null;
  capacity: number | null;
  cost_cents: number | null;
  signup_opens_at: string | null;
  signup_closes_at: string | null;
  status: string;
  cancelled_reason: string | null;
};

export const SIGNUP_STATE_LABEL: Record<ClubEventSignupState, string> = {
  going: 'You are going',
  open: 'Sign-ups open',
  full: 'Full',
  not_open_yet: 'Sign-ups not open yet',
  closed: 'Sign-ups closed',
  started: 'Started',
  cancelled: 'Cancelled',
};
