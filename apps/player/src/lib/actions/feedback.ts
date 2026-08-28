'use server';

import * as Sentry from '@sentry/nextjs';
import { revalidatePath } from 'next/cache';
import { createServerSupabaseClient, createServiceRoleClient } from '../supabase-server';
import {
  eventFeedbackSchema,
  parseOrThrow,
  hasTournamentEnded,
  ExpectedError,
  type EventFeedbackInput,
} from '@badminton/shared';
import { requirePlayer, runAction, trackServerEvent, type ActionResult } from './_shared';

// Submit (or revise) feedback on a tournament. Stored with the player's id so
// the exec team can moderate and follow up — the UI tells members it's private
// to the exec team, never shown to other players.
//
// IT ALSO LEAVES THE APP. Since 00173 a response with a comment is relayed into
// the execs' Discord channel, named, and an edit here edits that message. The
// form copy says so. THE AUDIENCE IS STILL EXEC-ONLY and has to stay that way:
// the relay's target is event_feedback_channel_id, a setting deliberately kept
// separate from the bug-report channel so nobody widens this one by accident.
// If that key is ever pointed at a members-visible channel, this promise breaks
// and the copy above becomes false.
export async function submitEventFeedback(input: EventFeedbackInput): Promise<ActionResult> {
  return runAction(() => submitEventFeedbackImpl(input));
}

async function submitEventFeedbackImpl(input: EventFeedbackInput) {
  parseOrThrow(eventFeedbackSchema, input);
  const player = await requirePlayer();
  const supabase = createServiceRoleClient();

  // The page hides the form until the event is over; this enforces it. Hiding a
  // control is a UI convenience, not a rule — the action is directly callable,
  // and without this a stale page left open before the event would still post.
  const { data: tournament } = await supabase
    .from('tournaments')
    .select('status, start_date, end_date')
    .eq('id', input.tournament_id)
    .maybeSingle();

  if (!hasTournamentEnded(tournament)) {
    // ExpectedError: a closed feedback window is a normal state, not a fault,
    // so it surfaces as a message instead of being filed in Sentry.
    throw new ExpectedError('Feedback opens once the event has finished.');
  }

  // Since 00175 this is a row in feedback_reports like every other piece of
  // feedback, told apart by kind. The upsert key is the plain unique index on
  // (tournament_id, player_id) — see the migration for why it is not partial.
  const { error } = await supabase.from('feedback_reports').upsert(
    {
      kind: 'tournament_feedback',
      source: 'app',
      tournament_id: input.tournament_id,
      player_id: player.id,
      rating: input.rating ?? null,
      // NULL, not '': the table's check allows a rating with no words, and an
      // empty string would count as words and defeat it.
      body: input.comment?.trim() || null,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'tournament_id,player_id' },
  );
  if (error) {
    Sentry.captureException(error, { extra: { action: 'submitEventFeedback', tournamentId: input.tournament_id } });
    throw new Error(error.message);
  }

  revalidatePath(`/tournaments/${input.tournament_id}`);
}

// ---------------------------------------------------------------------------
// In-app bug reports and general feedback (feedback_reports, source='app').
//
// Same table the Discord /bug and /feedback commands write to, so both arrive in
// one triage queue and the existing relay posts them without knowing where they
// came from. What differs is the screenshot: Discord hands the bot a CDN URL,
// while this path uploads to a private bucket and stores the PATH (00174).
// ---------------------------------------------------------------------------

// Mirrors the CHECK on feedback_reports.kind, minus the values only the Discord
// and tournament-survey paths produce.
const APP_KINDS = ['bug', 'feedback'] as const;
export type AppFeedbackKind = (typeof APP_KINDS)[number];

const MAX_REPORT_TITLE = 120;
const MAX_REPORT_BODY = 4000; // the column's CHECK — caught here so it reads as a message, not a 500

export interface FeedbackReportInput {
  kind: AppFeedbackKind;
  title: string;
  body: string;
  /** Object path in feedback-screenshots, already uploaded by the browser. */
  imagePath?: string | null;
}

export async function submitFeedbackReport(input: FeedbackReportInput): Promise<ActionResult> {
  return runAction(() => submitFeedbackReportImpl(input));
}

async function submitFeedbackReportImpl(input: FeedbackReportInput) {
  const player = await requirePlayer();

  const kind: AppFeedbackKind = APP_KINDS.includes(input.kind) ? input.kind : 'feedback';
  const title = input.title.trim().slice(0, MAX_REPORT_TITLE);
  const body = input.body.trim();

  if (!body) throw new ExpectedError('Please describe what happened');
  if (body.length > MAX_REPORT_BODY) {
    throw new ExpectedError(`Please keep it under ${MAX_REPORT_BODY} characters`);
  }

  // THE PATH IS CLIENT-SUPPLIED, so it is checked rather than trusted. Storage
  // RLS already stopped them WRITING outside their own folder, but nothing
  // stopped them naming someone else's folder in this call — and the relay signs
  // whatever path this row holds using the service role, which bypasses RLS.
  // Without this check that is a read primitive for the entire bucket.
  // auth.uid(), not player.id: that is what the folder is named (00174).
  let imagePath: string | null = null;
  if (input.imagePath) {
    const supabase = await createServerSupabaseClient();
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) throw new ExpectedError('Not authenticated');
    if (!input.imagePath.startsWith(`${user.id}/`)) {
      throw new ExpectedError('That screenshot could not be attached');
    }
    imagePath = input.imagePath;
  }

  // Service role for the insert: 00172 revoked anon/authenticated on this table
  // on purpose and says to reach it through a server action rather than by
  // loosening the grants. player_id comes from the session, never the caller.
  const { error } = await createServiceRoleClient()
    .from('feedback_reports')
    .insert({
      kind,
      title: title || null,
      body,
      image_path: imagePath,
      player_id: player.id,
      source: 'app',
    });

  if (error) throw new Error(`Feedback report insert failed: ${error.message}`);

  trackServerEvent(player.id, 'feedback_report_submitted', {
    kind,
    has_screenshot: Boolean(imagePath),
  });
}
