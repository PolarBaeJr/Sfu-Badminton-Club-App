import { createAdminClient } from '@/lib/supabase-server';
import { Badge, Card, AvatarChip, PageHeader } from '@badminton/ui';
import { PLAYER_STATUS_LABELS, getMissingLegalDocuments, getWinRate, unwrap } from '@badminton/shared';
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
    .select('id, full_name, email, avatar_url, status, role, is_exec, fee_exempt, is_banned, deletion_requested_at, waiver_reset_at, ratings(singles_elo, doubles_elo, singles_provisional, doubles_provisional, singles_wins, singles_losses, doubles_wins, doubles_losses), waiver_acceptances(document, version, accepted_at)')
    .order('created_at', { ascending: false })
    .limit(500);

  if (tab === 'competitive') {
    // Show all active players (not recreational, suspended, or pending)
    query = query.not('status', 'in', '("recreational","suspended","pending_approval")');
  } else if (tab === 'recreational') {
    query = query.eq('status', 'recreational');
  } else if (tab === 'attention') {
    query = query.in('status', ['suspended', 'pending_approval']);
  } else if (tab === 'suspended') {
    query = query.or('status.eq.suspended,is_banned.eq.true');
  } else if (tab === 'inactive') {
    query = query.eq('active_flag', false);
  }

  if (params.search) {
    query = query.ilike('full_name', `%${params.search}%`);
  }

  const players = unwrap(await query);

  // Current legal-document versions — a player's waiver status is "accepted"
  // only when they've accepted the current version of every document AND the
  // waiver itself within the last year (annual renewal — the shared
  // getMissingLegalDocuments helper is the single source of truth).
  const { data: legalDocs } = await supabase.from('legal_documents').select('document, version, reacceptance_required_since');

  // Tab counts are derived from a single fetch of every player's status flags
  // and computed here in JS, so each badge uses the exact same predicate as its
  // tab's list filter. (Per-tab head:true count queries with .in()/.or() were
  // silently returning 0 on the self-hosted PostgREST, so "Needs Attention"
  // showed 0 while listing pending players.)
  const { data: countRows } = await supabase
    .from('players')
    .select('status, is_banned, active_flag')
    .limit(5000);
  const forCount = countRows ?? [];
  const isCompetitive = (s: string) => !['recreational', 'suspended', 'pending_approval'].includes(s);
  const compCount = forCount.filter((p) => isCompetitive(p.status)).length;
  const recCount = forCount.filter((p) => p.status === 'recreational').length;
  const attCount = forCount.filter((p) => p.status === 'suspended' || p.status === 'pending_approval').length;
  const susCount = forCount.filter((p) => p.status === 'suspended' || p.is_banned).length;
  const inactCount = forCount.filter((p) => p.active_flag === false).length;

  const tabs = [
    { id: 'competitive', label: 'Competitive', count: compCount },
    { id: 'recreational', label: 'Recreational', count: recCount },
    { id: 'attention', label: 'Needs Attention', count: attCount },
    { id: 'suspended', label: 'Suspended', count: susCount },
    { id: 'inactive', label: 'Inactive', count: inactCount },
  ];

  return (
    <div className="space-y-6">
      <PageHeader title="Players" watermark="P" actions={<AddPlayerButton />} />

      {/* Tabs */}
      <Card padding={false}>
        <div className="flex gap-1 p-1 overflow-x-auto">
          {tabs.map((t) => (
            <Link
              key={t.id}
              href={`/players?tab=${t.id}`}
              className={`px-4 min-h-[44px] text-sm rounded-md transition-colors flex items-center gap-2 ${
                tab === t.id
                  ? 'bg-[var(--color-accent)] text-white'
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
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Waiver</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-[var(--text-muted)] uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {players?.map((player) => {
                const r = Array.isArray(player.ratings) ? player.ratings[0] : player.ratings;
                const dotClass = attentionDot(player.status);
                const acceptances = (player.waiver_acceptances ?? []) as { document: string; version: string; accepted_at: string }[];
                // Latest acceptance row per document (rows are append-only —
                // an annual waiver renewal adds a new row for the same version).
                const currentAcceptances = (legalDocs ?? [])
                  .map((doc) =>
                    acceptances
                      .filter((a) => a.document === doc.document && a.version === doc.version)
                      .sort((a, b) => a.accepted_at.localeCompare(b.accepted_at))
                      .at(-1)
                  )
                  .filter((a): a is NonNullable<typeof a> => Boolean(a));
                const waiverCurrent =
                  (legalDocs?.length ?? 0) > 0 &&
                  getMissingLegalDocuments(legalDocs ?? [], acceptances, new Date(), player.waiver_reset_at).length === 0;
                const latestAcceptedAt = waiverCurrent
                  ? currentAcceptances.map((a) => a.accepted_at).sort().slice(-1)[0]
                  : null;
                // Documents can be bumped independently — collapse to one string
                // when versions match, else list both.
                const waiverVersion = [...new Set(currentAcceptances.map((a) => a.version))].join(' / ');
                return (
                  <tr key={player.id} className="hover:bg-[var(--border-hover)] transition-colors">
                    <td className="px-4 py-3">
                      <Link href={`/players/${player.id}`} className="flex items-center gap-3 hover:text-[var(--color-accent)]">
                        <div className="relative">
                          <AvatarChip name={player.full_name} src={player.avatar_url} size="sm" id={player.id} />
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
                      <div className="flex flex-wrap gap-1">
                        <Badge variant={statusBadgeVariant(player.status)}>
                          {PLAYER_STATUS_LABELS[player.status as keyof typeof PLAYER_STATUS_LABELS] || player.status}
                        </Badge>
                        {player.is_exec && <Badge variant="info">Exec</Badge>}
                        {player.fee_exempt && <Badge variant="neutral">Fee Exempt</Badge>}
                        {player.is_banned && <Badge variant="danger">Banned</Badge>}
                        {player.deletion_requested_at && (
                          <Badge variant="danger">
                            Deletion {new Date(new Date(player.deletion_requested_at).getTime() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString()}
                          </Badge>
                        )}
                      </div>
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
                      {r ? `${r.singles_wins}-${r.singles_losses}${r.singles_wins + r.singles_losses > 0 ? ` (${getWinRate(r.singles_wins, r.singles_losses)})` : ''}` : '-'}
                    </td>
                    <td className="px-4 py-3 text-right text-sm text-[var(--text-secondary)]">
                      {r ? `${r.doubles_wins}-${r.doubles_losses}${r.doubles_wins + r.doubles_losses > 0 ? ` (${getWinRate(r.doubles_wins, r.doubles_losses)})` : ''}` : '-'}
                    </td>
                    <td className="px-4 py-3">
                      {waiverCurrent ? (
                        <span className="font-mono text-xs text-[var(--text-muted)]">
                          v{waiverVersion}
                          {latestAcceptedAt && ` · ${new Date(latestAcceptedAt).toLocaleDateString()}`}
                        </span>
                      ) : (
                        <Badge variant="warning">Missing</Badge>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex gap-1 justify-end">
                        <PlayerActions mode="edit" playerId={player.id} playerData={player} />
                        <PlayerActions mode="ban" playerId={player.id} playerName={player.full_name} playerData={player} />
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
  );
}
