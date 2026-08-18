import { NextResponse } from 'next/server';
import * as Sentry from '@sentry/nextjs';
import { createAdminClient } from '@/lib/supabase-server';
import { sendWeeklyDigestEmail, selectAllPages } from '@badminton/shared';

export const dynamic = 'force-dynamic';

// A member's own week: matches played, record, rating movement. Called by
// pg_cron once a week — same shape as session-reminders, and for the same
// reason (Postgres cannot talk to the mail provider itself).
//
// This is the ONLY scheduled mail the app sends. Everything else is a direct
// consequence of somebody acting on the recipient's account, which is why
// consent matters more here than anywhere else: sendWeeklyDigestEmail runs
// through sendCategoryEmail, so anyone who has not opted into the announcements
// category — the default since 00058 — or who is on the suppression list is
// skipped before the provider is ever called.

// SENDS ARE BOUNDED PER INVOCATION, and where the run got to is written down.
//
// The job used to send to every eligible member in one request. pg_net's
// default timeout is 5s; a hundred and fifty sequential provider round trips is
// not a 5s request, so pg_net recorded a timeout while the handler kept running
// (nothing wires an abort signal through), and the run looked failed whether it
// was or not. Re-POSTing it — the obvious response to a failed job — then
// mailed everyone who had already been mailed a second time.
//
// So: a bounded batch, and a cursor. Re-POSTing now RESUMES instead of
// restarting, and once the week is finished any further POST is a no-op.
const MAX_SENDS_PER_RUN = 40;

// cron_config already exists (00033), is RLS-enabled with no policies, and is
// revoked from anon and authenticated — the service-role client this route uses
// bypasses RLS. Reusing it keeps this fix app-layer: no migration, nothing for
// anyone to apply before the next Monday.
const PROGRESS_KEY = 'weekly_digest_progress';

interface DigestProgress {
  /** The Monday this digest is FOR, as YYYY-MM-DD. */
  window: string;
  /** The last player_id successfully processed, in ascending id order. */
  after: string | null;
  complete: boolean;
}

/**
 * The Monday at or before `now`, midnight UTC.
 *
 * THE PERIOD IS DERIVED FROM THIS, not from the clock. `since = now - 7 days`
 * meant two invocations four minutes apart covered two different weeks, so a
 * resumed run would report a slightly different week to the members it reached
 * second — and a match played on the Monday afternoon fell inside both this
 * week's digest and next week's. Anchoring both ends to the week boundary makes
 * the period identical for every invocation and every member, and makes each
 * match count exactly once.
 */
function weekStart(now: Date): Date {
  const d = new Date(now);
  d.setUTCHours(0, 0, 0, 0);
  // getUTCDay is 0=Sunday..6=Saturday; (dow + 6) % 7 is days since Monday.
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d;
}

async function readProgress(
  admin: ReturnType<typeof createAdminClient>,
  window: string,
): Promise<DigestProgress> {
  const { data } = await admin.from('cron_config').select('value').eq('key', PROGRESS_KEY).maybeSingle();
  const fresh: DigestProgress = { window, after: null, complete: false };
  if (!data?.value) return fresh;
  try {
    const parsed = JSON.parse(data.value as string) as Partial<DigestProgress>;
    // A cursor from an earlier week says nothing about this one. Starting over
    // is correct here and not a re-send: it is a different week's mail.
    if (parsed.window !== window) return fresh;
    return { window, after: parsed.after ?? null, complete: parsed.complete === true };
  } catch {
    // Unparseable state must not wedge the job for ever. Losing the cursor
    // costs at most one week's duplicate sends; refusing to run costs the
    // digest entirely, every week, until somebody notices.
    Sentry.captureMessage('weekly-digest: unreadable progress cursor, restarting the week');
    return fresh;
  }
}

async function writeProgress(
  admin: ReturnType<typeof createAdminClient>,
  progress: DigestProgress,
): Promise<void> {
  const { error } = await admin
    .from('cron_config')
    .upsert({ key: PROGRESS_KEY, value: JSON.stringify(progress) }, { onConflict: 'key' });
  // NOT swallowed. If the cursor cannot be written the next invocation will
  // resend to everyone this one just mailed, which is the exact failure this
  // whole mechanism exists to prevent — better to fail the run loudly.
  if (error) throw new Error(`Could not record digest progress: ${error.message}`);
}

export async function POST(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret) return NextResponse.json({ error: 'Not configured' }, { status: 503 });
  if (request.headers.get('authorization') !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const admin = createAdminClient();
    const now = new Date();
    const periodEnd = weekStart(now);
    const periodStart = new Date(periodEnd.getTime() - 7 * 86400000);
    const window = periodEnd.toISOString().slice(0, 10);

    const progress = await readProgress(admin, window);
    if (progress.complete) {
      return NextResponse.json({ ran_at: now.toISOString(), window, already_complete: true });
    }

    // Only players who actually played. A digest saying "0 matches, no change"
    // is the kind of mail that earns a spam complaint, and a complaint is the
    // most expensive signal there is on a sending reputation.
    //
    // PAGED. PGRST_DB_MAX_ROWS is 1000 on production and PostgREST truncates at
    // it SILENTLY — supabase-js resolves rather than rejects — so a busy week
    // (250 doubles matches is already 1000 participant rows) would come back
    // truncated and the members past the cap would simply never be mailed, with
    // nothing anywhere reporting it.
    interface Row {
      player_id: string;
      rating_delta: number | null;
      post_rating: number | null;
      win_flag: boolean | null;
      matches: { played_at: string; match_type: string } | null;
      players: { full_name?: string; email?: string } | null;
    }
    const { data: rows, error } = await selectAllPages<Row>((from, to) =>
      admin
        .from('match_participants')
        .select('player_id, rating_delta, post_rating, win_flag, matches!inner(played_at, result_status, match_type), players!inner(full_name, email)')
        .gte('matches.played_at', periodStart.toISOString())
        .lt('matches.played_at', periodEnd.toISOString())
        .eq('matches.result_status', 'confirmed')
        .order('player_id')
        .range(from, to) as never,
    );
    if (error) throw new Error(error.message);

    interface Agg {
      playerId: string;
      name: string;
      email: string;
      matchesPlayed: number;
      wins: number;
      losses: number;
      eloChange: number;
      // Per discipline, and NULL until the member actually played one.
      //
      // Three defects lived in the single `latestRating` this replaces. It was
      // reported as BOTH the singles and the doubles figure, so a member who
      // played only doubles was told their singles rating had moved to a number
      // they had never held. It was whatever row happened to arrive last from
      // an unordered read, not the latest — so it moved around between runs.
      // And it initialised to 0, so an unrated week mailed out "Singles: 0",
      // which reads as a wiped rating rather than as no data.
      singles: { rating: number; at: string } | null;
      doubles: { rating: number; at: string } | null;
    }
    const byPlayer = new Map<string, Agg>();

    for (const r of rows ?? []) {
      const p = r.players as { full_name?: string; email?: string } | null;
      const m = r.matches as { played_at: string; match_type: string } | null;
      if (!p?.email || !m) continue;
      const cur = byPlayer.get(r.player_id) ?? {
        playerId: r.player_id,
        name: p.full_name ?? 'there',
        email: p.email,
        matchesPlayed: 0,
        wins: 0,
        losses: 0,
        eloChange: 0,
        singles: null,
        doubles: null,
      };
      cur.matchesPlayed += 1;
      if (r.win_flag === true) cur.wins += 1;
      else if (r.win_flag === false) cur.losses += 1;
      cur.eloChange += r.rating_delta ?? 0;

      // KEPT BY played_at RATHER THAN BY ARRIVAL ORDER. Ordering the query
      // itself would not do: played_at lives on the embedded `matches`, and
      // PostgREST's referencedTable ordering sorts WITHIN the embed, not the
      // parent rows. Comparing here needs no ordering guarantee at all.
      if (typeof r.post_rating === 'number') {
        const slot = m.match_type === 'doubles' ? 'doubles' : 'singles';
        const held = cur[slot];
        if (!held || m.played_at > held.at) cur[slot] = { rating: r.post_rating, at: m.played_at };
      }
      byPlayer.set(r.player_id, cur);
    }

    // ASCENDING PLAYER ID — the cursor is a position in this order, so the
    // order has to be total and stable across invocations. It is the id, not
    // the name, because names are neither unique nor immutable.
    const eligible = Array.from(byPlayer.values()).sort((a, b) => (a.playerId < b.playerId ? -1 : 1));
    const pending = progress.after
      ? eligible.filter((a) => a.playerId > progress.after!)
      : eligible;
    const batch = pending.slice(0, MAX_SENDS_PER_RUN);

    let sent = 0;
    let skipped = 0;
    for (const agg of batch) {
      // Sequential on purpose: a burst of parallel sends against the club's
      // sending reputation is exactly the shape that gets throttled.
      const outcome = await sendWeeklyDigestEmail(agg.email, agg.name, {
        matchesPlayed: agg.matchesPlayed,
        wins: agg.wins,
        losses: agg.losses,
        eloChange: agg.eloChange,
        singlesRating: agg.singles?.rating ?? null,
        doublesRating: agg.doubles?.rating ?? null,
      }).catch((err) => {
        // One bad address must not stop the rest of the run.
        Sentry.captureException(err, { extra: { job: 'weekly-digest' } });
        return null;
      });

      if (outcome?.sent) sent += 1;
      else skipped += 1;

      // ADVANCED PER MEMBER, NOT PER BATCH, and advanced for a skip too. The
      // cursor records "this member has been DEALT WITH", not "this member was
      // mailed" — a suppressed or opted-out member who left the cursor behind
      // would be re-evaluated for ever, and a crash halfway through a batch
      // would resend to everyone the batch had already reached.
      progress.after = agg.playerId;
      await writeProgress(admin, progress);
    }

    const remaining = pending.length - batch.length;
    if (remaining === 0) {
      progress.complete = true;
      await writeProgress(admin, progress);
    }

    return NextResponse.json({
      ran_at: now.toISOString(),
      window,
      eligible: eligible.length,
      sent,
      skipped,
      remaining,
      complete: remaining === 0,
    });
  } catch (err) {
    Sentry.captureException(err, { extra: { job: 'weekly-digest' } });
    return NextResponse.json({ error: 'Weekly digest job failed' }, { status: 500 });
  }
}
