'use server';

import * as Sentry from '@sentry/nextjs';
import { createAdminClient, getAuthenticatedAdmin } from '../supabase-server';
import { revalidatePath } from 'next/cache';
import { toClientError } from '@badminton/shared';
import { generateQrToken } from '@badminton/shared/qr-token';
import { QR_EXPIRES_IN_DAYS, type GeneratedQr } from './challenge-types';

export async function adminCreateChallenge(data: {
  type: string;
  format: string;
  rated_flag: boolean;
  side_a_players: string[];
  side_b_players: string[];
  scheduled_date?: string;
  scheduled_time?: string;
  note?: string;
}) {
  const admin = await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

  const eventType = data.rated_flag ? 'rated_challenge' : 'casual';

  const { data: challenge, error } = await adminClient.from('challenges').insert({
    type: data.type,
    rated_flag: data.rated_flag,
    format: data.format,
    event_type: eventType,
    scheduled_date: data.scheduled_date || null,
    scheduled_time: data.scheduled_time || null,
    created_by: admin.id,
    status: 'accepted',
    note: data.note || `Created by admin`,
  }).select().single();

  if (error) throw toClientError(error, 'admin.action');

  const participants: { challenge_id: string; player_id: string; role: string; team_side: string; confirmation_status: string }[] = [];

  data.side_a_players.forEach((pid, i) => {
    participants.push({
      challenge_id: challenge.id,
      player_id: pid,
      role: i === 0 ? 'challenger' : 'partner',
      team_side: 'a',
      confirmation_status: 'accepted',
    });
  });

  data.side_b_players.forEach((pid, i) => {
    participants.push({
      challenge_id: challenge.id,
      player_id: pid,
      role: i === 0 ? 'opponent' : 'opponent_partner',
      team_side: 'b',
      confirmation_status: 'accepted',
    });
  });

  const { error: partError } = await adminClient.from('challenge_participants').insert(participants);
  if (partError) throw new Error(partError.message);

  const { error: auditError } = await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'challenge_admin_created',
    target_type: 'challenge',
    target_id: challenge.id,
    new_value: data,
  });
  if (auditError) {
    Sentry.captureException(new Error(`Audit log write failed: ${auditError.message}`), {
      extra: { action: 'challenge_admin_created', challengeId: challenge.id },
    });
  }

  revalidatePath('/challenges');
  return challenge.id;
}

export async function generateQrForChallenge(challengeId: string): Promise<GeneratedQr> {
  const admin = await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

  const { data: challenge, error: fetchErr } = await adminClient
    .from('challenges')
    .select('id, status, type, format, challenge_participants(team_side, player:players(full_name))')
    .eq('id', challengeId)
    .single();

  if (fetchErr || !challenge) throw new Error('Challenge not found');
  if (challenge.status !== 'accepted') {
    throw new Error('QR codes can only be generated for accepted challenges');
  }

  const { data: existingMatch } = await adminClient
    .from('matches')
    .select('id')
    .eq('challenge_id', challengeId)
    .maybeSingle();
  if (existingMatch) {
    throw new Error('This challenge already has a submitted result');
  }

  const token = generateQrToken(challengeId, QR_EXPIRES_IN_DAYS);
  const expiresAt = new Date(Date.now() + QR_EXPIRES_IN_DAYS * 86400 * 1000).toISOString();

  const { error: updateErr } = await adminClient
    .from('challenges')
    .update({
      qr_token: token,
      qr_generated_at: new Date().toISOString(),
      qr_expires_at: expiresAt,
    })
    .eq('id', challengeId);
  if (updateErr) throw toClientError(updateErr, 'admin.qr.generate');

  await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'challenge_qr_generated',
    target_type: 'challenge',
    target_id: challengeId,
    new_value: { expires_at: expiresAt },
  });

  const playerUrl = process.env.NEXT_PUBLIC_PLAYER_URL || 'http://localhost:3000';
  const url = `${playerUrl}/submit?cid=${encodeURIComponent(challengeId)}&tok=${encodeURIComponent(token)}`;

  const players = ((challenge.challenge_participants as unknown as Array<{
    team_side: 'a' | 'b';
    player: { full_name: string } | null;
  }>) || []).map((p) => ({
    team_side: p.team_side,
    full_name: p.player?.full_name ?? 'Unknown',
  }));

  revalidatePath('/challenges');

  return {
    url,
    token,
    expiresAt,
    players,
    format: challenge.format,
    matchType: challenge.type,
  };
}

export async function getExistingQrForChallenge(challengeId: string): Promise<GeneratedQr | null> {
  await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

  const { data: challenge } = await adminClient
    .from('challenges')
    .select('id, status, type, format, qr_token, qr_expires_at, challenge_participants(team_side, player:players(full_name))')
    .eq('id', challengeId)
    .single();

  if (!challenge || !challenge.qr_token || !challenge.qr_expires_at) return null;

  const playerUrl = process.env.NEXT_PUBLIC_PLAYER_URL || 'http://localhost:3000';
  const url = `${playerUrl}/submit?cid=${encodeURIComponent(challengeId)}&tok=${encodeURIComponent(challenge.qr_token)}`;

  const players = ((challenge.challenge_participants as unknown as Array<{
    team_side: 'a' | 'b';
    player: { full_name: string } | null;
  }>) || []).map((p) => ({
    team_side: p.team_side,
    full_name: p.player?.full_name ?? 'Unknown',
  }));

  return {
    url,
    token: challenge.qr_token,
    expiresAt: challenge.qr_expires_at,
    players,
    format: challenge.format,
    matchType: challenge.type,
  };
}

export async function forceExpireChallenge(challengeId: string, reason: string) {
  const admin = await getAuthenticatedAdmin();
  const adminClient = createAdminClient();

  const { error } = await adminClient
    .from('challenges')
    .update({ status: 'expired' })
    .eq('id', challengeId);

  if (error) throw toClientError(error, 'admin.action');

  const { error: auditError } = await adminClient.from('audit_logs').insert({
    actor_id: admin.id,
    action_type: 'challenge_force_expired',
    target_type: 'challenge',
    target_id: challengeId,
    reason,
  });
  if (auditError) {
    Sentry.captureException(new Error(`Audit log write failed: ${auditError.message}`), {
      extra: { action: 'challenge_force_expired', challengeId },
    });
  }

  revalidatePath('/challenges');
}
