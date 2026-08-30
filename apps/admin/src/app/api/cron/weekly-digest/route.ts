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

// THE CURSOR IS NO LONGER THE THING THAT STOPS A DOUBLE SEND (F-019).
//
// A cursor is a read-modify-write. Two invocations that overlap both read the
// same `after`, both take the same first MAX_SENDS_PER_RUN members in id order,
// and both mail them — and the Monday schedule fires every five minutes for two
// hours precisely so that a long run can resume, which is the same thing as
// saying overlapping invocations are the expected shape rather than an
// accident. pg_net's own timeout-and-retry reaches it without anything on the
// app side going wrong.
//
// digest_deliveries (00194) is the per-recipient, per-window idempotency key.
// Every send is preceded by an insert of (week_start, player_id) with
// ON CONFLICT DO NOTHING; the row that comes back is the claim, and no row back
// means another invocation already owns this member. The cursor stays, because
// it is a cheap resume position and the honest "this week is finished" flag —
// but it is not what stands between a member and a second copy of their week.
const DIGEST_DELIVERIES = 'digest_deliveries';

// How stale an unfinished claim must be before the run reports it. Anything
// this run itself claimed is completed within the same iteration, so a claim
// older than this belongs to an invocation that died between claiming and
// recording — the one case this design trades a possible missed digest for.
const STRANDED_CLAIM_MS = 10 * 60_000;

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
  const { data, error } = await admin.from('cron_config').select('value').eq('key', PROGRESS_KEY).maybeSingle();
  const fresh: DigestProgress = { window, after: null, complete: false };
  // FAIL CLOSED. A failed read is indistinguishable from "no cursor yet"
  // unless the error is inspected, and "no cursor yet" means start at the
  // beginning — so a transient read failure part-way through a week's send
  // re-mails everyone the previous batches already reached. writeProgress
  // below already refuses to swallow its own error for exactly this reason;
  // the read has the same consequence and has to be treated the same way.
  if (error) {
    throw new Error(`Could not read digest progress: ${error.message}`);
  }
  if (!data?.value) return fresh;
  try {
    const parsed = JSON.parse(data.value as string) as Partial<DigestProgress>;
    // A cursor from an earlier week says nothing about this one. Starting over
    // is correct here and not a re-send: it is a different week's mail.
    if (parsed.window !== window) return fresh;
    return { window, after: parsed.after ?? null, complete: parsed.complete === true };
  } catch {
    // AN INCIDENT, NOT A RESTART. This used to fall through to a fresh cursor,
    // reasoning that one week of duplicates beats a wedged job. That trade is
    // the wrong way round for a mass mailing: duplicates go to the whole club,
    // are unrecallable, and drive unsubscribes and spam complaints that cost
    // the sending domain's reputation — while a skipped digest costs one week
    // of a weekly summary and is visible in the same alert this raises.
    //
    // Clearing it deliberately is one statement, and doing it deliberately is
    // the point: DELETE FROM cron_config WHERE key = '<PROGRESS_KEY>';
    Sentry.captureMessage('weekly-digest: unreadable progress cursor — refusing to run', 'error');
    throw new Error(
      `Digest progress cursor is unreadable. Refusing to run rather than re-mailing the club. ` +
      `Inspect cron_config key '${PROGRESS_KEY}' and clear it deliberately to restart the week.`,
    );
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

    // Everyone this window has already been DECIDED ABOUT — mailed, suppressed,
    // opted out, failed, or claimed by an invocation still running. Read once;
    // the claim below is what actually excludes, this only avoids walking over
    // members another run has plainly finished.
    const { data: settled, error: settledErr } = await admin
      .from(DIGEST_DELIVERIES)
      .select('player_id, claimed_at, completed_at')
      .eq('week_start', window);
    // Fail closed, for the same reason readProgress does: a failed read here is
    // indistinguishable from "nobody has been mailed yet", and acting on that
    // is the duplicate mailing this table exists to prevent.
    if (settledErr) throw new Error(`Could not read digest deliveries: ${settledErr.message}`);
    const already = new Set((settled ?? []).map((r) => r.player_id as string));

    // Claims nobody closed. NOT retried — see the completion comment below and
    // 00194. Reported, because a claim with no outcome is the one member this
    // design may silently not mail, and the alert is what makes that a decision
    // somebody can act on rather than a hole.
    //
    // BEFORE the already-complete gate, not after. A crash in the run that
    // finishes the week strands its own claims and then nothing else runs, so
    // reporting after the gate would be the one case that never reports.
    const stranded = (settled ?? []).filter(
      (r) => !r.completed_at && Date.parse(r.claimed_at as string) < now.getTime() - STRANDED_CLAIM_MS,
    );
    if (stranded.length > 0) {
      Sentry.captureMessage(
        `weekly-digest: ${stranded.length} delivery claim(s) for ${window} were never completed — those members may not have been mailed`,
        'warning',
      );
    }

    if (progress.complete) {
      return NextResponse.json({
        ran_at: now.toISOString(), window, already_complete: true,
        stranded_claims: stranded.length,
      });
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

    const pending = eligible.filter(
      (a) => !already.has(a.playerId) && (!progress.after || a.playerId > progress.after),
    );
    const batch = pending.slice(0, MAX_SENDS_PER_RUN);

    let sent = 0;
    let skipped = 0;
    let claimedElsewhere = 0;
    for (const agg of batch) {
      // THE CLAIM, one member at a time and immediately before the send.
      // ignoreDuplicates is PostgREST's ON CONFLICT DO NOTHING, and `.select()`
      // returns only rows this statement actually inserted — so an empty result
      // is another invocation holding this member, and the only correct thing
      // to do with it is nothing. Per member rather than per batch so a crash
      // strands one recipient instead of forty.
      const { data: claim, error: claimErr } = await admin
        .from(DIGEST_DELIVERIES)
        .upsert(
          { week_start: window, player_id: agg.playerId, claimed_at: new Date().toISOString() },
          { onConflict: 'week_start,player_id', ignoreDuplicates: true },
        )
        .select('player_id');
      // A claim that cannot be written is not a licence to send unclaimed.
      if (claimErr) throw new Error(`Could not claim digest delivery: ${claimErr.message}`);
      if (!claim || claim.length === 0) {
        claimedElsewhere += 1;
        progress.after = agg.playerId;
        await writeProgress(admin, progress);
        continue;
      }

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

      // Close the claim with what actually happened, including the provider's
      // own id for the sends — the only durable link from "I never got it" to
      // the provider log.
      //
      // A THROW IS RECORDED AS `failed` AND CLOSED, NOT LEFT RETRYABLE. We
      // cannot tell a throw before the provider was called from one after it
      // accepted the message, and for a club-wide mailing those two are not
      // symmetric: a duplicate is unrecallable and costs the sending domain's
      // reputation, a miss costs one member one week of a summary that is in
      // the app anyway. The session-reminder job decides the identical question
      // the other way round, deliberately — see 00194.
      const completion = outcome === null
        ? { outcome: 'failed' as const, provider_message_id: null }
        : outcome.sent
          ? { outcome: 'sent' as const, provider_message_id: outcome.providerMessageId }
          : { outcome: outcome.reason, provider_message_id: null };
      const { error: closeErr, count: closedCount } = await admin
        .from(DIGEST_DELIVERIES)
        .update({ completed_at: new Date().toISOString(), ...completion }, { count: 'exact' })
        .eq('week_start', window)
        .eq('player_id', agg.playerId);
      // A zero-row close is reported, not shrugged off. It used to be neither
      // requested nor checked, under a comment claiming "the claim still holds,
      // so the member cannot be mailed twice" -- which is only true while the
      // claim row still exists under THIS player_id. A merge running
      // concurrently invalidates both halves: it repoints the row to the
      // survivor (so this filter misses it) or, before 00205 took a row lock,
      // let the cascade delete it outright (so there is no claim at all and
      // the survivor can be mailed the same digest again). PostgREST reports
      // an update that matched nothing as success, so without count:'exact'
      // this is indistinguishable from a normal close.
      if (!closeErr && closedCount === 0) {
        Sentry.captureException(
          new Error(
            `Digest delivery close matched no row for ${agg.playerId} in week ${window}: ` +
              'the claim was repointed or removed by a concurrent merge',
          ),
        );
      }
      if (closeErr) {
        Sentry.captureException(
          new Error(`Digest delivery record not closed for ${agg.playerId}: ${closeErr.message}`),
          { extra: { job: 'weekly-digest', window, outcome: completion.outcome } },
        );
      }

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
      claimed_elsewhere: claimedElsewhere,
      stranded_claims: stranded.length,
      remaining,
      complete: remaining === 0,
    });
  } catch (err) {
    Sentry.captureException(err, { extra: { job: 'weekly-digest' } });
    return NextResponse.json({ error: 'Weekly digest job failed' }, { status: 500 });
  }
}
