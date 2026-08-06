const BRAND_STYLES = `
  font-family: 'DM Sans', -apple-system, sans-serif;
  max-width: 600px;
  margin: 0 auto;
  background: #16213E;
  color: #f4f4f5;
  padding: 32px;
  border-radius: 12px;
`;

const BUTTON_STYLES = `
  display: inline-block;
  background: #E94560;
  color: #ffffff;
  padding: 14px 28px;
  border-radius: 8px;
  text-decoration: none;
  font-weight: 600;
  margin-top: 16px;
`;

const MUTED = 'color: #a1a1aa; font-size: 14px;';
const DIVIDER = '<hr style="border: none; border-top: 1px solid rgba(255,255,255,0.1); margin: 24px 0;" />';

// Every dynamic value below is user-controlled (display names, scores, dispute
// reasons) and lands in an HTML email body. Without escaping, a player whose
// name is `<a href="...">` can inject links/markup into opponent and admin
// inboxes — content spoofing / phishing. Escape at every interpolation.
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Subjects are headers, not HTML: strip CR/LF so a crafted name can't inject
// extra headers, and collapse the remaining whitespace.
function subj(value: unknown): string {
  return String(value ?? '').replace(/[\r\n]+/g, ' ').trim();
}

function wrap(content: string): string {
  return `<div style="${BRAND_STYLES}">${content}<p style="${MUTED} margin-top: 32px;">SFU Badminton Club</p></div>`;
}

export function magicLinkEmail(loginUrl: string): { subject: string; html: string } {
  return {
    subject: 'Your SFU Badminton Login Link',
    html: wrap(`
      <h2 style="color: #E94560; margin-bottom: 16px;">Sign In</h2>
      <p>Click below to sign in to SFU Badminton Club. This link expires in 10 minutes.</p>
      <a href="${escapeHtml(loginUrl)}" style="${BUTTON_STYLES}">Sign In</a>
      <p style="${MUTED} margin-top: 16px;">If you didn't request this, you can safely ignore this email.</p>
    `),
  };
}

export function welcomeEmail(name: string, loginUrl: string): { subject: string; html: string } {
  return {
    subject: 'Welcome to SFU Badminton Club!',
    html: wrap(`
      <h1 style="color: #E94560; margin-bottom: 16px;">Welcome, ${escapeHtml(name)}!</h1>
      <p>Your account has been approved. You can now log in and start challenging other players.</p>
      <p>You start with a <strong>400 Elo</strong> rating in both singles and doubles.</p>
      <a href="${escapeHtml(loginUrl)}" style="${BUTTON_STYLES}">Log In</a>
    `),
  };
}

export function challengeReceivedEmail(challengerName: string, format: string, type: string, url: string): { subject: string; html: string } {
  return {
    subject: `New Challenge from ${subj(challengerName)}`,
    html: wrap(`
      <h2 style="color: #E94560;">New Challenge!</h2>
      <p><strong>${escapeHtml(challengerName)}</strong> has challenged you to a <strong>${escapeHtml(format)}</strong> ${escapeHtml(type)} match.</p>
      <p style="${MUTED}">Challenges expire after 72 hours.</p>
      <a href="${escapeHtml(url)}" style="${BUTTON_STYLES}">View Challenge</a>
    `),
  };
}

export function challengeAcceptedEmail(opponentName: string, url: string): { subject: string; html: string } {
  return {
    subject: `${subj(opponentName)} accepted your challenge!`,
    html: wrap(`
      <h2 style="color: #10B981;">Challenge Accepted</h2>
      <p><strong>${escapeHtml(opponentName)}</strong> has accepted your challenge. Time to play!</p>
      <a href="${escapeHtml(url)}" style="${BUTTON_STYLES}">View Challenge</a>
    `),
  };
}

export function challengeRejectedEmail(opponentName: string, url: string): { subject: string; html: string } {
  return {
    subject: `${subj(opponentName)} declined your challenge`,
    html: wrap(`
      <h2 style="color: #F59E0B;">Challenge Declined</h2>
      <p><strong>${escapeHtml(opponentName)}</strong> has declined your challenge.</p>
      <a href="${escapeHtml(url)}" style="${BUTTON_STYLES}">View Challenges</a>
    `),
  };
}

export function resultPendingEmail(submitterName: string, score: string, url: string): { subject: string; html: string } {
  return {
    subject: 'Match Result Needs Confirmation',
    html: wrap(`
      <h2 style="color: #E94560;">Confirm Match Result</h2>
      <p><strong>${escapeHtml(submitterName)}</strong> submitted a match result: <strong>${escapeHtml(score)}</strong></p>
      <p style="${MUTED}">Please confirm or dispute this result.</p>
      <a href="${escapeHtml(url)}" style="${BUTTON_STYLES}">Confirm Result</a>
    `),
  };
}

export function matchConfirmedEmail(opponentName: string, score: string, eloDelta: number, newRating: number, matchType: string): { subject: string; html: string } {
  const deltaStr = eloDelta >= 0 ? `+${eloDelta}` : `${eloDelta}`;
  const deltaColor = eloDelta >= 0 ? '#10B981' : '#EF4444';
  return {
    subject: `Match confirmed — ${deltaStr} Elo`,
    html: wrap(`
      <h2 style="color: #E94560;">Match Confirmed</h2>
      <p>Your ${escapeHtml(matchType)} match vs <strong>${escapeHtml(opponentName)}</strong> is confirmed.</p>
      <div style="background: rgba(255,255,255,0.05); padding: 16px; border-radius: 8px; margin: 16px 0;">
        <p style="margin: 4px 0;">Score: <strong>${escapeHtml(score)}</strong></p>
        <p style="margin: 4px 0;">Elo Change: <strong style="color: ${deltaColor};">${deltaStr}</strong></p>
        <p style="margin: 4px 0;">New Rating: <strong>${newRating}</strong></p>
      </div>
    `),
  };
}

export function disputeOpenedEmail(matchScore: string, reason: string, url: string): { subject: string; html: string } {
  return {
    subject: 'Match Result Disputed',
    html: wrap(`
      <h2 style="color: #EF4444;">Dispute Opened</h2>
      <p>A dispute has been opened for match with score: <strong>${escapeHtml(matchScore)}</strong></p>
      <p style="${MUTED}">Reason: ${escapeHtml(reason)}</p>
      <p>An admin will review this dispute.</p>
      <a href="${escapeHtml(url)}" style="${BUTTON_STYLES}">View Details</a>
    `),
  };
}

export function walkoverReportedEmail(forfeitPlayerName: string, walkoverType: string, url: string): { subject: string; html: string } {
  return {
    subject: 'Walkover Reported',
    html: wrap(`
      <h2 style="color: #F59E0B;">Walkover Reported</h2>
      <p>A <strong>${escapeHtml(walkoverType)}</strong> walkover has been reported for <strong>${escapeHtml(forfeitPlayerName)}</strong>.</p>
      <p style="${MUTED}">An admin will review within 48 hours.</p>
      <a href="${escapeHtml(url)}" style="${BUTTON_STYLES}">View Details</a>
    `),
  };
}

export function playerApprovedEmail(name: string, loginUrl: string): { subject: string; html: string } {
  return welcomeEmail(name, loginUrl);
}

// "Your membership went inactive" — sent once per lapse, by the console's
// /api/cron/inactivity-notices sweep.
//
// THE WORDING IS THE CAREFUL PART. The club owner asked for this to say the
// member's data would be deleted after a year. Nothing in this app deletes
// inactive accounts on any timetable — purge-deleted-accounts handles the
// 30-day window for people who ASKED to be deleted, and that is the whole of
// the retention machinery. Promising a deletion that does not happen is the
// worst property a data-retention notice can have: it is the one kind of
// message a member may act on by doing nothing, and it would be false.
//
// So this states what is actually true today — off the active roster, nothing
// removed, sign in and you are back, and here is how to request deletion if
// that is what you want. If the club decides it does want a one-year purge,
// that is a separate decision and a separate job, and this copy changes with
// it rather than ahead of it.
export function accountInactiveEmail(
  name: string,
  thresholdDays: number,
  loginUrl: string,
): { subject: string; html: string } {
  return {
    subject: subj('Your SFU Badminton membership is now inactive'),
    html: wrap(`
      <h2 style="color: #E94560; margin-bottom: 16px;">Your membership is inactive</h2>
      <p>Hi ${escapeHtml(name)} — we haven't seen you at a club session in about
         ${escapeHtml(thresholdDays)} days, so we've moved your membership off the active roster.</p>
      ${DIVIDER}
      <p><strong>Nothing has been deleted.</strong> Your match history, your rating and
         your record are all exactly where you left them.</p>
      <p>Being inactive just means club activity is paused: no challenges, RSVPs,
         check-ins or tournament entries until you're back.</p>
      <p><strong>Signing in is all it takes.</strong> Your membership reactivates by itself
         the moment you log in — there is nothing to ask anyone for.</p>
      <a href="${escapeHtml(loginUrl)}" style="${BUTTON_STYLES}">Sign in and come back</a>
      ${DIVIDER}
      <p style="${MUTED}">If you would rather we deleted your account and its personal
         details, you can request that yourself under Settings once you're signed in.
         We hold the account for 30 days after a deletion request, in case you change
         your mind.</p>
    `),
  };
}

export function weeklyDigestEmail(
  name: string,
  data: {
    matchesPlayed: number;
    wins: number;
    losses: number;
    eloChange: number;
    singlesRating: number;
    doublesRating: number;
    rank?: number;
  },
  url: string
): { subject: string; html: string } {
  const eloStr = data.eloChange >= 0 ? `+${data.eloChange}` : `${data.eloChange}`;
  return {
    subject: `Your weekly recap — ${eloStr} Elo`,
    html: wrap(`
      <h2 style="color: #E94560;">Weekly Recap</h2>
      <p>Hey ${escapeHtml(name)}, here's your week in review:</p>
      ${DIVIDER}
      <div style="background: rgba(255,255,255,0.05); padding: 16px; border-radius: 8px;">
        <p style="margin: 6px 0;">Matches Played: <strong>${data.matchesPlayed}</strong></p>
        <p style="margin: 6px 0;">Record: <strong>${data.wins}W - ${data.losses}L</strong></p>
        <p style="margin: 6px 0;">Net Elo: <strong style="color: ${data.eloChange >= 0 ? '#10B981' : '#EF4444'};">${eloStr}</strong></p>
        <p style="margin: 6px 0;">Singles: <strong>${data.singlesRating}</strong> | Doubles: <strong>${data.doublesRating}</strong></p>
        ${data.rank ? `<p style="margin: 6px 0;">Current Rank: <strong>#${data.rank}</strong></p>` : ''}
      </div>
      ${DIVIDER}
      <a href="${escapeHtml(url)}" style="${BUTTON_STYLES}">View Dashboard</a>
    `),
  };
}
