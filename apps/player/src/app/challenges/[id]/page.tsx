import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import { Avatar } from '@badminton/ui';
import { MATCH_FORMAT_LABELS, formatRelativeTime } from '@badminton/shared';
import { notFound, redirect } from 'next/navigation';
import { ChallengeDetailActions } from './actions';
import {
  Swords,
  ArrowLeft,
  Clock,
  Zap,
  Users,
  Trophy,
  MessageSquare,
} from 'lucide-react';
import Link from 'next/link';
import { FadeIn } from '@/components/motion-wrapper';

const STATUS_CHIP: Record<string, string> = {
  proposed:            'chip chip-gold',
  partially_confirmed: 'chip chip-gold',
  accepted:            'chip',
  completed:           'chip chip-success',
  disputed:            'chip chip-red',
  cancelled:           'chip',
  expired:             'chip',
  walkover_pending:    'chip chip-gold',
  walkover_confirmed:  'chip',
};

export default async function ChallengeDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const player = await getCurrentPlayer();
  if (!player) redirect('/login');

  const supabase = await createServerSupabaseClient();

  const [{ data: challenge }, { data: match }] = await Promise.all([
    supabase
      .from('challenges')
      .select('*, creator:players!challenges_created_by_fkey(full_name), challenge_participants(*, player:players(full_name, ratings(*)))')
      .eq('id', id)
      .single(),
    supabase
      .from('matches')
      .select('*, match_participants(*, player:players(full_name)), match_games(*)')
      .eq('challenge_id', id)
      .maybeSingle(),
  ]);

  if (!challenge) notFound();

  const myParticipant = challenge.challenge_participants?.find(
    (cp: Record<string, unknown>) => cp.player_id === player.id
  );

  const sideA = challenge.challenge_participants?.filter((cp: Record<string, unknown>) => cp.team_side === 'a') || [];
  const sideB = challenge.challenge_participants?.filter((cp: Record<string, unknown>) => cp.team_side === 'b') || [];

  return (
    <div className="max-w-2xl mx-auto space-y-5 pb-28 px-4 sm:px-0">
      {/* Back nav */}
      <Link
        href="/challenges"
        className="inline-flex items-center gap-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors duration-150 group min-h-[44px] py-2"
      >
        <ArrowLeft className="w-4 h-4 transition-transform duration-150 group-hover:-translate-x-0.5" />
        Back to Challenges
      </Link>

      <FadeIn>
        <div className="card-elevated bg-court-grid bg-noise overflow-hidden">
          {/* Header band */}
          <div className="px-5 pt-5 pb-4 flex items-center justify-between gap-3 border-b border-[var(--border)]">
            <div className="flex items-center gap-3 min-w-0">
              <div className="w-10 h-10 bg-[var(--ds-accent)]/10 flex items-center justify-center shrink-0 glow-red">
                <Swords className="w-5 h-5 text-[var(--ds-accent)]" />
              </div>
              <h1 className="display-md truncate">Challenge Detail</h1>
            </div>
            <span className={`${STATUS_CHIP[challenge.status] ?? 'chip'} shrink-0 capitalize`}>
              {challenge.status.replace(/_/g, ' ')}
            </span>
          </div>

          <div className="p-5 space-y-5">
            {/* Meta Grid */}
            <div className="grid grid-cols-2 gap-3 reveal reveal-1">
              {[
                { icon: Swords, label: 'Type',    value: challenge.type,                                                                              chipClass: 'text-[var(--ds-accent)]' },
                { icon: Trophy, label: 'Format',  value: MATCH_FORMAT_LABELS[challenge.format as keyof typeof MATCH_FORMAT_LABELS],                   chipClass: 'text-[var(--color-gold)]' },
                { icon: Zap,    label: 'Rated',   value: challenge.rated_flag ? 'Rated' : 'Casual',                                                   chipClass: challenge.rated_flag ? 'text-[var(--color-gold)]' : 'text-[var(--text-muted)]' },
                { icon: Clock,  label: 'Created', value: formatRelativeTime(challenge.created_at),                                                    chipClass: 'text-[var(--text-secondary)]' },
              ].map((item) => (
                <div key={item.label} className="card-surface p-3.5">
                  <div className="flex items-center gap-1.5 mb-1.5">
                    <item.icon className={`w-3.5 h-3.5 shrink-0 ${item.chipClass}`} />
                    <span className="eyebrow">{item.label}</span>
                  </div>
                  <p className={`text-sm font-semibold capitalize ${item.chipClass}`}>{item.value}</p>
                </div>
              ))}
            </div>

            {/* Note */}
            {challenge.note && (
              <div className="card-surface p-4 flex items-start gap-2.5 reveal reveal-2">
                <MessageSquare className="w-4 h-4 text-[var(--text-muted)] mt-0.5 shrink-0" />
                <p className="text-sm text-[var(--text-secondary)] leading-relaxed">{challenge.note}</p>
              </div>
            )}

            {/* Teams */}
            <div className="grid grid-cols-1 xs:grid-cols-2 gap-3 reveal reveal-3">
              {[
                { label: 'Team A', players: sideA, accentClass: 'text-[var(--ds-accent)]', borderClass: 'border-[var(--ds-accent)]/20' },
                { label: 'Team B', players: sideB, accentClass: 'text-[var(--color-gold)]',   borderClass: 'border-[var(--color-gold)]/20' },
              ].map((team) => (
                <div key={team.label} className={`card-surface p-4 border ${team.borderClass}`}>
                  <p className={`eyebrow mb-3 ${team.accentClass}`}>{team.label}</p>
                  <div className="space-y-2.5">
                    {team.players.map((cp: Record<string, unknown>) => {
                      const p = cp.player as Record<string, unknown>;
                      const confirmClass: Record<string, string> = {
                        accepted: 'chip chip-success',
                        rejected: 'chip chip-red',
                        pending:  'chip chip-gold',
                      };
                      return (
                        <div key={cp.id as string} className="flex items-center gap-2 min-w-0">
                          <Avatar name={p?.full_name as string || ''} size="sm" />
                          <span className="text-sm text-[var(--text-primary)] truncate flex-1">{p?.full_name as string}</span>
                          <span className={`${confirmClass[cp.confirmation_status as string] ?? 'chip'} shrink-0`}>
                            {cp.confirmation_status as string}
                          </span>
                        </div>
                      );
                    })}
                    {team.players.length === 0 && (
                      <p className="text-xs text-[var(--text-muted)] italic">No players yet</p>
                    )}
                  </div>
                </div>
              ))}
            </div>

            {/* Match Result */}
            {match && (
              <div className="card-surface p-4 reveal reveal-4">
                <div className="flex items-center gap-2 mb-3">
                  <Trophy className="w-4 h-4 text-[var(--color-gold)]" />
                  <span className="eyebrow text-[var(--color-gold)]">Match Result</span>
                </div>
                <p className="nums text-3xl font-black gradient-text-gold mb-2 leading-none">
                  {match.score_summary || 'Pending'}
                </p>
                <span className={`chip ${
                  match.result_status === 'confirmed' ? 'chip-success' :
                  match.result_status === 'disputed'  ? 'chip-red' : 'chip-gold'
                } mb-3`}>
                  {match.result_status}
                </span>
                {match.match_games?.map((g: Record<string, unknown>) => (
                  <p key={g.id as string} className="nums text-sm text-[var(--text-muted)] mt-1">
                    Game {g.game_number as number}: {g.side_a_score as number}–{g.side_b_score as number}
                  </p>
                ))}
                <div className="mt-3 pt-3 border-t border-[var(--border)] space-y-1.5">
                  {match.match_participants?.map((mp: Record<string, unknown>) => (
                    <div key={mp.id as string} className="flex items-center justify-between gap-2">
                      <span className="text-sm text-[var(--text-secondary)] truncate">{(mp.player as Record<string, unknown>)?.full_name as string}</span>
                      <span className={`nums text-sm font-bold shrink-0 ${(mp.rating_delta as number ?? 0) >= 0 ? 'text-[var(--color-success)]' : 'text-[var(--ds-accent)]'}`}>
                        {mp.rating_delta !== null ? `${(mp.rating_delta as number) >= 0 ? '+' : ''}${mp.rating_delta}` : 'pending'}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </FadeIn>

      {/* Actions */}
      <ChallengeDetailActions
        challengeId={id}
        challengeStatus={challenge.status}
        matchId={match?.id}
        matchStatus={match?.result_status}
        myParticipantStatus={myParticipant?.confirmation_status}
        isCreator={challenge.created_by === player.id}
        format={challenge.format}
        participants={challenge.challenge_participants}
        playerId={player.id}
      />
    </div>
  );
}
