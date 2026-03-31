import { createServerSupabaseClient } from '@/lib/supabase-server';
import { Card, Badge, Avatar } from '@badminton/ui';
import { getWinRate } from '@badminton/shared';
import { VarsityNoteButton } from './notes';
import { GraduationCap, Trophy, Medal, Award, AlertTriangle, Inbox } from 'lucide-react';

const rankIcon = (rank: number) => {
  if (rank === 1) return <Trophy className="w-4 h-4 text-[#FFD700]" />;
  if (rank === 2) return <Medal className="w-4 h-4 text-[#C0C0C0]" />;
  if (rank === 3) return <Award className="w-4 h-4 text-[#CD7F32]" />;
  return null;
};

const rankBg = (rank: number) => {
  if (rank === 1) return 'bg-[#FFD700]/5';
  if (rank === 2) return 'bg-[#C0C0C0]/5';
  if (rank === 3) return 'bg-[#CD7F32]/5';
  return '';
};

export default async function VarsityPage() {
  const supabase = await createServerSupabaseClient();

  const { data: eligible } = await supabase
    .from('players')
    .select('*, ratings(*), reliability_metrics(*)')
    .eq('eligibility_flag', true)
    .eq('active_flag', true)
    .neq('status', 'pending_approval');

  // Fetch all varsity notes
  const playerIds = eligible?.map(p => p.id) || [];
  const { data: allNotes } = await supabase
    .from('varsity_notes')
    .select('*, author:players!varsity_notes_author_id_fkey(full_name)')
    .in('player_id', playerIds.length > 0 ? playerIds : ['00000000-0000-0000-0000-000000000000'])
    .order('created_at', { ascending: false });

  const notesByPlayer = new Map<string, typeof allNotes>();
  allNotes?.forEach(n => {
    const existing = notesByPlayer.get(n.player_id) || [];
    existing.push(n);
    notesByPlayer.set(n.player_id, existing);
  });

  // Sort by a rough varsity index
  const ranked = (eligible || [])
    .map((p) => {
      const r = Array.isArray(p.ratings) ? p.ratings[0] : p.ratings;
      const rel = Array.isArray(p.reliability_metrics) ? p.reliability_metrics[0] : p.reliability_metrics;
      const singlesElo = r?.singles_elo ?? 1200;
      const doublesElo = r?.doubles_elo ?? 1200;
      const index = Math.round(singlesElo * 0.45 + doublesElo * 0.30 + (singlesElo + doublesElo) / 2 * 0.15 + 1200 * 0.10);
      return { ...p, rating: r, reliability: rel, varsityIndex: index };
    })
    .sort((a, b) => b.varsityIndex - a.varsityIndex);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center gap-3">
        <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-[var(--color-accent)]/10">
          <GraduationCap className="w-5 h-5 text-[var(--color-accent)]" />
        </div>
        <div>
          <h1 className="text-3xl font-bold font-display text-[var(--text-primary)]">VARSITY EVALUATION</h1>
          <p className="text-sm text-[var(--text-muted)]">
            Internal only — eligible competitive players ranked by varsity index
            <span className="ml-2 text-xs bg-[var(--border-hover)] text-[var(--text-muted)] px-2 py-0.5 rounded-full">
              {ranked.length} players
            </span>
          </p>
        </div>
      </div>

      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b-2 border-[var(--border)]">
                <th className="px-5 py-4 text-left text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider w-12">#</th>
                <th className="px-5 py-4 text-left text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">Player</th>
                <th className="px-5 py-4 text-right text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">Singles Elo</th>
                <th className="px-5 py-4 text-right text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">Doubles Elo</th>
                <th className="px-5 py-4 text-right text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">S W/L</th>
                <th className="px-5 py-4 text-right text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">D W/L</th>
                <th className="px-5 py-4 text-right text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">Varsity Index</th>
                <th className="px-5 py-4 text-right text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">Reliability</th>
                <th className="px-5 py-4 text-right text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">Notes</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {ranked.map((p, i) => {
                const playerNotes = (notesByPlayer.get(p.id) || []) as { id: string; note: string; created_at: string; author: { full_name: string } | null }[];
                const rank = i + 1;
                return (
                  <tr key={p.id} className={`hover:bg-white/[0.03] transition-colors ${rankBg(rank)}`}>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-1.5">
                        {rankIcon(rank) || <span className="font-mono text-sm text-[var(--text-muted)]">{rank}</span>}
                      </div>
                    </td>
                    <td className="px-5 py-3.5">
                      <div className="flex items-center gap-2.5">
                        <Avatar name={p.full_name} size="sm" />
                        <span className="text-sm font-medium text-[var(--text-primary)]">{p.full_name}</span>
                      </div>
                    </td>
                    <td className="px-5 py-3.5 text-right font-mono text-sm text-[var(--text-primary)]">{p.rating?.singles_elo ?? '-'}</td>
                    <td className="px-5 py-3.5 text-right font-mono text-sm text-[var(--text-primary)]">{p.rating?.doubles_elo ?? '-'}</td>
                    <td className="px-5 py-3.5 text-right text-sm text-[var(--text-secondary)]">
                      {p.rating ? `${p.rating.singles_wins}-${p.rating.singles_losses} (${getWinRate(p.rating.singles_wins, p.rating.singles_losses)})` : '-'}
                    </td>
                    <td className="px-5 py-3.5 text-right text-sm text-[var(--text-secondary)]">
                      {p.rating ? `${p.rating.doubles_wins}-${p.rating.doubles_losses} (${getWinRate(p.rating.doubles_wins, p.rating.doubles_losses)})` : '-'}
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <span className="font-mono text-lg font-bold text-[var(--color-accent)]">{p.varsityIndex}</span>
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      {p.reliability?.walkover_flag ? (
                        <Badge variant="danger">
                          <AlertTriangle className="w-3 h-3 inline mr-1" />
                          Flagged
                        </Badge>
                      ) : (
                        <Badge variant="success">Good</Badge>
                      )}
                    </td>
                    <td className="px-5 py-3.5 text-right">
                      <VarsityNoteButton
                        playerId={p.id}
                        playerName={p.full_name}
                        notes={playerNotes}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {ranked.length === 0 && (
          <div className="flex flex-col items-center py-12 gap-3">
            <div className="w-14 h-14 rounded-full bg-[var(--border-hover)] flex items-center justify-center">
              <Inbox className="w-7 h-7 text-[var(--text-muted)]" />
            </div>
            <p className="text-[var(--text-muted)]">No eligible players found</p>
          </div>
        )}
      </div>
    </div>
  );
}
