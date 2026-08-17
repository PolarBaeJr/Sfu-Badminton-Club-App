// Bringing a lapsed member back onto the active roster when they sign in.
//
// The club owner's rule: "gate it but let returning members reactivate
// themselves on login". isSelfReactivatable() (@badminton/shared) decides WHO
// qualifies — a member the nightly mark-inactive-players job deactivated for
// not showing up, and nobody else. A removal (status='suspended') and a
// deletion request (deletion_requested_at) both clear the same column and
// neither may be undone by logging in; see the comment on that predicate.
//
// This is the only writer of the "welcome back" transition, and it is called
// from three places: /auth/callback (OAuth + magic link), /auth/post-login
// (OTP code + passkey), and requirePlayer() as a safety net. All three funnel
// here so the audit row, the last_active_at bump and the notice reset can only
// ever be got right or wrong once.

import * as Sentry from '@sentry/nextjs';
import { isSelfReactivatable } from '@badminton/shared';
import { createServiceRoleClient } from './supabase-server';
import { logMemberAudit } from './member-audit';

export interface ReactivatablePlayer {
  id: string;
  active_flag?: boolean | null;
  status?: string | null;
  is_banned?: boolean | null;
  deletion_requested_at?: string | null;
}

/**
 * Put a lapsed member back on the active roster. A no-op — no query at all —
 * for anyone who does not qualify, which is everybody on almost every call.
 *
 * @returns true when this call performed the reactivation. false when the
 *   member did not qualify, when another concurrent request won the race, or
 *   when the write failed (reported to Sentry, never thrown: a returning
 *   member must not be shown an error page because an audit row would not go
 *   in).
 */
export async function reactivateLapsedMember(
  player: ReactivatablePlayer | null | undefined,
): Promise<boolean> {
  if (!isSelfReactivatable(player) || !player) return false;

  const service = createServiceRoleClient();
  const now = new Date().toISOString();

  // last_active_at is bumped deliberately, and it is load-bearing.
  //
  // Only session check-in writes that column (apps/player/.../sessions.ts) and
  // only mark-inactive-players reads it. Without the bump, reactivating leaves
  // last_active_at 120+ days stale, so the very next nightly run deactivates
  // the member again — and clearing the notice stamp below would mail them the
  // retention notice a second time. Every night. Signing in has to count as
  // activity for the inactivity clock, or "reactivate on sign-in" is a loop
  // rather than a feature.
  //
  // The .eq('active_flag', false) is what makes this idempotent under
  // concurrency: two requests arriving together both see the stale row, but
  // only one UPDATE matches, so only one audit row is written.
  const { data, error } = await service
    .from('players')
    .update({
      active_flag: true,
      last_active_at: now,
      // They are back on the roster, so the "you have been marked inactive"
      // notice is spent. Clearing it re-arms the notice for a future lapse
      // (00059) — a member who lapses twice should be told twice.
      inactivity_notice_sent_at: null,
      // Stops the retention clock dead (00062). Signing in is the documented
      // way to keep an account, and the email now promises exactly that, so
      // this line is what makes the promise true — a returning member left
      // with a stale inactive_since would still be anonymised on schedule
      // despite being back on the roster.
      inactive_since: null,
      updated_at: now,
    })
    .eq('id', player.id)
    .eq('active_flag', false)
    .select('id');

  if (error) {
    Sentry.captureException(error, {
      extra: { action: 'reactivateLapsedMember', playerId: player.id },
    });
    return false;
  }
  if (!data || data.length === 0) return false;

  // An account coming back leaves a trail, in the same shape
  // mark-inactive-players uses for 'auto_marked_inactive'.
  //
  // THIS USED TO BE AN INLINE INSERT, with a comment saying there was no
  // player-side audit helper to use. There is now — member-audit.ts, extracted
  // when deleteMyAccount, restoreMyAccount and the onboarding rating seed needed
  // the identical row and this was the only worked example of it. The shape is
  // unchanged: actor_id is the member themselves, the reason is a fixed sentence,
  // and a failed insert is reported rather than thrown, because the member is
  // already back and losing the row is not worth failing their sign-in over.
  await logMemberAudit({
    playerId: player.id,
    actionType: 'self_reactivated',
    oldValue: { active_flag: false },
    newValue: { active_flag: true },
    reason: 'Signed in after being marked inactive',
  });

  return true;
}

/**
 * Sign-in variant: looks the row up from the auth user id first. Used by
 * /auth/callback, which runs before next/headers carries the new session
 * cookie, so getCurrentPlayer() cannot see the member yet.
 */
export async function reactivateLapsedMemberByUserId(userId: string): Promise<boolean> {
  const service = createServiceRoleClient();
  const { data: player, error } = await service
    .from('players')
    .select('id, active_flag, status, is_banned, deletion_requested_at')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    Sentry.captureException(error, {
      extra: { action: 'reactivateLapsedMemberByUserId', userId },
    });
    return false;
  }
  return reactivateLapsedMember(player);
}
