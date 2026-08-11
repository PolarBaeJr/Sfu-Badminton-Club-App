export const dynamic = 'force-dynamic';
import { createAdminClient, getAuthenticatedConsoleUser } from '@/lib/supabase-server';
import { accessLevelFor, atLeast, canAccess, permissionsOf, permits } from '@/lib/permissions';
import { Badge, AvatarChip, Card, EmptyState, PageHeader } from '@badminton/ui';
import { PLAYER_STATUS_LABELS } from '@badminton/shared';
import Link from 'next/link';
import {
  UserCheck,
  AlertTriangle,
  Swords,
  ArrowUpRight,
  Trophy,
} from 'lucide-react';
import { PlayerActions } from '../players/player-actions';
import { openableSections } from '@/components/nav-sections';
import { getSeasonFinances } from '@/lib/season-finance';
import { getDashboardFinances } from '@/lib/dashboard-finance';

/** Money, formatted the way the finance cards on /fees format it. */
const money = (cents: number) => `$${(Math.abs(cents) / 100).toFixed(2)}`;

// Only needed to give the "trainer sees no matches" branch of the fetch below a
// type to agree with — the admin client carries no generated Database type, so
// the real query's rows are untyped.
type DashboardMatch = {
  id: string;
  score_summary: string | null;
  result_status: string;
  match_participants?: Record<string, unknown>[] | null;
};

// Same job for the pending-approvals query: it only needs a type so the
// not-an-exec branch agrees with the real one.
type PendingPlayer = {
  id: string;
  full_name: string;
  email: string;
  avatar_url: string | null;
  created_at: string;
  status: string;
  active_flag: boolean;
  role: string;
  is_exec: boolean;
  is_trainer: boolean;
  fee_exempt: boolean;
};

export default async function DashboardPage() {
  const supabase = createAdminClient();

  // The dashboard links into every other section, so it has to answer the same
  // question the sidebar and middleware answer — through the SAME helper, not a
  // hand-kept second list. An exec used to see tiles for disputes, walkovers,
  // fees and challenges, every one of which bounced them to /unauthorized.
  const viewer = await getAuthenticatedConsoleUser();
  const level = accessLevelFor(viewer);
  const permissions = permissionsOf(viewer);
  // Every tile links into a section, so ask the same question the nav and the
  // middleware ask, through the same helper — the fetches behind these tiles
  // would otherwise ship a section's counts into the RSC payload for somebody
  // refused the page itself.
  const showDisputes = canAccess(level, permissions, '/disputes');
  const showWalkovers = canAccess(level, permissions, '/walkovers');
  const showChallenges = canAccess(level, permissions, '/challenges');
  // NOT canAccess(…, '/players') — a COUNT of the members is roster data, and
  // the roster has its own capability now. Reaching /players needs players.page,
  // which somebody may hold in order to add a member without browsing the club;
  // handing them the size of it would be the same leak, one figure at a time.
  // Same reasoning as showFinances below, and the same shape.
  const canReadRoster = permits(level, permissions, 'players.read');
  // NOT canAccess(level, …, '/fees'). Reaching /fees needs `fees.page`, which
  // buys the SECTION and no ledger in it — an exec holds it, and so does anybody
  // handed nothing but the ability to file an expense. The snapshot below is
  // income, expenses AND the net position, which is a capability of its own.
  // Asking the route map here would have leaked all three into an exec's
  // dashboard, from the one file that is supposed to be the example of gating
  // the fetch, and the page-versus-read split makes that a wider leak rather
  // than a narrower one. Ask for the capability the DATA needs.
  const showFinances = permits(level, permissions, 'fees.netposition.read');
  // The ledgers underneath it, one capability each, for the narrowed landing
  // below. Same rule as showFinances and for the same reason: ask for the
  // capability the DATA needs. fees.netposition.read buys the club's whole
  // position; these three each buy one ledger, and somebody may hold one and
  // none of the others — the Finance role is exactly that person. Each gates its
  // own FETCH inside getDashboardFinances(), which is where that mapping can be
  // tested.
  const showExpenses = permits(level, permissions, 'fees.expenses.read');
  const showClubFees = permits(level, permissions, 'fees.clubfees.read');
  const showOtherIncome = permits(level, permissions, 'fees.otherincome.read');
  // An affordance rather than data: it opens /fees, where the form lives and the
  // action re-checks. Nothing is fetched for it.
  const canAddExpense = permits(level, permissions, 'fees.expenses.add.write');
  // Sections that used to be unconditional. A varsity trainer reaches the
  // dashboard (it is where sign-in lands) but has no business in matches or
  // tournaments, and both links bounce them to /unauthorized.
  const showMatches = canAccess(level, permissions, '/matches');
  const showTournaments = canAccess(level, permissions, '/tournaments');
  // The roster is trainer-readable, but deciding a pending signup is exec work —
  // the Edit control below saves through updatePlayer/approvePlayer. Asking for
  // the capability rather than reusing canReadRoster keeps the panel honest:
  // this gates a FETCH, so anyone who kept the panel without it would be handed
  // the pending-approval list and a dialog whose every Save throws.
  const canApprove = permits(level, permissions, 'players.approve.write');

  // DOES ANY PANEL ON THIS PAGE RENDER AT ALL?
  //
  // Somebody narrowed to the Finance role holds fees.page, fees.expenses.read
  // and fees.expenses.add.write, and not one flag above asks for any of them:
  // she signed in, landed here because this is where sign-in lands, and got a
  // header and nothing else. Being narrowed looked identical to the app being
  // broken.
  //
  // EVERYTHING BELOW THIS FLAG RENDERS ONLY WHEN IT IS FALSE, deliberately.
  // An unrestricted exec holds fees.expenses.read — it is in EXEC_BASELINE —
  // so a tile gated on the capability alone would appear for every exec and
  // admin in the club, and this page has to keep looking exactly as it does
  // today for anybody nobody narrowed. There is no capability that separates
  // the Finance role from an ordinary exec inside the fees area (the role IS
  // that subset of the baseline), so the second condition can only be "no panel
  // of the old dashboard is yours". It is a pure function of level and
  // permissions, decided before the first query, and no unrestricted level can
  // reach it: a trainer holds players.read, an exec holds seven of these, an
  // admin holds all of them.
  //
  // The price, named out loud: a narrowed person who holds both matches.page
  // and fees.expenses.read gets the Recent Matches panel and no expense tile.
  const hasTiles = canReadRoster || canApprove || showDisputes || showWalkovers
    || showMatches || showTournaments || showChallenges || showFinances;

  // Where such a person CAN go. Derived from the nav list through the same
  // canAccess() the sidebar and the middleware use, so a section added later
  // signposts itself with no list here to keep. /dashboard is dropped because
  // it is this page.
  const openSections = hasTiles
    ? []
    : openableSections(level, permissions).filter((item) => item.href !== '/dashboard');

  // Gate the FETCHES, not just the tiles: a hidden card whose query still ran
  // would ship admin-only counts into the RSC payload for anyone with devtools.
  const noCount = Promise.resolve({ count: null as number | null });

  // Fold pendingPlayersList into the same parallel batch — it used to chain
  // sequentially after Promise.all, costing an extra round-trip on every load.
  // Use head:true counts everywhere instead of select('*') to avoid streaming
  // every row just to get a count.
  const [
    { count: totalPlayers },
    { count: pendingPlayers },
    { count: openDisputes },
    { count: pendingWalkovers },
    { data: recentMatches },
    { count: activeTournaments },
    { count: activeChalls },
    { data: pendingPlayersList },
  ] = await Promise.all([
    canReadRoster ? supabase.from('players').select('id', { count: 'exact', head: true }).neq('status', 'pending_approval') : noCount,
    canApprove ? supabase.from('players').select('id', { count: 'exact', head: true }).eq('status', 'pending_approval') : noCount,
    showDisputes ? supabase.from('disputes').select('id', { count: 'exact', head: true }).eq('status', 'open') : noCount,
    showWalkovers ? supabase.from('walkovers').select('id', { count: 'exact', head: true }).eq('status', 'pending') : noCount,
    showMatches
      ? supabase.from('matches').select('id, score_summary, played_at, match_type, format, created_at, result_status, match_participants(player_id, team_side, win_flag, rating_delta, player:players(full_name))').order('created_at', { ascending: false }).limit(5)
      : Promise.resolve({ data: null as DashboardMatch[] | null }),
    showTournaments ? supabase.from('tournaments').select('id', { count: 'exact', head: true }).eq('status', 'active') : noCount,
    showChallenges ? supabase.from('challenges').select('id', { count: 'exact', head: true }).in('status', ['proposed', 'partially_confirmed', 'accepted']) : noCount,
    canApprove
      ? supabase
          .from('players')
          // The flag columns are here for the Edit dialog, which reads them to
          // seed its controls — it would otherwise open showing "None" for an
          // exec's console access and offer to take it away.
          .select('id, full_name, email, avatar_url, created_at, status, active_flag, role, is_exec, is_trainer, fee_exempt')
          .eq('status', 'pending_approval')
          .order('created_at', { ascending: false })
          .limit(10)
      : Promise.resolve({ data: null as PendingPlayer[] | null }),
  ]);

  // Each term is gated too: the banner text names open disputes and pending
  // walkovers, so leaving it ungated would leak the counts the tiles hide.
  const alertTerms = [
    canApprove && pendingPlayers && pendingPlayers > 0 ? `${pendingPlayers} pending approval${pendingPlayers > 1 ? 's' : ''}` : null,
    showDisputes && openDisputes && openDisputes > 0 ? `${openDisputes} open dispute${openDisputes > 1 ? 's' : ''}` : null,
    showWalkovers && pendingWalkovers && pendingWalkovers > 0 ? `${pendingWalkovers} pending walkover${pendingWalkovers > 1 ? 's' : ''}` : null,
  ].filter(Boolean);
  const hasAlerts = alertTerms.length > 0;

  // Finance snapshot for the active season: money in, money out, and whether
  // the club is in the positives. Admin-only, and gated on showFinances rather
  // than on reaching /fees — see the note beside that flag.
  let activeSeason: { id: string; name: string } | null = null;
  let seasonIncomeCents = 0;
  let seasonExpenseCents = 0;
  let seasonNetCents = 0;
  if (showFinances) {
    const { data } = await supabase
      .from('seasons')
      .select('id, name')
      .eq('active_flag', true)
      .maybeSingle();
    activeSeason = data;
    if (activeSeason) {
      // Every ledger, via the shared helper. Income used to be summed inline
      // from club_fees only, so recorded reinstatement and tournament money
      // read as $0.00 — and it was wrong here AND on /fees because each page
      // did its own arithmetic. Net is computed in exactly one place for the
      // same reason.
      const finances = await getSeasonFinances(supabase, activeSeason);
      seasonIncomeCents = finances.income.totalCents;
      seasonExpenseCents = finances.expenseCents;
      seasonNetCents = finances.netCents;
    }
  }

  // The narrowed landing's own figures: one query per ledger this person may
  // read and none at all for the ledgers they may not, decided inside
  // getDashboardFinances. Nothing is fetched when the ordinary dashboard
  // rendered — an exec holds fees.expenses.read, and asking for the total on
  // every load would be a query nobody is shown the answer to.
  const ledgers = hasTiles
    ? null
    : await getDashboardFinances(supabase, {
        expenses: showExpenses,
        clubFees: showClubFees,
        otherIncome: showOtherIncome,
      });

  return (
    <div className="space-y-8">
      {/* Header */}
      <PageHeader
        title="Dashboard"
        sub="Overview of club activity and action items"
        watermark="D"
      />

      {/* Alert Banner */}
      {hasAlerts && (
        <div className="rounded-xl border border-[var(--color-warning)]/20 bg-[var(--color-warning)]/5 p-4 flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-[var(--color-warning)]/10 flex items-center justify-center flex-shrink-0">
            <AlertTriangle className="w-5 h-5 text-[var(--color-warning)]" />
          </div>
          <div className="flex-1">
            <p className="text-sm font-medium text-[var(--text-primary)]">Items need your attention</p>
            <p className="text-xs text-[var(--text-muted)] mt-0.5">
              {alertTerms.join(' · ')}
            </p>
          </div>
        </div>
      )}

      {/* Pending Players. Exec-allowed now that /players is — updatePlayer and
          approvePlayer both ask for capabilities an exec holds, so Edit here
          works for both.
          Trainers reach /players but cannot approve, so this whole panel is
          theirs to not see: every row in it is a control that would reject them.

          There is no Competitive/Recreational quick-approve any more. A member
          can be an alumnus or an external, so a two-button decision was never
          the whole question — the row opens the profile and offers the same
          Edit dialog the roster does. */}
      {canApprove && pendingPlayersList && pendingPlayersList.length > 0 && (
        <div className="rounded-xl border border-[var(--color-warning)]/20 bg-[var(--bg-card)] overflow-hidden">
          <div className="px-5 py-4 border-b border-[var(--border)] flex items-center justify-between">
            <div className="flex items-center gap-2">
              <UserCheck className="w-4 h-4 text-[var(--color-warning)]" />
              <h2 className="text-sm font-semibold text-[var(--text-primary)] uppercase tracking-wide">Pending Approvals</h2>
              <span className="text-xs bg-[var(--color-warning)]/10 text-[var(--color-warning)] px-2 py-0.5 rounded-full font-medium">{pendingPlayersList.length}</span>
            </div>
            <Link href="/players?tab=attention" className="text-xs text-[var(--color-accent)] hover:underline flex items-center gap-1">
              View All <ArrowUpRight className="w-3 h-3" />
            </Link>
          </div>
          <div className="divide-y divide-[var(--border)]">
            {pendingPlayersList.map((player) => (
              <div key={player.id} className="px-5 py-3 flex items-center justify-between gap-4">
                {/* A sibling of the Edit button, never wrapped around it: a
                    <button> inside an <a> is unreachable by keyboard and read
                    as one control by a screen reader. */}
                <Link href={`/players/${player.id}`} className="flex items-center gap-3 min-w-0 hover:text-[var(--color-accent)]">
                  <AvatarChip src={player.avatar_url} name={player.full_name} size="sm" id={player.id} />
                  <div className="min-w-0">
                    <p className="text-sm font-medium text-[var(--text-primary)] truncate">{player.full_name}</p>
                    <p className="text-xs text-[var(--text-muted)] truncate">{player.email}</p>
                  </div>
                </Link>
                <PlayerActions
                  mode="edit"
                  playerId={player.id}
                  playerName={player.full_name}
                  playerData={player}
                  isAdmin={atLeast(level, 'admin')}
                  canApprove={canApprove}
                />
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Stat strip */}
      {(canReadRoster || showDisputes || showWalkovers) && (
      <div className="stat-strip">
        {canReadRoster && (
          <Link href="/players" className="hover:bg-[var(--bg-card)] transition-colors">
            <p className="stat-label">Active Players</p>
            <p className="stat-value">{totalPlayers ?? 0}</p>
          </Link>
        )}
        {/* Approving is exec work, so the COUNT is exec work too. This rode on
            the roster flag, which is trainer-level, so a trainer saw how many
            people were waiting on a decision they cannot make — and the panel
            and its buttons below were already exec-only, so the number was the
            one part that leaked. */}
        {canApprove && (
          <Link href="/players?tab=attention" className="hover:bg-[var(--bg-card)] transition-colors">
            <p className="stat-label">Pending Approvals</p>
            <p className={`stat-value ${(pendingPlayers ?? 0) > 0 ? 'text-[var(--color-warning)]' : ''}`}>{pendingPlayers ?? 0}</p>
          </Link>
        )}
        {/* Hidden outright rather than zeroed: a hollow "0 open disputes" tile
            that bounces to /unauthorized is worse than no tile. .stat-strip is
            grid-auto-flow:column, so the remaining tiles simply widen. */}
        {showDisputes && (
          <Link href="/disputes" className="hover:bg-[var(--bg-card)] transition-colors">
            <p className="stat-label">Open Disputes</p>
            <p className={`stat-value ${(openDisputes ?? 0) > 0 ? 'text-[var(--color-danger)]' : ''}`}>{openDisputes ?? 0}</p>
          </Link>
        )}
        {showWalkovers && (
          <Link href="/walkovers" className="hover:bg-[var(--bg-card)] transition-colors">
            <p className="stat-label">Pending Walkovers</p>
            <p className={`stat-value ${(pendingWalkovers ?? 0) > 0 ? 'text-[var(--color-warning)]' : ''}`}>{pendingWalkovers ?? 0}</p>
          </Link>
        )}
      </div>
      )}

      {/* Finance snapshot — in, out, and the net. The net is the headline
          because it is the question the club owner actually asks; income alone
          reads like good news no matter what has been spent. */}
      {showFinances && activeSeason && (
        <Link href="/fees" className="group block">
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-5 hover:border-[var(--border-hover)] transition-all hover:shadow-lg hover:shadow-black/5 flex items-center justify-between gap-4 flex-wrap">
            <div>
              <p className="text-xs text-[var(--text-muted)] uppercase">{activeSeason.name} · Net position</p>
              <p
                className={`text-3xl font-bold font-mono mt-1 ${
                  seasonNetCents < 0 ? 'text-[var(--color-danger)]' : 'text-[var(--color-success)]'
                }`}
              >
                {seasonNetCents < 0 ? '-' : ''}${(Math.abs(seasonNetCents) / 100).toFixed(2)}
              </p>
              <p className="text-xs text-[var(--text-muted)] mt-1">
                <span className="text-[var(--color-success)] font-mono">${(seasonIncomeCents / 100).toFixed(2)}</span> in
                {' · '}
                <span className="text-[var(--color-danger)] font-mono">${(seasonExpenseCents / 100).toFixed(2)}</span> out
              </p>
            </div>
            <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
              Manage finances <ArrowUpRight className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity" />
            </div>
          </div>
        </Link>
      )}

      {/* Two Column Section. Collapses to one column when Challenges is hidden,
          so an exec gets a full-width Tournaments card rather than a half-width
          one floating beside a gap. */}
      {(showTournaments || showChallenges) && (
      <div className={`grid grid-cols-1 gap-6 ${showTournaments && showChallenges ? 'lg:grid-cols-2' : ''}`}>
        {/* Active Tournaments */}
        {showTournaments && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Trophy className="w-4 h-4 text-[var(--text-muted)]" />
              <h2 className="text-sm font-semibold text-[var(--text-primary)] uppercase tracking-wide">Tournaments</h2>
            </div>
            <Link href="/tournaments" className="text-xs text-[var(--color-accent)] hover:underline flex items-center gap-1">
              Manage <ArrowUpRight className="w-3 h-3" />
            </Link>
          </div>
          <div className="flex items-end gap-2">
            <p className="text-4xl font-bold font-mono text-[var(--text-primary)]">{activeTournaments ?? 0}</p>
            <p className="text-sm text-[var(--text-muted)] mb-1">active</p>
          </div>
        </div>
        )}

        {/* Active Challenges */}
        {showChallenges && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-6">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <Swords className="w-4 h-4 text-[var(--text-muted)]" />
              <h2 className="text-sm font-semibold text-[var(--text-primary)] uppercase tracking-wide">Active Challenges</h2>
            </div>
            <Link href="/challenges" className="text-xs text-[var(--color-accent)] hover:underline flex items-center gap-1">
              View All <ArrowUpRight className="w-3 h-3" />
            </Link>
          </div>
          <div className="flex items-end gap-2">
            <p className="text-4xl font-bold font-mono text-[var(--text-primary)]">{activeChalls ?? 0}</p>
            <p className="text-sm text-[var(--text-muted)] mb-1">active</p>
          </div>
        </div>
        )}
      </div>
      )}

      {/* Recent Matches */}
      {showMatches && (
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)]">
        <div className="flex items-center justify-between p-6 pb-4">
          <div className="flex items-center gap-2">
            <Trophy className="w-4 h-4 text-[var(--text-muted)]" />
            <h2 className="text-sm font-semibold text-[var(--text-primary)] uppercase tracking-wide">Recent Matches</h2>
          </div>
          <Link href="/matches" className="text-xs text-[var(--color-accent)] hover:underline flex items-center gap-1">
            View All <ArrowUpRight className="w-3 h-3" />
          </Link>
        </div>
        <div className="px-6 pb-6">
          <div className="space-y-1">
            {recentMatches?.map((match) => {
              const participants = match.match_participants || [];
              const sideA = participants.filter((p: Record<string, unknown>) => p.team_side === 'a');
              const sideB = participants.filter((p: Record<string, unknown>) => p.team_side === 'b');

              return (
                <div key={match.id} className="flex items-center justify-between py-3 border-b border-[var(--border)] last:border-0 hover:bg-white/[0.02] -mx-3 px-3 rounded-lg transition-colors">
                  <div className="flex items-center gap-3 min-w-0">
                    <span className="text-sm text-[var(--text-primary)] truncate">
                      {sideA.map((p: Record<string, unknown>) => (p.player as Record<string, unknown>)?.full_name).join(' & ')}
                    </span>
                    <span className="text-xs text-[var(--text-muted)] flex-shrink-0 bg-[var(--border-hover)] px-1.5 py-0.5 rounded">vs</span>
                    <span className="text-sm text-[var(--text-primary)] truncate">
                      {sideB.map((p: Record<string, unknown>) => (p.player as Record<string, unknown>)?.full_name).join(' & ')}
                    </span>
                  </div>
                  <div className="flex items-center gap-3 flex-shrink-0 ml-4">
                    <span className="text-sm font-mono text-[var(--text-primary)] font-medium">{match.score_summary || '-'}</span>
                    <Badge
                      variant={
                        match.result_status === 'confirmed' ? 'success' :
                        match.result_status === 'disputed' ? 'danger' :
                        'warning'
                      }
                    >
                      {match.result_status}
                    </Badge>
                  </div>
                </div>
              );
            })}
            {(!recentMatches || recentMatches.length === 0) && (
              <div className="flex flex-col items-center py-8">
                <Trophy className="w-8 h-8 text-[var(--text-muted)]/50 mb-2" />
                <p className="text-sm text-[var(--text-muted)]">No matches yet</p>
              </div>
            )}
          </div>
        </div>
      </div>
      )}

      {/* THE NARROWED LANDING. Everything above belongs to a capability this
          person does not hold, so rather than a header over an empty page they
          get the money they may see, the one thing they may file, and a list of
          the doors that will actually open. */}
      {!hasTiles && (
      <div className="space-y-6">
        {/* Each figure is present only because its own read was held and its
            own query ran; a null here means nothing was fetched, not that a
            card was hidden. */}
        {ledgers && (
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            {ledgers.expenseCents !== null && (
              <Card>
                <p className="text-xs text-[var(--text-muted)] uppercase">{ledgers.season.name} · Expenses</p>
                <p className="text-2xl font-bold font-mono text-[var(--color-danger)]">-{money(ledgers.expenseCents)}</p>
                <p className="text-xs text-[var(--text-muted)] mt-1">Money the club has spent this season</p>
              </Card>
            )}
            {ledgers.clubFeeCents !== null && (
              <Card>
                <p className="text-xs text-[var(--text-muted)] uppercase">{ledgers.season.name} · Club fees</p>
                <p className="text-2xl font-bold font-mono text-[var(--color-success)]">{money(ledgers.clubFeeCents)}</p>
                <p className="text-xs text-[var(--text-muted)] mt-1">Season dues collected</p>
              </Card>
            )}
            {ledgers.otherIncomeCents !== null && (
              <Card>
                <p className="text-xs text-[var(--text-muted)] uppercase">{ledgers.season.name} · Other income</p>
                <p className="text-2xl font-bold font-mono text-[var(--color-success)]">{money(ledgers.otherIncomeCents)}</p>
                <p className="text-xs text-[var(--text-muted)] mt-1">Donations, grants and socials</p>
              </Card>
            )}
          </div>
        )}

        {/* Offered on the write alone, with no season and no ledger behind it:
            somebody may be able to file an expense and to see none, which is
            the state /fees was reshaped to support. */}
        {canAddExpense && (
          <Link href="/fees?tab=expenses" className="group block">
            <Card className="hover:border-[var(--border-hover)] transition-colors flex items-center justify-between gap-4 flex-wrap">
              <div>
                <p className="text-sm font-medium text-[var(--text-primary)]">Paid for something out of pocket?</p>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">
                  File it against the season so the club has a record of the spend and can pay you back.
                </p>
              </div>
              <div className="flex items-center gap-2 text-sm text-[var(--text-muted)]">
                Add an expense <ArrowUpRight className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity" />
              </div>
            </Card>
          </Link>
        )}

        {openSections.length > 0 && (
          <Card>
            <EmptyState
              title="Nothing here needs you"
              description="Your console access covers part of the club's work. These are the sections you can open."
              action={
                <div className="flex flex-wrap justify-center gap-2">
                  {openSections.map(({ href, label, icon: Icon }) => (
                    <Link
                      key={href}
                      href={href}
                      className="inline-flex items-center gap-2 px-3 min-h-[44px] rounded-lg border border-[var(--border)] bg-[var(--bg-elevated)] text-sm text-[var(--text-secondary)] hover:border-[var(--border-hover)] hover:text-[var(--text-primary)] transition-colors"
                    >
                      <Icon className="w-4 h-4" />
                      {label}
                    </Link>
                  ))}
                </div>
              }
            />
          </Card>
        )}
      </div>
      )}
    </div>
  );
}
