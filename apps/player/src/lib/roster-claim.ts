// Onboarding can attach a signing-in member to a roster row an admin created
// for them ahead of time (players.user_id IS NULL, matching email). That is a
// convenience worth keeping — without it every pre-added member gets a second
// row someone has to merge by hand — but it is also an authorization boundary,
// because whatever is already on the row comes with it.
//
// It was not treated as one. The claim copied user_id and onboarding_completed
// onto the row and left everything else alone, so a row carrying role='admin'
// (there is one on production: lsa139@sfu.ca) made whoever could receive mail
// at that address an admin the moment they finished onboarding — no approval,
// no audit entry, nothing to notice afterwards. The ordinary signup path goes
// through create_player_with_rating, which forces role='player' and
// status='pending_approval' precisely so this cannot happen; the claim path
// walked around that guard.
//
// The rule here: a claim links an identity, it never confers privilege.
//
// Why strip rather than refuse the claim outright. Once players.email is unique
// (00066), create_player_with_rating can no longer insert a second row for an
// address a roster row already holds. A claim path that refuses privileged rows
// would therefore leave that person with no way to onboard at all and no
// self-service escape — the failure mode would be a permanently locked-out
// member, which is worse than the one deliberate click it costs an admin to
// re-grant. Stripping fails closed and stays unblocked.
//
// Not stripped: status, membership_type and fee_exempt. Those describe who the
// admin decided this person is — which division they play in, what they owe —
// and re-deriving them would just make the admin retype what they already
// entered. They grant no console access. role, is_exec and is_trainer do
// (admin_access_level tests role and is_exec; is_trainer opens the varsity
// notes), and those are the three that come off.
export const CLAIM_PRIVILEGE_COLUMNS = ['role', 'is_exec', 'is_trainer'] as const;

export type ClaimableRosterRow = {
  id: string;
  role?: string | null;
  is_exec?: boolean | null;
  is_trainer?: boolean | null;
};

export type RosterClaim = {
  /** The update to apply to the claimed players row. */
  update: Record<string, unknown>;
  /**
   * The privileges the row was carrying, or null when it carried none. Non-null
   * means an audit entry is owed: an admin has to know their pre-added admin
   * landed as an ordinary member so they can deliberately re-grant it.
   */
  stripped: { role?: string; is_exec?: boolean; is_trainer?: boolean } | null;
};

// Addresses are stored folded by normalize_player_email_trg (00066), and GoTrue
// hands back a lowercased address, so an exact match is enough. This exists to
// make that explicit at the call site: the lookup used to be
// .ilike('email', user.email) with the address dropped in raw, and `_` and `%`
// are both legal in a local part and wildcards to ilike — the owner of
// 'a_c@sfu.ca' matched the unclaimed row for 'abc@sfu.ca'. Escaping the pattern
// is not enough either, because PostgREST rewrites `*` to `%` after any
// escaping we could do. An equality filter has no pattern language at all.
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

export function buildRosterClaim(
  row: ClaimableRosterRow,
  userId: string,
  profile: { display_name?: string; phone?: string } = {},
): RosterClaim {
  // Written unconditionally, not "only when the row looks privileged". The bug
  // being fixed is inheritance by omission, and a claim that merely leaves role
  // alone is the buggy version — every claim must state the value it lands on.
  const update: Record<string, unknown> = {
    user_id: userId,
    onboarding_completed: true,
    role: 'player',
    is_exec: false,
    is_trainer: false,
  };

  // The admin-entered name/email/status stay authoritative (same rule the merge
  // tool follows); onboarding only supplies what the admin could not know.
  if (profile.display_name) update.display_name = profile.display_name;
  if (profile.phone) update.phone = profile.phone;

  const stripped: NonNullable<RosterClaim['stripped']> = {};
  if (row.role && row.role !== 'player') stripped.role = row.role;
  if (row.is_exec) stripped.is_exec = true;
  if (row.is_trainer) stripped.is_trainer = true;

  return { update, stripped: Object.keys(stripped).length > 0 ? stripped : null };
}
