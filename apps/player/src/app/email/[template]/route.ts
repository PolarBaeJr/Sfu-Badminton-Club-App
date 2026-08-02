import { NextResponse } from 'next/server';
import { getActiveSeason } from '@/lib/supabase-server';

// GoTrue's auth emails. It fetches these over HTTP at send time —
// GOTRUE_MAILER_TEMPLATES_{MAGIC_LINK,RECOVERY,CONFIRMATION} point at
// https://sfubadminton.com/email/<name>.html — so serving them from a route
// instead of public/ lets the season line read from the database rather than
// being hand-edited every term. All three previously said "Season 26" while the
// active season was Fall 2026.
//
// These replace the files that used to live in public/email/. A static file
// there would shadow this route, so the originals were deleted rather than
// left alongside.
//
// The middleware matcher already exempts /email/, which is what lets GoTrue
// fetch them with no session.
export const dynamic = 'force-dynamic';

// The three templates differed in exactly one line — this label. Everything
// else was byte-identical, so it lives in one place now.
const EYEBROWS: Record<string, string> = {
  'magic_link.html': 'Your sign-in code',
  'confirmation.html': 'Your sign-in code',
  'recovery.html': 'Reset code',
};

// {{ .Token }} is GoTrue's placeholder and must reach it untouched — it is
// substituted after this HTML is fetched, not here.
function render(eyebrow: string, seasonLabel: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#FAF8F5;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#FAF8F5;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:480px;background:#ffffff;border:1px solid #ECE7E1;border-radius:16px;overflow:hidden;">
        <!-- header -->
        <tr><td style="background:#141110;padding:28px 32px;">
          <table role="presentation" cellpadding="0" cellspacing="0"><tr>
            <td style="width:40px;height:40px;background:#CC0633;border-radius:9px;text-align:center;vertical-align:middle;color:#fff;font-weight:800;font-size:16px;letter-spacing:1px;">SB</td>
            <td style="padding-left:12px;color:#fff;font-weight:700;font-size:17px;">SFU Badminton<div style="color:rgba(255,255,255,.5);font-size:11px;font-weight:600;letter-spacing:.12em;text-transform:uppercase;margin-top:2px;">${seasonLabel}</div></td>
          </tr></table>
        </td></tr>
        <!-- body -->
        <tr><td style="padding:36px 32px 8px;">
          <div style="font-size:12px;font-weight:700;letter-spacing:.14em;text-transform:uppercase;color:#CC0633;margin-bottom:12px;">${eyebrow}</div>
          <h1 style="margin:0 0 12px;font-size:26px;font-weight:800;color:#141110;letter-spacing:-.02em;">Ready to hit the court.</h1>
          <p style="margin:0 0 22px;font-size:15px;line-height:1.6;color:#5B534C;">Enter this 6-digit code on the sign-in page. It expires in 15 minutes.</p>
          <div style="font-family:'Courier New',monospace;font-size:38px;font-weight:800;letter-spacing:.22em;color:#141110;background:#FAF8F5;border:1px solid #ECE7E1;border-radius:12px;padding:18px 0;text-align:center;">{{ .Token }}</div>
          <p style="margin:24px 0 0;font-size:13px;line-height:1.6;color:#8A817A;">Type the code above on the sign-in page — it’s the fastest way in. Never share it with anyone.</p>
        </td></tr>
        <!-- footer -->
        <tr><td style="padding:24px 32px 30px;border-top:1px solid #F0EBE5;">
          <p style="margin:0;font-size:12px;line-height:1.6;color:#A69E97;">You're receiving this because someone requested a sign-in link for this email at SFU Badminton. If that wasn't you, you can safely ignore it — no changes will be made.</p>
        </td></tr>
      </table>
      <div style="max-width:480px;margin-top:16px;font-size:11px;color:#B8B0A8;text-align:center;letter-spacing:.05em;">SFU Badminton Club · Lorne Davies Complex, Burnaby BC</div>
    </td></tr>
  </table>
</body>
</html>
`;
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ template: string }> },
) {
  const { template } = await params;
  const eyebrow = EYEBROWS[template];
  if (!eyebrow) return new NextResponse('Not found', { status: 404 });

  // Falls back to a bare "Club" rather than failing: if the season lookup
  // breaks, GoTrue gets a template with a slightly plainer header, which is far
  // better than a failed fetch — that would stop sign-in emails entirely.
  const season = await getActiveSeason().catch(() => null);
  const seasonLabel = season?.name ? `Club · ${season.name}` : 'Club';

  return new NextResponse(render(eyebrow, seasonLabel), {
    headers: {
      'Content-Type': 'text/html; charset=utf-8',
      // GoTrue re-fetches per send; never let a proxy pin last term's name.
      'Cache-Control': 'no-store',
    },
  });
}
