import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import {
  verifyUnsubscribeToken,
  allEmailCategoriesOff,
  emailCategoryPatch,
  NOTIFICATION_CATEGORIES,
  rateLimit,
  getClientIp,
} from '@badminton/shared';
import { createServiceRoleClient } from '@/lib/supabase-server';

// Unsubscribing must work with NO session. A recipient who cannot log in — or
// a mail client acting on their behalf — still has to be able to stop the mail;
// requiring sign-in is how you train people to hit "mark as spam" instead, and
// on SES a complaint rate is what gets sending suspended.
//
// The authority is the signed token in the link, not a cookie. It only ever
// authorises the address it was signed for, so the worst a leaked link does is
// stop that person's own email — which is exactly what the link is for.
export const dynamic = 'force-dynamic';

const CATEGORY_LABEL = new Map(NOTIFICATION_CATEGORIES.map((c) => [c.key, c.label]));

async function apply(token: string | null): Promise<{ ok: boolean; message: string }> {
  if (!token) return { ok: false, message: 'This link is missing its token.' };

  const claim = verifyUnsubscribeToken(token);
  if (!claim) {
    return {
      ok: false,
      message: 'This unsubscribe link is not valid. It may have been altered, or the link may be from an older email.',
    };
  }

  const db = createServiceRoleClient();

  if (claim.category === null) {
    // "Unsubscribe from all" — suppress the ADDRESS rather than only flipping
    // preferences. That way it holds even for an address with no player row,
    // and it is the same switch the bounce/complaint webhook throws, so there
    // is one place to look when asking why someone stopped getting mail.
    const { error } = await db.from('email_suppressions').upsert(
      {
        email: claim.email,
        reason: 'unsubscribe',
        detail: { source: 'one-click' },
      },
      { onConflict: 'email' },
    );
    if (error) return { ok: false, message: 'Something went wrong. Please try again shortly.' };

    // Mirror it into preferences too, so the settings screen reflects reality
    // if they do log in later. Best-effort: the suppression above is what
    // actually stops the mail.
    //
    // MERGED, not replaced. This used to write allEmailCategoriesOff() over the
    // whole blob, which also erased the push toggles and the session reminder
    // lead time. Under the opt-in model (00058) erasing them means turning them
    // OFF — so unsubscribing from email would silently kill this member's push
    // notifications as well. An email link may only ever change email keys.
    // One statement (00180): read-merge-write here had a window in which a
    // concurrent settings save was overwritten, and a failed read merged onto
    // {} and replaced the whole blob.
    await db.rpc('merge_notification_preferences_by_email', {
      p_email: claim.email,
      p_patch: allEmailCategoriesOff(),
    });

    return { ok: true, message: 'You will no longer receive any emails from SFU Badminton Club.' };
  }

  // Single category: merge into the existing blob rather than replacing it, or
  // this would wipe their push preferences and session reminder lead time.
  const { data: player, error: playerError } = await db
    .from('players')
    .select('notification_preferences')
    .eq('email', claim.email)
    .maybeSingle();

  // A failed read and a genuine no-such-member both arrive as `player == null`,
  // so without splitting them a database fault fell into the suppression
  // fallback below — and if that write failed too, the page still promised the
  // mail would stop. Telling someone their unsubscribe worked when nothing was
  // written is the one outcome this route must never produce.
  if (playerError) {
    Sentry.captureException(playerError, { tags: { route: 'unsubscribe' } });
    return { ok: false, message: 'Something went wrong. Please try again shortly.' };
  }

  if (!player) {
    // No player row to store a per-category preference against. Suppressing
    // outright is the honest fallback — better to over-honour the request than
    // to report success and keep sending.
    const { error: suppressError } = await db.from('email_suppressions').upsert(
      { email: claim.email, reason: 'unsubscribe', detail: { source: 'one-click', category: claim.category } },
      { onConflict: 'email' },
    );
    if (suppressError) {
      Sentry.captureException(suppressError, { tags: { route: 'unsubscribe' } });
      return { ok: false, message: 'Something went wrong. Please try again shortly.' };
    }
    return { ok: true, message: 'You will no longer receive these emails.' };
  }

  const { error } = await db.rpc('merge_notification_preferences_by_email', {
    p_email: claim.email,
    p_patch: emailCategoryPatch(claim.category, false),
  });
  if (error) {
    Sentry.captureException(error, { tags: { route: 'unsubscribe' } });
    return { ok: false, message: 'Something went wrong. Please try again shortly.' };
  }

  const label = CATEGORY_LABEL.get(claim.category) ?? 'these';
  return { ok: true, message: `You will no longer receive "${label}" emails.` };
}

function page(message: string, ok: boolean): NextResponse {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${ok ? 'Unsubscribed' : 'Unsubscribe'}</title></head>
<body style="font-family:system-ui,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1rem;line-height:1.6;color:#111">
<h1 style="font-size:1.5rem;margin-bottom:.5rem">${ok ? 'Unsubscribed' : 'Unsubscribe'}</h1>
<p>${message}</p>
${ok ? '<p style="color:#666;font-size:.9rem">You will still receive sign-in codes, because those are needed to access your account.</p>' : ''}
</body></html>`;
  return new NextResponse(html, {
    status: ok ? 200 : 400,
    headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}

export async function GET(request: Request) {
  // Someone spraying guessed tokens would just be failing signature checks, but
  // there is no reason to let them do it quickly.
  const rl = rateLimit(`unsub:${getClientIp(request)}`, 30, 60_000);
  if (!rl.success) return new NextResponse('Too many requests', { status: 429 });

  const token = new URL(request.url).searchParams.get('token');
  const result = await apply(token);
  return page(result.message, result.ok);
}

// RFC 8058 one-click: the mail client POSTs here itself, with no user present.
// It must succeed without a confirmation step — that is the entire point of the
// List-Unsubscribe-Post header.
export async function POST(request: Request) {
  const rl = rateLimit(`unsub:${getClientIp(request)}`, 30, 60_000);
  if (!rl.success) return new NextResponse('Too many requests', { status: 429 });

  const url = new URL(request.url);
  let token = url.searchParams.get('token');
  if (!token) {
    // Some clients put the token in the form body instead of keeping the query.
    try {
      const form = await request.formData();
      const fromBody = form.get('token');
      if (typeof fromBody === 'string') token = fromBody;
    } catch {
      // No parseable body; the query string was the only chance.
    }
  }

  const result = await apply(token);
  // Always 200 for a valid unsubscribe. Mail clients treat a non-2xx as a
  // failed unsubscribe and may show the recipient an error, which pushes them
  // toward the spam button.
  return new NextResponse(result.ok ? 'OK' : result.message, {
    status: result.ok ? 200 : 400,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' },
  });
}
