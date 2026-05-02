export const dynamic = 'force-dynamic';
import { createAdminClient } from '@/lib/supabase-server';
import { Badge, Card, Avatar, PageHero } from '@badminton/ui';
import { PLAYER_STATUS_LABELS } from '@badminton/shared';
import Link from 'next/link';
import { PlayerActions } from './player-actions';
import { AddPlayerButton } from './add-player-button';

const statusBadgeVariant = (status: string) => {
  switch (status) {
    case 'competitive': return 'success' as const;
    case 'recreational': return 'default' as const;
    case 'suspended': return 'danger' as const;
    case 'pending_approval': return 'warning' as const;
    default: return 'neutral' as const;
  }
};

const attentionDot = (status: string) => {
  if (status === 'suspended') return 'bg-[var(--color-danger)]';
  if (status === 'pending_approval') return 'bg-[var(--color-warning)]';
  return '';
};

export default async function PlayersPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; search?: string }>;
}) {
  const params = await searchParams;
  const tab = params.tab || 'competitive';
  const supabase = createAdminClient();

  let query = supabase
    .from('players')
    .select('id, full_name, email, avatar_url, status, role, active_flag, created_at, ratings(*)')
    .order('created_at', { ascending: false })
    .limit(200);

  if (tab === 'competitive') {
    // Show all active players (not recreational, suspended, or pending)
    query = query.not('status', 'in', '("recreational","suspended","pending_approval")');
  } else if (tab === 'recreational') {
    query = query.eq('status', 'recreational');
  } else if (tab === 'attention') {
    query = query.in('status', ['suspended', 'pending_approval']);
  }

  if (params.search) {
    query = query.ilike('full_name', `%${params.search}%`);
  }

  // Run main list + the 3 tab counts in parallel. Was 4 sequential round-trips.
  const [
    { data: players },
    { count: compCount },
    { count: recCount },
    { count: attCount },
  ] = await Promise.all([
    query,
    supabase.from('players').select('*', { count: 'exact', head: true }).not('status', 'in', '("recreational","suspended","pending_approval")'),
    supabase.from('players').select('*', { count: 'exact', head: true }).eq('status', 'recreational'),
    supabase.from('players').select('*', { count: 'exact', head: true }).in('status', ['suspended', 'pending_approval']),
  ]);

  const tabs = [
    { id: 'competitive', label: 'Competitive', count: compCount ?? 0 },
    { id: 'recreational', label: 'Recreational', count: recCount ?? 0 },
    { id: 'attention', label: 'Needs Attention', count: attCount ?? 0 },
  ];

  return (
    <div>
      <PageHero
        eyebrow={`Roster · ${(compCount ?? 0) + (recCount ?? 0)} players`}
        title="Players."
        subtitle="Approve new sign-ups, manage roles, and review the full club roster."
        watermark="P"
      />
      <div className="space-y-6 px-12 py-8">
        <div className="flex items-center justify-end">
          <AddPlayerButton />
        </div>

      {/* Tabs */}
      <Card padding={false}>
        <div className="flex gap-1 p-1">
          {tabs.map((t) => (
            <Link
              key={t.id}
              href={`/players?tab=${t.id}`}
              className={`px-4 min-h-[44px] text-sm transition-colors flex items-center gap-2 ${
                tab === t.id
                  ? 'bg-[var(--ds-accent)] text-white'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--border-hover)]'
              }`}
            >
              {t.label}
              <span className={`text-xs px-1.5 py-0.5 rounded-full ${
                tab === t.id ? 'bg-white/20' : 'bg-[var(--border-hover)]'
              }`}>{t.count}</span>
            </Link>
          ))}
        </div>
      </Card>

      {/* Player Table */}
      <Card padding={false}>
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-[var(--border)]">
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Player</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Status</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-[var(--text-muted)] uppercase">Singles Elo</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-[var(--text-muted)] uppercase">Doubles Elo</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-[var(--text-muted)] uppercase">S W/L</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-[var(--text-muted)] uppercase">D W/L</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-[var(--text-muted)] uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {players?.map((player) => {
                const r = Array.isArray(player.ratings) ? player.ratings[0] : player.ratings;
                const dotClass = attentionDot(player.status);
                return (
                  <tr key={player.id} className="hover:bg-[var(--border-hover)] transition-colors">
                    <td className="px-4 py-3">
                      <Link href={`/players/${player.id}`} className="flex items-center gap-3 hover:text-[var(--ds-accent)]">
                        <div className="relative">
                          <Avatar name={player.full_name} src={player.avatar_url} size="sm" />
                          {dotClass && (
                            <span className={`absolute -top-0.5 -right-0.5 w-2.5 h-2.5 rounded-full ${dotClass} border-2 border-[var(--bg-card)]`} />
                          )}
                        </div>
                        <div>
                          <p className="text-sm font-medium text-[var(--text-primary)]">{player.full_name}</p>
                          <p className="text-xs text-[var(--text-muted)]">{player.email}</p>
                        </div>
                      </Link>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={statusBadgeVariant(player.status)}>
                        {PLAYER_STATUS_LABELS[player.status as keyof typeof PLAYER_STATUS_LABELS] || player.status}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="font-mono text-[var(--text-primary)]">{r?.singles_elo ?? '-'}</span>
                      {r?.singles_provisional && <span className="text-xs text-[var(--text-muted)] ml-1">P</span>}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <span className="font-mono text-[var(--text-primary)]">{r?.doubles_elo ?? '-'}</span>
                      {r?.doubles_provisional && <span className="text-xs text-[var(--text-muted)] ml-1">P</span>}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-[var(--text-secondary)]">
                      {r ? `${r.singles_wins}-${r.singles_losses}` : '-'}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-[var(--text-secondary)]">
                      {r ? `${r.doubles_wins}-${r.doubles_losses}` : '-'}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex gap-1 justify-end">
                        <PlayerActions mode="edit" playerId={player.id} playerData={player} />
                        <PlayerActions mode="delete" playerId={player.id} playerName={player.full_name} />
                      </div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {(!players || players.length === 0) && (
          <p className="text-center text-[var(--text-muted)] py-8">No players found</p>
        )}
      </Card>
      </div>
    </div>
  );
}
