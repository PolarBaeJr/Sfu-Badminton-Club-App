import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '@/lib/supabase-server';
import { sendWeeklyDigestEmail } from '@badminton/shared';

export const dynamic = 'force-dynamic';

// A member's own week: matches played, record, rating movement. Called by
// pg_cron once a week — same shape as session-reminders, and for the same
// reason (Postgres cannot talk to the mail provider itself).
//
// This is the ONLY scheduled mail the app sends. Everything else is a direct
// consequence of somebody acting on the recipient's account, which is why the
// opt-out matters more here than anywhere else: sendWeeklyDigestEmail runs
// through sendCategoryEmail, so a member who muted the category or is on the
// suppression list is skipped before the provider is ever called.
export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: 'Not configured' }, { status: 503 });
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const admin = createAdminClient();
    const now = new Date();
    const since = new Date(now.getTime() - 7 * 86400000).toISOString();

    // Only players who actually played. A digest saying "0 matches, no change"
    // is the kind of mail that earns a spam complaint, and a complaint is the
    // most expensive signal there is on SES.
    const { data: rows, error } = await admin
      .from('match_participants')
      .select('player_id, rating_delta, post_rating, win_flag, matches!inner(played_at, result_status), players!inner(full_name, email)')
      .gte('matches.played_at', since)
      .eq('matches.result_status', 'confirmed');
    if (error) throw new Error(error.message);

    interface Agg {
      name: string;
      email: string;
      matchesPlayed: number;
      wins: number;
      losses: number;
      eloChange: number;
      latestRating: number;
    }
    const byPlayer = new Map<string, Agg>();

    for (const r of rows ?? []) {
      const p = r.players as unknown as { full_name?: string; email?: string } | null;
      if (!p?.email) continue;
      const cur = byPlayer.get(r.player_id as string) ?? {
        name: p.full_name ?? 'there',
        email: p.email,
        matchesPlayed: 0,
        wins: 0,
        losses: 0,
        eloChange: 0,
        latestRating: 0,
      };
      cur.matchesPlayed += 1;
      if (r.win_flag === true) cur.wins += 1;
      else if (r.win_flag === false) cur.losses += 1;
      cur.eloChange += r.rating_delta ?? 0;
      if (typeof r.post_rating === 'number') cur.latestRating = r.post_rating;
      byPlayer.set(r.player_id as string, cur);
    }

    let sent = 0;
    let skipped = 0;
    for (const agg of byPlayer.values()) {
      // Sequential on purpose: this is a handful of members, and a burst of
      // parallel sends against a fresh SES reputation is exactly the shape that
      // gets throttled.
      const outcome = await sendWeeklyDigestEmail(agg.email, agg.name, {
        matchesPlayed: agg.matchesPlayed,
        wins: agg.wins,
        losses: agg.losses,
        eloChange: agg.eloChange,
        // The digest template shows both; this job only tracks the rating the
        // member's own matches moved, so report it for both rather than
        // inventing a number for a discipline they did not play.
        singlesRating: agg.latestRating,
        doublesRating: agg.latestRating,
      }).catch((err) => {
        // One bad address must not stop the rest of the run.
        Sentry.captureException(err, { extra: { job: 'weekly-digest' } });
        return null;
      });

      if (outcome?.sent) sent += 1;
      else skipped += 1;
    }

    return NextResponse.json({ ran_at: now.toISOString(), eligible: byPlayer.size, sent, skipped });
  } catch (err) {
    Sentry.captureException(err, { extra: { job: 'weekly-digest' } });
    return NextResponse.json({ error: 'Weekly digest job failed' }, { status: 500 });
  }
}
