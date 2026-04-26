import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import { SubmitForm } from './submit-form';
import {
  WrongPlayerError,
  ExpiredError,
  AlreadySubmittedError,
  InvalidTokenError,
  WrongStatusError,
} from './error-screens';
import { AuthRedirect } from './auth-redirect';

export const dynamic = 'force-dynamic';

type Participant = {
  player_id: string;
  team_side: 'a' | 'b';
  player: { id: string; full_name: string; user_id: string | null } | null;
};

type VerifyResponse =
  | {
      ok: true;
      challenge: {
        id: string;
        type: 'singles' | 'doubles';
        format: string;
        expiresAt: string;
        participants: Participant[];
      };
    }
  | { ok: false; code: 'INVALID_TOKEN' | 'EXPIRED' | 'WRONG_STATUS' | 'ALREADY_SUBMITTED'; status?: string; matchId?: string };

async function callVerify(challengeId: string, token: string): Promise<VerifyResponse> {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!supabaseUrl || !anonKey) {
    return { ok: false, code: 'INVALID_TOKEN' };
  }
  try {
    const res = await fetch(`${supabaseUrl}/functions/v1/verify-qr-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${anonKey}`,
      },
      body: JSON.stringify({ challengeId, token }),
      cache: 'no-store',
    });
    return (await res.json()) as VerifyResponse;
  } catch {
    return { ok: false, code: 'INVALID_TOKEN' };
  }
}

export default async function SubmitPage({
  searchParams,
}: {
  searchParams: Promise<{ cid?: string; tok?: string }>;
}) {
  const { cid, tok } = await searchParams;

  if (!cid || !tok) {
    return <InvalidTokenError />;
  }

  const player = await getCurrentPlayer();
  if (!player) {
    return <AuthRedirect cid={cid} tok={tok} />;
  }

  const verify = await callVerify(cid, tok);

  if (!verify.ok) {
    switch (verify.code) {
      case 'EXPIRED':
        return <ExpiredError />;
      case 'ALREADY_SUBMITTED':
        return <AlreadySubmittedError matchId={verify.matchId} challengeId={cid} />;
      case 'WRONG_STATUS':
        return <WrongStatusError status={verify.status} />;
      case 'INVALID_TOKEN':
      default:
        return <InvalidTokenError />;
    }
  }

  // Is the logged-in player one of the participants?
  const participants = verify.challenge.participants || [];
  const me = participants.find((p) => p.player?.id === player.id);

  if (!me) {
    const sideA = participants.filter((p) => p.team_side === 'a').map((p) => p.player?.full_name).filter(Boolean).join(' + ');
    const sideB = participants.filter((p) => p.team_side === 'b').map((p) => p.player?.full_name).filter(Boolean).join(' + ');
    return (
      <WrongPlayerError
        loggedInName={player.full_name}
        sideA={sideA || 'Player 1'}
        sideB={sideB || 'Player 2'}
      />
    );
  }

  const sideA = participants.filter((p) => p.team_side === 'a');
  const sideB = participants.filter((p) => p.team_side === 'b');
  const nameA = sideA.map((p) => p.player?.full_name).filter(Boolean).join(' + ') || 'Team A';
  const nameB = sideB.map((p) => p.player?.full_name).filter(Boolean).join(' + ') || 'Team B';

  return (
    <SubmitForm
      challengeId={cid}
      matchType={verify.challenge.type}
      format={verify.challenge.format}
      nameA={nameA}
      nameB={nameB}
      myTeamSide={me.team_side}
    />
  );
}
