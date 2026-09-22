import * as Sentry from '@sentry/nextjs';
import { clubToday } from '@badminton/shared';
import { getCurrentPlayer, createServiceRoleClient } from '@/lib/supabase-server';
import { logMemberAudit } from '@/lib/member-audit';
import { assembleMemberExport } from '@/lib/data-export/assemble';

// A CACHED EXPORT IS A CROSS-MEMBER DATA LEAK, not a performance bug, and no
// default anywhere in this stack is safe for it. `force-dynamic` plus the
// no-store header below are belt and braces on purpose: one of them answers
// Next's route cache and the other answers Cloudflare, and neither can answer
// for the other. (Next 15 no longer caches GET handlers by default, unlike the
// 14 this app started on -- which is exactly why the declaration stays: a
// default that has changed once can change again, and the cost of being wrong
// here is one member downloading another member's file.)
export const dynamic = 'force-dynamic';

// THE MEMBER DATA EXPORT (FIPPA ACCESS REQUEST).
//
// THIS ROUTE AUTHENTICATES AND DELIBERATELY DOES NOT CALL requirePlayer().
//
// requirePlayer() (lib/actions/_shared.ts) throws for pending_approval, for
// suspended, for is_banned and for a deactivated account with a deletion
// pending -- which is to say it refuses EXACTLY THE POPULATION THAT FILES
// ACCESS REQUESTS. A banned member who wants to read the ban_reason the club
// wrote about them is the archetypal applicant, and a member who has asked to
// be deleted has the most reason of anybody to want a copy first.
//
// The precedent for the distinction is the calendar feed's own header: STANDING
// WITHHOLDS THE CONTROLS, NOT THE INFORMATION. Standing decides whether you can
// enter a challenge or check into a session. It does not decide whether you may
// read what is recorded about you, and a right of access that lapses the moment
// the club sanctions you is not a right of access.
//
// So the gate is exactly two things: a verified session, and a players row.
// getCurrentPlayer() reads that row through the service-role client filtered on
// the user id the session resolved to, so it can only ever return the caller's
// own row.
//
// THE SERVICE-ROLE CLIENT IS THE MECHANISM, and see assemble.ts for why an
// RLS-scoped export is incomplete by construction and silently so.
//
// ASSEMBLED FULLY IN MEMORY, THEN ONE RESPONSE. Not streamed: Cloudflare's
// origin timeout surfaces as a 524, and a half-written JSON body is the
// partial-export failure mode wearing a different hat. One member's data is
// kilobytes to low megabytes.
//
// ON DEMAND, NOT QUEUED. A generated file sitting in a bucket is one member's
// personal information with its own retention, access-control and deletion
// problem. Generate, serve, retain nothing.
export async function GET() {
  const player = await getCurrentPlayer();
  if (!player) {
    return new Response(JSON.stringify({ error: 'Not authenticated' }), {
      status: 401,
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
    });
  }

  const result = await assembleMemberExport(createServiceRoleClient(), player.id as string);

  if (!result.ok) {
    // NO BODY ON FAILURE, AND NO PARTIAL FILE. A read that failed means one
    // table is missing, and a file missing a table is worse than no file: it
    // looks like a complete answer. 503 rather than 500 because the honest
    // advice is to try again.
    Sentry.captureException(
      new Error(`Member data export failed: ${result.failures.join('; ')}`),
      { extra: { playerId: player.id, failures: result.failures } },
    );
    return new Response(
      JSON.stringify({
        error:
          'Your data export could not be completed. Nothing partial has been sent, because an ' +
          'incomplete file would look like a complete answer. Please try again, and contact an ' +
          'executive if it keeps failing.',
      }),
      {
        status: 503,
        headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      },
    );
  }

  // THE RECEIPT, filed after a successful assembly and before the response.
  // logMemberAudit reports its own failures to Sentry and never throws, which
  // is the right trade here: a lost receipt must not cost the member their
  // file. There is no reason prompt for the same reason the module's header
  // gives -- a member exercising a right of access is not filing a
  // justification -- so the reason is a fixed sentence naming the act.
  await logMemberAudit({
    playerId: player.id as string,
    actionType: 'data_export_downloaded',
    reason: 'Member downloaded a copy of their own data from Settings.',
    newValue: {
      tables_considered: result.document.manifest.tables_considered,
      assembly_started_at: result.document.manifest.assembly_started_at,
      assembly_completed_at: result.document.manifest.assembly_completed_at,
    },
  });

  return new Response(JSON.stringify(result.document, null, 2), {
    status: 200,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Disposition': `attachment; filename="sfu-badminton-my-data-${clubToday()}.json"`,
      'Cache-Control': 'no-store, private, max-age=0, must-revalidate',
      'X-Robots-Tag': 'noindex',
    },
  });
}
