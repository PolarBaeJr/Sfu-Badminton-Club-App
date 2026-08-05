'use server';

import { randomBytes } from 'crypto';
import { z } from 'zod';
import { parseOrThrow } from '@badminton/shared';
import { createAdminClient } from '../supabase-server';
import { logAdminAudit } from '../audit';
import { getExecOrAdmin } from './_shared';
import { runAction, type ActionResult } from '../action-result';

// tournament_checkin_tokens has RLS enabled with no policies (00045), so every
// read and write goes through the service-role admin client. Mirrors the
// session token actions in sessions.ts — same shape, same 48-hex token, so the
// player app's CHECKIN_TOKEN_REGEX validates both.
function newCheckinToken(): string {
  return randomBytes(24).toString('hex');
}

export async function getOrCreateTournamentCheckinToken(
  tournamentId: string,
): Promise<ActionResult<string>> {
  return runAction(async () => {
    parseOrThrow(z.string().uuid(), tournamentId);
    await getExecOrAdmin();
    const adminClient = createAdminClient();

    const { data: existing } = await adminClient
      .from('tournament_checkin_tokens')
      .select('token')
      .eq('tournament_id', tournamentId)
      .maybeSingle();
    if (existing) return existing.token as string;

    const token = newCheckinToken();
    const { error } = await adminClient
      .from('tournament_checkin_tokens')
      .insert({ tournament_id: tournamentId, token });
    if (error) {
      // Unique-violation race: a concurrent request created the row first.
      // Return its token rather than failing — two execs opening the QR dialog
      // at once is entirely normal.
      const { data: raced } = await adminClient
        .from('tournament_checkin_tokens')
        .select('token')
        .eq('tournament_id', tournamentId)
        .maybeSingle();
      if (raced) return raced.token as string;
      throw new Error(error.message);
    }
    return token;
  });
}

export async function rotateTournamentCheckinToken(
  tournamentId: string,
): Promise<ActionResult<string>> {
  return runAction(async () => {
    parseOrThrow(z.string().uuid(), tournamentId);
    const admin = await getExecOrAdmin();
    const adminClient = createAdminClient();

    const token = newCheckinToken();
    const { error } = await adminClient
      .from('tournament_checkin_tokens')
      .upsert(
        { tournament_id: tournamentId, token, rotated_at: new Date().toISOString() },
        { onConflict: 'tournament_id' },
      );
    if (error) throw new Error(error.message);

    // The token is deliberately NOT written to the audit row — it is a
    // credential, and audit_logs is readable by every admin.
    await logAdminAudit(adminClient, {
      actor_id: admin.id,
      action_type: 'tournament_checkin_token_rotated',
      target_type: 'tournament',
      target_id: tournamentId,
    });

    return token;
  });
}
