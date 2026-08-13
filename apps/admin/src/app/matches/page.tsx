export const dynamic = 'force-dynamic';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { accessLevelFor, permissionsOf, permits } from '@/lib/permissions';
import { Card, Badge, PageHeader, TableCard, Atomic } from '@badminton/ui';
import { MATCH_FORMAT_LABELS, formatDateTime, unwrap } from '@badminton/shared';
import { SearchableTable } from '@/components/searchable-table';
import { MatchActions } from './actions';
import { CreateMatchForm } from './create-match';
import { LiveMatches } from './live-matches';
import {
  Plus,
  AlertTriangle,
  Clock,
  ArrowUp,
  ArrowDown,
  Minus,
  Inbox,
} from 'lucide-react';

export default async function MatchesPage() {
  // Same capability middleware resolves for '/matches', re-asked at the fetch.
  const viewer = await requireCapability('matches.page');
  // The roster below is not this page's data — it is the option list of ONE
  // control, the Create Match form, and it answers to the capability that
  // form's own action re-checks. Skipping the query rather than the form is the
  // rule: `players` is handed straight to a client component, so it crosses to
  // the browser whether or not anything is drawn with it.
  const canCreate = permits(accessLevelFor(viewer), permissionsOf(accessLevelFor(viewer), viewer), 'matches.create.write');
  const supabase = createAdminClient();

  const matches = unwrap(
    await supabase
      .from('matches')
      .select('*, match_participants(*, player:players(full_name)), match_games(*)')
      .order('created_at', { ascending: false })
      .limit(50)
  );

  // Get all active players for the create match form
  const allPlayers = canCreate
    ? unwrap(
        await supabase
          .from('players')
          .select('id, full_name, avatar_url')
          .eq('active_flag', true)
          .neq('status', 'pending_approval')
          .order('full_name')
      )
    : [];

  // Fetch disputes and walkovers inline
  const matchIds = matches?.map(m => m.id) || [];
  const disputes = unwrap(
    await supabase
      .from('disputes')
      .select('*, opener:players!disputes_opened_by_fkey(full_name)')
      .in('match_id', matchIds.length > 0 ? matchIds : ['00000000-0000-0000-0000-000000000000'])
  );

  const walkovers = unwrap(
    await supabase
      .from('walkovers')
      .select('*, forfeit:players!walkovers_forfeit_player_id_fkey(full_name)')
      .in('challenge_id', matches?.map(m => m.challenge_id).filter(Boolean) || ['00000000-0000-0000-0000-000000000000'])
  );

  const disputesByMatch = new Map<string, typeof disputes>();
  disputes?.forEach(d => {
    const existing = disputesByMatch.get(d.match_id) || [];
    existing.push(d);
    disputesByMatch.set(d.match_id, existing);
  });

  const walkoversByChallenge = new Map<string, typeof walkovers>();
  walkovers?.forEach(w => {
    const existing = walkoversByChallenge.get(w.challenge_id) || [];
    existing.push(w);
    walkoversByChallenge.set(w.challenge_id, existing);
  });

  // Derived once so the desktop table and the mobile cards render the same
  // sides, disputes and walkovers rather than two copies of the same joins.
  const rows = (matches || []).map((m) => ({
    m,
    sideA: m.match_participants?.filter((p: Record<string, unknown>) => p.team_side === 'a') || [],
    sideB: m.match_participants?.filter((p: Record<string, unknown>) => p.team_side === 'b') || [],
    matchDisputes: disputesByMatch.get(m.id) || [],
    matchWalkovers: m.challenge_id ? walkoversByChallenge.get(m.challenge_id) || [] : [],
  }));

  const names = (side: Record<string, unknown>[]) =>
    side.map((p) => (p.player as Record<string, unknown>)?.full_name as string);

  // Each name stays whole; the line may break between names.
  const sideLine = (side: Record<string, unknown>[], won: boolean) => (
    <span
      className={`inline-flex flex-wrap items-baseline gap-x-1.5 ${
        won ? 'text-[var(--color-success)] font-semibold' : 'text-[var(--text-secondary)]'
      }`}
    >
      {names(side).map((n, i) => (
        <span key={i} className="inline-flex items-baseline gap-x-1.5">
          {i > 0 && <span className="text-[var(--text-muted)]">&amp;</span>}
          <Atomic>{n}</Atomic>
        </span>
      ))}
    </span>
  );

  // The dispute and walkover call-outs, which both renderings hang off the row.
  const callouts = (matchDisputes: Record<string, unknown>[], matchWalkovers: Record<string, unknown>[], boxed: boolean) => (
    <>
      {matchDisputes.length > 0 && (
        <div className={boxed ? 'mt-2 space-y-1' : 'mt-3 space-y-1.5'}>
          {matchDisputes.map((d: Record<string, unknown>) => (
            <div
              key={d.id as string}
              className={`flex items-start gap-1.5 text-xs border-l-2 border-[var(--color-danger)] ${
                boxed ? 'rounded-md px-2.5 py-1.5 bg-[var(--color-danger)]/5' : 'pl-2.5 py-1'
              }`}
            >
              <AlertTriangle className="w-3.5 h-3.5 text-[var(--color-danger)] mt-0.5 shrink-0" />
              <span className="text-[var(--color-danger)]">
                <span className="font-medium">Dispute ({d.status as string})</span>: {d.reason_category as string} — {d.description as string}
              </span>
            </div>
          ))}
        </div>
      )}
      {matchWalkovers.length > 0 && (
        <div className={boxed ? 'mt-2 space-y-1' : 'mt-3 space-y-1.5'}>
          {matchWalkovers.map((w: Record<string, unknown>) => (
            <div
              key={w.id as string}
              className={`flex items-start gap-1.5 text-xs border-l-2 border-[var(--color-warning)] ${
                boxed ? 'rounded-md px-2.5 py-1.5 bg-[var(--color-warning)]/5' : 'pl-2.5 py-1'
              }`}
            >
              <Clock className="w-3.5 h-3.5 text-[var(--color-warning)] mt-0.5 shrink-0" />
              <span className="text-[var(--color-warning)]">
                <span className="font-medium">Walkover ({w.walkover_type as string})</span>: {((w.forfeit as Record<string, unknown>)?.full_name as string)} — {w.status as string}
              </span>
            </div>
          ))}
        </div>
      )}
    </>
  );

  const eloDeltas = (m: Record<string, unknown>, stacked: boolean) => (
    <div className={stacked ? 'flex flex-col gap-1' : 'flex flex-wrap gap-x-3 gap-y-1'}>
      {(m.match_participants as Record<string, unknown>[])?.map((p: Record<string, unknown>) => {
        const delta = p.rating_delta as number;
        const hasDelta = delta !== null && delta !== undefined;
        const isPositive = hasDelta && delta > 0;
        const isNegative = hasDelta && delta < 0;
        return (
          <span
            key={p.id as string}
            className={`inline-flex items-center gap-1 whitespace-nowrap text-xs font-mono font-medium ${
              isPositive ? 'text-[var(--color-success)]' :
              isNegative ? 'text-[var(--color-danger)]' : 'text-[var(--text-muted)]'
            }`}
          >
            {hasDelta ? (
              <>
                {isPositive && <ArrowUp className="w-3 h-3" />}
                {isNegative && <ArrowDown className="w-3 h-3" />}
                {!isPositive && !isNegative && <Minus className="w-3 h-3" />}
                {isPositive ? '+' : ''}{delta}
              </>
            ) : (
              '-'
            )}
          </span>
        );
      })}
    </div>
  );

  // Both renderings of a row, built from one set of names, so the desktop <tr>
  // and the phone <TableCard> cannot disagree about who played — and so the
  // search has a single key per row rather than one per layout.
  const matchRows = rows.map(({ m, sideA, sideB, matchDisputes, matchWalkovers }) => {
    const actions = m.result_status !== 'voided'
      ? <MatchActions matchId={m.id} resultStatus={m.result_status} />
      : undefined;
    const statusVariant =
      m.result_status === 'confirmed' ? 'success' as const :
      m.result_status === 'disputed' ? 'danger' as const :
      m.result_status === 'voided' ? 'neutral' as const :
      'warning' as const;

    return {
      id: m.id as string,
      // Both sides, flattened. Who won and who partnered whom is on the row
      // already; the search only has to answer "is this person in this game".
      players: [...names(sideA), ...names(sideB)].filter(Boolean),
      card: (
        <TableCard
          title={
            <div className="space-y-0.5">
              {sideLine(sideA, m.winner_side === 'a')}
              <div className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--text-muted)]">vs</div>
              {sideLine(sideB, m.winner_side === 'b')}
            </div>
          }
          value={
            m.score_summary
              ? <Atomic separator=",">{m.score_summary}</Atomic>
              : <span className="text-[var(--text-muted)]">-</span>
          }
          badges={
            <>
              <Badge variant={m.rated_flag ? 'warning' : 'neutral'}>
                {m.rated_flag ? 'Rated' : 'Casual'}
              </Badge>
              <Badge variant={statusVariant}>{m.result_status}</Badge>
              <span className="text-xs text-[var(--text-muted)]">{m.match_type}</span>
            </>
          }
          fields={[
            { label: 'Format', value: MATCH_FORMAT_LABELS[m.format as keyof typeof MATCH_FORMAT_LABELS] },
            { label: 'Date', value: m.played_at ? formatDateTime(m.played_at) : '-' },
            { label: 'Elo', wide: true, value: eloDeltas(m, false) },
          ]}
          actions={actions}
        >
          {(matchDisputes.length > 0 || matchWalkovers.length > 0) && callouts(matchDisputes, matchWalkovers, false)}
        </TableCard>
      ),
      row: (
        <tr className="transition-colors duration-150 hover:bg-[var(--border-hover)]">
          <td className="px-5 py-4">
            <div className="text-sm">
              <span className={m.winner_side === 'a' ? 'text-[var(--color-success)] font-semibold' : 'text-[var(--text-secondary)]'}>
                {names(sideA).join(' & ')}
              </span>
              <span className="text-[var(--text-muted)] mx-2 text-xs font-medium uppercase">vs</span>
              <span className={m.winner_side === 'b' ? 'text-[var(--color-success)] font-semibold' : 'text-[var(--text-secondary)]'}>
                {names(sideB).join(' & ')}
              </span>
            </div>
            {callouts(matchDisputes, matchWalkovers, true)}
          </td>
          <td className="px-5 py-4 font-mono text-sm font-medium text-[var(--text-primary)]">
            {m.score_summary || <span className="text-[var(--text-muted)]">-</span>}
          </td>
          <td className="px-5 py-4">
            <div className="flex items-center gap-1.5">
              <Badge variant={m.rated_flag ? 'warning' : 'neutral'}>
                {m.rated_flag ? 'Rated' : 'Casual'}
              </Badge>
              <span className="text-xs text-[var(--text-muted)]">{m.match_type}</span>
            </div>
          </td>
          <td className="px-5 py-4 text-sm text-[var(--text-muted)]">
            {MATCH_FORMAT_LABELS[m.format as keyof typeof MATCH_FORMAT_LABELS]}
          </td>
          <td className="px-5 py-4">{eloDeltas(m, true)}</td>
          <td className="px-5 py-4">
            <Badge variant={statusVariant}>{m.result_status}</Badge>
          </td>
          <td className="px-5 py-4 text-sm text-[var(--text-muted)]">
            {m.played_at ? formatDateTime(m.played_at) : '-'}
          </td>
          <td className="px-5 py-4 text-right">{actions}</td>
        </tr>
      ),
    };
  });

  return (
    <div className="space-y-8">
      {/* The ledger, live. Members submit and confirm results from their phones
          all through a session and every one of those writes belongs in this
          list; revalidatePath only ever covered the exec who wrote something
          here. Mounted as a SIBLING of the table rather than inside it —
          SearchableTable renders through ResponsiveTable, which mounts the
          card list and the table both and hides one with CSS, so anything
          passed in as a row child is instantiated twice and would open two
          channels on one topic. See live-matches.tsx. */}
      <LiveMatches />
      {/* Page Header */}
      <PageHeader
        title="Matches"
        sub="Manage match results, disputes, and walkovers"
        watermark="M"
        actions={<CreateMatchForm players={allPlayers || []} />}
      />

      {/* Matches Table */}
      <Card padding={false}>
        <SearchableTable
          head={
            <tr className="border-b-2 border-[var(--border)]">
              <th className="px-5 py-4 text-left text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">Players</th>
              <th className="px-5 py-4 text-left text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">Score</th>
              <th className="px-5 py-4 text-left text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">Type</th>
              <th className="px-5 py-4 text-left text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">Format</th>
              <th className="px-5 py-4 text-left text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">Elo</th>
              <th className="px-5 py-4 text-left text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">Status</th>
              <th className="px-5 py-4 text-left text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">Date</th>
              <th className="px-5 py-4 text-right text-xs font-semibold text-[var(--text-muted)] uppercase tracking-wider">Actions</th>
            </tr>
          }
          rows={matchRows}
          label="Search matches by player"
          // A game has two sides; typing a name finds it from either. The
          // placeholder says "any player" so nobody assumes it means side A.
          placeholder="Search by any player…"
          noun="match"
          nounPlural="matches"
          empty={
            <div className="flex flex-col items-center justify-center py-20 px-6 text-center">
              <div className="flex items-center justify-center w-14 h-14 rounded-full bg-[var(--border-hover)] mb-4">
                <Inbox className="w-7 h-7 text-[var(--text-muted)]" />
              </div>
              <h3 className="text-base font-semibold text-[var(--text-primary)] mb-1">No matches yet</h3>
              <p className="text-sm text-[var(--text-muted)] max-w-sm">
                Matches will appear here once players start competing. Create a new match to get started.
              </p>
            </div>
          }
        />
      </Card>
    </div>
  );
}
