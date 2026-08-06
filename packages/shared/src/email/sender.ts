import { Resend } from 'resend';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import {
  challengeReceivedEmail,
  challengeAcceptedEmail,
  challengeRejectedEmail,
  resultPendingEmail,
  matchConfirmedEmail,
  disputeOpenedEmail,
  walkoverReportedEmail,
  playerApprovedEmail,
  weeklyDigestEmail,
} from './templates';
import { buildUnsubscribeUrl } from './unsubscribe';
import { isEmailCategoryEnabled, type NotificationCategory } from '../utils/notifications';

let resend: Resend | null = null;

function getResend(): Resend {
  if (!resend) {
    resend = new Resend(process.env.RESEND_API_KEY);
  }
  return resend;
}

// Must be a domain verified in Resend, or every send fails. This previously
// pointed at badminton.club — never owned or verified — so all app notification
// mail (challenge received, result pending, disputes, walkovers) failed
// silently while auth codes kept working, because those go through GoTrue from
// login@mail.sfubadminton.com instead. Overridable so a staging clone can point
// somewhere harmless without a code change.
const FROM = process.env.EMAIL_FROM || 'SFU Badminton <noreply@mail.sfubadminton.com>';

// Its own service-role client rather than one passed in by the caller. The
// sibling push module takes an adminClient as a parameter, but that only works
// because its single caller already holds one; the mail senders are invoked
// from six different server actions that have nothing but a bare address in
// hand. Threading a client through all of them would make the suppression check
// something a future call site can forget to do — and a check that can be
// forgotten is the one failure mode this must not have.
let admin: SupabaseClient | null = null;

function getAdmin(): SupabaseClient | null {
  if (admin) return admin;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  admin = createClient(url, key);
  return admin;
}

export async function sendEmail(
  to: string,
  subject: string,
  html: string,
  headers?: Record<string, string>,
): Promise<void> {
  // Throws on failure so callers can decide whether to swallow + log.
  // We deliberately don't catch internally — earlier behaviour double-swallowed
  // errors (here and at every call site), making delivery failures invisible.
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY not set');
  }
  const r = getResend();
  const { error } = await r.emails.send({ from: FROM, to, subject, html, headers });
  if (error) {
    throw new Error(`Resend send failed: ${error.message}`);
  }
}

export type SendOutcome =
  | { sent: true }
  | { sent: false; reason: 'suppressed' | 'opted_out' };

/**
 * Every notification email goes through here.
 *
 * Two gates before anything is handed to the provider:
 *   1. the address is on email_suppressions (hard bounce, complaint, or a
 *      one-click unsubscribe-from-all);
 *   2. the member turned this category's email off.
 *
 * A blocked send is NOT an error. `sendEmail` throws by design so that genuine
 * delivery failures stay visible, and every call site logs what it catches — so
 * throwing here would file "this person unsubscribed" as a delivery incident in
 * Sentry. It returns an outcome instead.
 *
 * Sign-in codes do NOT come through here: those are issued by GoTrue, and a
 * member must always be able to get into their account.
 *
 * `transactional` skips gate 2 only. It is for the one-off mail that IS the
 * event rather than a subscription to it — currently just "your account has
 * been approved", which a brand-new member has to receive to know the app is
 * open to them. Since 00058 made preferences opt-in, a new member's blob is
 * empty, so without this that email would never arrive and the account would
 * look stuck at "pending" forever. Gate 1 (suppressions, bounces, complaints,
 * unsubscribe-from-all) still applies — nothing bypasses that.
 */
async function sendCategoryEmail(
  to: string,
  category: NotificationCategory,
  subject: string,
  html: string,
  options: { transactional?: boolean } = {},
): Promise<SendOutcome> {
  const address = to.trim().toLowerCase();
  const db = getAdmin();

  if (db) {
    const { data: blocked } = await db
      .from('email_suppressions')
      .select('email')
      .eq('email', address)
      .maybeSingle();
    if (blocked) return { sent: false, reason: 'suppressed' };

    // Preferences are looked up by address because that is all the call sites
    // have. Since 00058 the model is opt-IN: a stored preference now has to say
    // `true` for the mail to go out.
    //
    // A MISSING row still sends, exactly as before. Every call site takes the
    // address straight off a players row, so "no row" in practice means the
    // lookup missed — an address stored with different casing, say — and
    // treating a failed lookup as a refusal would silently stop that member's
    // mail with nothing to show for it. Failing open here is deliberate; the
    // suppression list above is the gate that must never fail open.
    if (!options.transactional) {
      const { data: player } = await db
        .from('players')
        .select('notification_preferences')
        .eq('email', address)
        .maybeSingle();
      if (player && !isEmailCategoryEnabled(player.notification_preferences, category)) {
        return { sent: false, reason: 'opted_out' };
      }
    }
  }
  // A missing service-role key means we cannot check, and silently dropping
  // every notification would be worse than sending one the member muted. Fall
  // through and send.

  const base = process.env.NEXT_PUBLIC_PLAYER_URL;
  const allUrl = safeUnsubscribeUrl(base, address);
  const oneUrl = safeUnsubscribeUrl(base, address, category);

  const headers: Record<string, string> = {};
  if (allUrl) {
    // RFC 8058. List-Unsubscribe-Post is what makes Gmail/Outlook render their
    // own one-click control and POST it directly, which is far better for
    // reputation than the recipient reaching for "mark as spam" instead.
    headers['List-Unsubscribe'] = `<${allUrl}>`;
    headers['List-Unsubscribe-Post'] = 'List-Unsubscribe=One-Click';
  }

  await sendEmail(to, subject, withUnsubscribeFooter(html, oneUrl, allUrl), headers);
  return { sent: true };
}

// Never let a missing secret or base URL turn into a failed notification: the
// footer and header are additive, so losing them is better than losing the mail.
function safeUnsubscribeUrl(
  base: string | undefined,
  address: string,
  category?: NotificationCategory,
): string | null {
  try {
    return buildUnsubscribeUrl(base, address, category);
  } catch {
    return null;
  }
}

function withUnsubscribeFooter(
  html: string,
  oneUrl: string | null,
  allUrl: string | null,
): string {
  if (!oneUrl && !allUrl) return html;
  const parts: string[] = [];
  if (oneUrl) parts.push(`<a href="${oneUrl}" style="color:#666">Turn off these emails</a>`);
  if (allUrl) parts.push(`<a href="${allUrl}" style="color:#666">Unsubscribe from all</a>`);
  return `${html}
<div style="margin-top:24px;padding-top:12px;border-top:1px solid #eee;font-size:12px;color:#666;font-family:sans-serif">
  ${parts.join(' &middot; ')}
  <br />You are receiving this because you are a member of the SFU Badminton Club.
</div>`;
}

export async function sendChallengeReceivedEmail(
  to: string,
  challengerName: string,
  format: string,
  type: string,
  challengeId: string
): Promise<SendOutcome> {
  const url = `${process.env.NEXT_PUBLIC_PLAYER_URL || 'http://localhost:3000'}/challenges/${challengeId}`;
  const { subject, html } = challengeReceivedEmail(challengerName, format, type, url);
  return sendCategoryEmail(to, 'challenges', subject, html);
}

export async function sendChallengeAcceptedEmail(
  to: string,
  opponentName: string,
  challengeId: string
): Promise<SendOutcome> {
  const url = `${process.env.NEXT_PUBLIC_PLAYER_URL || 'http://localhost:3000'}/challenges/${challengeId}`;
  const { subject, html } = challengeAcceptedEmail(opponentName, url);
  return sendCategoryEmail(to, 'challenges', subject, html);
}

export async function sendChallengeRejectedEmail(
  to: string,
  opponentName: string,
  challengeId: string
): Promise<SendOutcome> {
  const url = `${process.env.NEXT_PUBLIC_PLAYER_URL || 'http://localhost:3000'}/challenges/${challengeId}`;
  const { subject, html } = challengeRejectedEmail(opponentName, url);
  return sendCategoryEmail(to, 'challenges', subject, html);
}

export async function sendResultPendingEmail(
  to: string,
  submitterName: string,
  score: string,
  matchId: string
): Promise<SendOutcome> {
  const url = `${process.env.NEXT_PUBLIC_PLAYER_URL || 'http://localhost:3000'}/challenges`;
  const { subject, html } = resultPendingEmail(submitterName, score, url);
  return sendCategoryEmail(to, 'matches', subject, html);
}

export async function sendMatchConfirmedEmail(
  to: string,
  opponentName: string,
  score: string,
  eloDelta: number,
  newRating: number,
  matchType: string
): Promise<SendOutcome> {
  const { subject, html } = matchConfirmedEmail(opponentName, score, eloDelta, newRating, matchType);
  return sendCategoryEmail(to, 'matches', subject, html);
}

// Dispute and walkover mail goes to ADMINS, not to the member involved. They are
// still categorised and still honour opt-out: an admin is a member too, and an
// operational alert nobody wants is exactly what teaches people to mark mail as
// spam.
export async function sendDisputeOpenedEmail(
  to: string,
  matchScore: string,
  reason: string,
  matchId: string
): Promise<SendOutcome> {
  const url = `${process.env.NEXT_PUBLIC_ADMIN_URL || 'http://localhost:3001'}/disputes`;
  const { subject, html } = disputeOpenedEmail(matchScore, reason, url);
  return sendCategoryEmail(to, 'matches', subject, html);
}

export async function sendWalkoverReportedEmail(
  to: string,
  forfeitPlayerName: string,
  walkoverType: string,
  challengeId: string
): Promise<SendOutcome> {
  const url = `${process.env.NEXT_PUBLIC_ADMIN_URL || 'http://localhost:3001'}/walkovers`;
  const { subject, html } = walkoverReportedEmail(forfeitPlayerName, walkoverType, url);
  return sendCategoryEmail(to, 'matches', subject, html);
}

export async function sendPlayerApprovedEmail(
  to: string,
  name: string
): Promise<SendOutcome> {
  const loginUrl = `${process.env.NEXT_PUBLIC_PLAYER_URL || 'http://localhost:3000'}/login`;
  const { subject, html } = playerApprovedEmail(name, loginUrl);
  // Transactional: this is the message that tells someone the club has let them
  // in, and it is sent to an account whose preferences are still empty because
  // they have never seen the settings page. Gating it on an opt-in they have had
  // no opportunity to give would leave every new member staring at "pending".
  return sendCategoryEmail(to, 'announcements', subject, html, { transactional: true });
}

export async function sendWeeklyDigestEmail(
  to: string,
  name: string,
  data: {
    matchesPlayed: number;
    wins: number;
    losses: number;
    eloChange: number;
    singlesRating: number;
    doublesRating: number;
    rank?: number;
  }
): Promise<SendOutcome> {
  const url = `${process.env.NEXT_PUBLIC_PLAYER_URL || 'http://localhost:3000'}/my-stats`;
  const { subject, html } = weeklyDigestEmail(name, data, url);
  return sendCategoryEmail(to, 'announcements', subject, html);
}
