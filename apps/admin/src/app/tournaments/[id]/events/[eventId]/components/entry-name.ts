import type { TournamentEntry, ParticipantWithPlayer, PairWithPlayers } from '@/lib/tournament-types';

// Display name for a tournament entry — a pair (doubles) or a participant (singles).
export function getName(entry: TournamentEntry, isDoubles: boolean): string {
  if (isDoubles) {
    const pair = entry as PairWithPlayers;
    return pair.pair_name ?? `${pair.player1?.full_name ?? '?'} / ${pair.player2?.full_name ?? '?'}`;
  }
  const participant = entry as ParticipantWithPlayer;
  return participant.player?.full_name ?? 'Unknown';
}
