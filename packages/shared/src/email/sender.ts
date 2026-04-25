import { Resend } from 'resend';
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

let resend: Resend | null = null;

function getResend(): Resend {
  if (!resend) {
    resend = new Resend(process.env.RESEND_API_KEY);
  }
  return resend;
}

const FROM = 'SFU Badminton <noreply@badminton.club>';

export async function sendEmail(to: string, subject: string, html: string): Promise<void> {
  // Throws on failure so callers can decide whether to swallow + log.
  // We deliberately don't catch internally — earlier behaviour double-swallowed
  // errors (here and at every call site), making delivery failures invisible.
  if (!process.env.RESEND_API_KEY) {
    throw new Error('RESEND_API_KEY not set');
  }
  const r = getResend();
  const { error } = await r.emails.send({ from: FROM, to, subject, html });
  if (error) {
    throw new Error(`Resend send failed: ${error.message}`);
  }
}

export async function sendChallengeReceivedEmail(
  to: string,
  challengerName: string,
  format: string,
  type: string,
  challengeId: string
): Promise<void> {
  const url = `${process.env.NEXT_PUBLIC_PLAYER_URL || 'http://localhost:3000'}/challenges/${challengeId}`;
  const { subject, html } = challengeReceivedEmail(challengerName, format, type, url);
  await sendEmail(to, subject, html);
}

export async function sendChallengeAcceptedEmail(
  to: string,
  opponentName: string,
  challengeId: string
): Promise<void> {
  const url = `${process.env.NEXT_PUBLIC_PLAYER_URL || 'http://localhost:3000'}/challenges/${challengeId}`;
  const { subject, html } = challengeAcceptedEmail(opponentName, url);
  await sendEmail(to, subject, html);
}

export async function sendChallengeRejectedEmail(
  to: string,
  opponentName: string,
  challengeId: string
): Promise<void> {
  const url = `${process.env.NEXT_PUBLIC_PLAYER_URL || 'http://localhost:3000'}/challenges/${challengeId}`;
  const { subject, html } = challengeRejectedEmail(opponentName, url);
  await sendEmail(to, subject, html);
}

export async function sendResultPendingEmail(
  to: string,
  submitterName: string,
  score: string,
  matchId: string
): Promise<void> {
  const url = `${process.env.NEXT_PUBLIC_PLAYER_URL || 'http://localhost:3000'}/challenges`;
  const { subject, html } = resultPendingEmail(submitterName, score, url);
  await sendEmail(to, subject, html);
}

export async function sendMatchConfirmedEmail(
  to: string,
  opponentName: string,
  score: string,
  eloDelta: number,
  newRating: number,
  matchType: string
): Promise<void> {
  const { subject, html } = matchConfirmedEmail(opponentName, score, eloDelta, newRating, matchType);
  await sendEmail(to, subject, html);
}

export async function sendDisputeOpenedEmail(
  to: string,
  matchScore: string,
  reason: string,
  matchId: string
): Promise<void> {
  const url = `${process.env.NEXT_PUBLIC_ADMIN_URL || 'http://localhost:3001'}/disputes`;
  const { subject, html } = disputeOpenedEmail(matchScore, reason, url);
  await sendEmail(to, subject, html);
}

export async function sendWalkoverReportedEmail(
  to: string,
  forfeitPlayerName: string,
  walkoverType: string,
  challengeId: string
): Promise<void> {
  const url = `${process.env.NEXT_PUBLIC_ADMIN_URL || 'http://localhost:3001'}/walkovers`;
  const { subject, html } = walkoverReportedEmail(forfeitPlayerName, walkoverType, url);
  await sendEmail(to, subject, html);
}

export async function sendPlayerApprovedEmail(
  to: string,
  name: string
): Promise<void> {
  const loginUrl = `${process.env.NEXT_PUBLIC_PLAYER_URL || 'http://localhost:3000'}/login`;
  const { subject, html } = playerApprovedEmail(name, loginUrl);
  await sendEmail(to, subject, html);
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
): Promise<void> {
  const url = `${process.env.NEXT_PUBLIC_PLAYER_URL || 'http://localhost:3000'}/my-stats`;
  const { subject, html } = weeklyDigestEmail(name, data, url);
  await sendEmail(to, subject, html);
}
