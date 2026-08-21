import Link from 'next/link';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { accessLevelFor, permissionsOf, permits, type Capability } from '@/lib/permissions';
import { PastSeasonNotice, resolveSeasonScope } from '@/components/season-scope';
import { SeasonSelect } from '@/components/season-select';
import { Badge, Card, AvatarChip, EmptyState, PageHeader, ResponsiveTable, TableCard, Atomic } from '@badminton/ui';
import { unwrap, unwrapMaybe, formatPaymentMethod } from '@badminton/shared';
import type { Season } from '@badminton/shared';
import { isWaivedFee, summariseFeeCollection, type FeeStatusRow } from '@/lib/fee-status';
import { getSeasonFinances } from '@/lib/season-finance';
import { foldLedgerRows } from '@/lib/season-income';
import { outstandingClubFeeCents } from '@/lib/fees-outstanding';
import { FeeActions, AddManualFee, RemoveManualFee } from './fee-actions';
import { ReinstatementsCard } from './reinstatements-card';
import { LedgerCard } from './ledger-card';
import { NetPositionStrip } from './net-position-strip';
import { NetPositionChart } from './net-position-chart';
import { CollectionCharts } from './collection-charts';
import { CardHeading } from './card-heading';

// The three sections of the money page. 'fees' is the original table; the other
// two are the ledgers the club owner asked for ("add other fees", "add another
// tab called expenses"). URL-driven rather than client state so each is a
// server render with its own query — the tab you are not looking at costs
// nothing, and a link to a tab is shareable.
//
// `read` is the exec split, and each tab names its OWN capability rather than
// sharing one flag. /fees admits anyone holding `fees.page`, and an exec holds
// exactly one of the reads beneath it — fees.expenses.read — because the club
// owner asked for "execs can add expenses", not for the finance page. An exec
// gets the Expenses tab and nothing else: no fee roster, no other income, no net
// position, and no tab strip advertising that they exist.
//
// A HOLDER OF THE PAGE AND NO READ AT ALL is a supported state, and the one this
// section was reshaped for: they get the header, the Add expense control if they
// hold that write, and not a single row of anybody's ledger.
// A tab is offered to somebody who may SEE its ledger or ADD to it. Those are
// two capabilities now, and the second without the first is the state this whole
// reshape exists for — offering the tab only on the read would leave a holder of
// the write with a control they cannot navigate to.
const TABS = [
  { id: 'fees', label: 'Club fees', read: 'fees.clubfees.read', add: 'fees.clubfees.addmanual.write' },
  { id: 'income', label: 'Other income', read: 'fees.otherincome.read', add: 'fees.otherincome.add.write' },
  { id: 'expenses', label: 'Expenses', read: 'fees.expenses.read', add: 'fees.expenses.add.write' },
] as const satisfies readonly { id: string; label: string; read: Capability; add: Capability }[];

type TabId = (typeof TABS)[number]['id'];

/** Card identity line: the same avatar + name + sub-line the Player cell shows. */
function personTitle(name: string, sub: string, avatarUrl?: string | null, id?: string) {
  return (
    <div className="flex items-center gap-3">
      <AvatarChip name={name} src={avatarUrl ?? undefined} size="sm" id={id} />
      <div className="min-w-0">
        <p className="text-sm font-medium text-[var(--text-primary)]">{name}</p>
        <p className="text-xs font-normal text-[var(--text-muted)]">{sub}</p>
      </div>
    </div>
  );
}

export default async function FeesPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; season?: string }>;
}) {
  const params = await searchParams;

  // Who is looking. requireCapability() is the gate — middleware already ran,
  // but a page that renders money must not depend on middleware having been
  // reached, and this is the same shape /legal uses. fees.page is the one
  // capability every viewer of this page must hold, and it buys the section
  // only; every ledger on it is asked for separately below.
  const viewer = await requireCapability('fees.page');
  const level = accessLevelFor(viewer);
  const permissions = permissionsOf(accessLevelFor(viewer), viewer);
  const may = (capability: Capability) => permits(level, permissions, capability);
  // THE FIVE READS. Each one gates a FETCH, never a panel — see the note on
  // '/fees' in lib/permissions.ts. The level is no longer consulted anywhere on
  // this page: `isAdmin` used to decide the title, the header sub-line and the
  // way out of the empty state, and each of those was really a question about a
  // ledger, answered by proxy. A proxy that is right for the two levels shipped
  // today is exactly what stops being right the first time somebody is handed a
  // hand-composed role.
  const showExpenses = may('fees.expenses.read');
  const showClubFees = may('fees.clubfees.read');
  const showOtherIncome = may('fees.otherincome.read');
  const showNetPosition = may('fees.netposition.read');
  const showReinstatements = may('fees.reinstatements.read');
  // WHICH LEDGER CONTROLS ARE OFFERED, asked one capability at a time.
  //
  // These four used to be a single `isAdmin` handed to LedgerCard, which was
  // true of the boundary as it stood — filing an expense was exec work and
  // everything else on the row was admin work. It is not a boundary that can be
  // written down as one flag any more: the point of this model is that a
  // treasurer can be handed "edit and settle expenses" without being handed the
  // console. Each control names the capability its own action re-checks, so the
  // two agree by construction rather than by two people remembering one rule.
  const expenseWrites = {
    add: may('fees.expenses.add.write'),
    update: may('fees.expenses.update.write'),
    reimburse: may('fees.expenses.reimburse.write'),
    remove: may('fees.expenses.remove.write'),
  };
  const incomeWrites = {
    add: may('fees.otherincome.add.write'),
    // The income ledger has no payer, so nothing to edit in place and nothing
    // to settle — removeOtherIncome is the only write on a row.
    update: false,
    reimburse: false,
    remove: may('fees.otherincome.remove.write'),
  };

  // Recording a reinstatement payment is its own capability, and the ledger it
  // belongs to rides on the Club fees tab — a reinstatement IS a fee. So that
  // tab is offered to somebody whose only claim on this page is that ledger;
  // without this clause the card below could never be reached, which is what
  // made the write unreachable rather than merely blank.
  const showReinstatementsTab = showReinstatements || may('fees.reinstatements.write');
  const visibleTabs = TABS.filter(
    (t) => may(t.read) || may(t.add) || (t.id === 'fees' && showReinstatementsTab),
  );
  // An exec asking for ?tab=income lands on Expenses rather than /unauthorized:
  // the query string is not a route, so middleware cannot see it, and every
  // fetch below is gated on its own capability regardless of what `tab` says.
  // Forcing the tab is presentation; the gating underneath is the boundary.
  //
  // Falls back to Expenses when nothing is visible at all, which renders
  // nothing: a viewer with the page and no ledger capability sees the header and
  // the season picker, and that is the whole of it.
  const requested = visibleTabs.find((t) => t.id === params.tab)?.id;
  const tab: TabId = requested ?? visibleTabs[0]?.id ?? 'expenses';

  // WHAT THE PAGE IS CALLED, asked of the capabilities rather than of the level.
  // "Finances" is only honest when there is more than one ledger to reach; the
  // person who can reach exactly one, and it is the expense ledger, is looking
  // at a page about spending and the heading should say so. This used to read
  // `isAdmin`, which gave the same two answers for the two levels that existed
  // and the wrong one for every hand-composed role in between — somebody granted
  // the expense ledger alone was told "Finances" the moment they were not an
  // exec, and an admin stripped back to expenses was told it too.
  const onlyExpenses = visibleTabs.length === 1 && visibleTabs[0]?.id === 'expenses';
  const pageTitle = onlyExpenses ? 'Expenses' : 'Finances';
  const pageWatermark = onlyExpenses ? 'E' : 'F';


  const supabase = createAdminClient();

  // Every season, so a finished term's books stay reachable. This page was
  // pinned to active_flag with no override, which meant that the moment a
  // season rolled over the club's own accounts for it — dues, other income,
  // expenses, the net position — could not be opened from the console at all.
  // The rows were always there and correctly stamped; nothing could name a
  // different season.
  //
  // THE PRICE LIST IS NOT A SECRET, and this used to gate it as though it were.
  //
  // `get_active_season()` returns competitive_fee_cents and recreational_fee_cents
  // and is `GRANT EXECUTE ... TO anon` (00003_functions.sql:91-98, verified live).
  // So what the club charges is readable by a stranger with no account, and
  // withholding it from an exec inside the console protected nothing while making
  // /fees and /seasons disagree about who owns the same two columns — /seasons has
  // always selected them under seasons.page alone.
  //
  // The line that matters is a different one: what the club CHARGES is public,
  // and WHO HAS PAID is not. That second half is still gated — the roster below,
  // the payer options and every ledger read each ask for their own capability.
  // Only the price list moved.
  //
  // The rest of this page's rule still stands and is why the columns were split
  // out in the first place: a value that reaches the server component reaches the
  // RSC payload whether or not it is drawn, and this list is handed straight to
  // SeasonSelect, a client component, so every column on it crosses to the
  // browser for certain. That argument is decisive for member data. It just does
  // not apply to a figure the club publishes to anonymous visitors.
  const { data: allSeasons } = await supabase
    .from('seasons')
    .select('id, name, start_date, end_date, active_flag, competitive_fee_cents, recreational_fee_cents')
    .order('start_date', { ascending: false });
  const { seasons: seasonList, selected: scopedSeason, isPast } =
    resolveSeasonScope(allSeasons, params.season);
  // The select above is now unconditional, so this cast is honest without a
  // caveat: every column named in `Season` is fetched on every path, and a new
  // reader of the fee columns cannot read undefined. (This note used to record
  // the opposite invariant — that the two fee columns existed only when
  // showClubFees was true — which is what made adding a third reader risky.)
  const season = scopedSeason as Season | null;

  if (!season) {
    return (
      <div className="space-y-6">
        <PageHeader eyebrow="No season" title={pageTitle} watermark={pageWatermark} />
        <Card>
          {/* No season means no net position either: club_ledger is
              season_id NOT NULL (00073, kept by 00159), so there is nothing
              to add up and no season to add it up for. Said out loud here
              rather than leaving an admin to wonder where the tabs went. */}
          {/* The way out is offered to whoever can actually take it. This read
              `isAdmin`, which sent a non-admin holder of Seasons looking for a
              link that was not there and offered an admin without it a link
              that bounces. */}
          <EmptyState
            title="No active season"
            description={
              onlyExpenses
                ? 'Expenses follow the active season. One needs to be activated before spending can be recorded.'
                : 'Fees, other income and expenses all follow the active season. Create and activate a season to start tracking money in and out.'
            }
            action={
              may('seasons.page') ? (
                <Link href="/seasons" className="text-[var(--color-accent)] font-medium">
                  Go to Seasons
                </Link>
              ) : undefined
            }
          />
        </Card>
        {/* Rendered here too, deliberately. Club fees need a season and the
            rest of this page cannot be drawn without one — but a lapsed member
            coming back between terms is the ordinary reinstatement, and those
            rows would otherwise be unreachable for exactly as long as the club
            is between seasons.
            Gated on its own capability rather than left to the tab logic: this
            branch returns BEFORE the tabs exist, and the card runs its own
            fetch — an exec opening /fees between seasons would otherwise have
            been handed the reinstatement ledger with no tab involved.
            Rendered for a holder of the WRITE as well, who gets the card with
            its rows withheld: the read and the write are separate permissions
            and a card that simply vanishes explains neither. */}
        {showReinstatementsTab && <ReinstatementsCard seasonId={null} canRead={showReinstatements} />}
      </div>
    );
  }

  // A tab link keeps the season you are looking at. The two selectors on this
  // page are independent — which ledger, and which term — and a tab href built
  // from the path alone silently reset the second one, so opening Expenses
  // while reading a finished term snapped you back to the current season and
  // showed you a different set of numbers under the same heading.
  //
  // Built from the RESOLVED season rather than from params.season, and following
  // SeasonSelect's convention that the active season is the bare path. Echoing
  // the raw parameter would carry `?season=<nonsense>` through every tab link on
  // a page that had already fallen back to the active season and was rendering
  // it — a URL that contradicts what is on screen, and a link somebody might
  // send.
  const tabHref = (id: TabId) =>
    season.active_flag ? `/fees?tab=${id}` : `/fees?tab=${id}&season=${season.id}`;

  const feeForStatus = (status: string) =>
    status === 'competitive' ? season.competitive_fee_cents : season.recreational_fee_cents;

  // Only the Club fees tab renders the roster table, so only it pays for the
  // two queries behind it. The derived counts below all collapse to 0 on an
  // empty list and none of them are rendered off that tab.
  //
  // `showClubFees &&` is belt as well as braces: this flag gates the FETCHES,
  // and a fetch guarded only by a value derived from a query string is one
  // refactor away from being guarded by nothing.
  const showFeeTable = showClubFees && tab === 'fees';
  // Adding a fee by hand is offered only for the CURRENT season. Browsing a
  // finished term is for reading its books, and a new fee filed into it would
  // land outside the season the club is actually collecting for. Named here
  // because the withheld message below has to describe the control truthfully.
  const showAddManualFee = tab === 'fees' && may('fees.clubfees.addmanual.write') && !isPast;

  // Fee-collection list: active players (competitive/recreational) who are
  // neither exec nor fee-exempt.
  const players = showFeeTable
    ? unwrap(
        await supabase
          .from('players')
          .select('id, full_name, email, avatar_url, status')
          .in('status', ['competitive', 'recreational'])
          .eq('is_exec', false)
          .eq('fee_exempt', false)
          .order('full_name')
      )
    : [];

  const fees = showFeeTable
    ? unwrap(
        await supabase
          .from('club_fees')
          .select('id, player_id, manual_name, amount_cents, paid_at, method, reference')
          .eq('season_id', season.id)
          // DUES ONLY, and this filter is load-bearing twice over.
          //
          // It is the PERMISSION BOUNDARY. Since 00094 this table also holds
          // reinstatements, which are a separate capability on this very page
          // (fees.reinstatements.read, see ReinstatementsCard below). Without
          // it, holding fees.clubfees.read would hand you the reinstatement
          // ledger — including ban_reason — through the roster query.
          //
          // It is also what keeps the three figures above meaning anything.
          // summariseFeeCollection counts ONE ROW PER LINE OF THE TABLE and
          // derives Outstanding as the remainder, so a row that is not a line
          // of this table inflates Paid and shrinks Outstanding by one apiece
          // — a mixed count over three populations with three different
          // exemption rules, presented as a count of members who have paid
          // their dues. Entry fees and reinstatements have their own screens
          // with their own totals, and that is where they are counted.
          .eq('fee_type', 'dues')
      )
    : [];
  const feeByPlayer = new Map(
    fees.filter((f) => f.player_id != null).map((f) => [f.player_id, f])
  );
  const manualFees = fees.filter((f) => f.manual_name != null);

  // Shared with waiveFee (lib/fee-status) so the page and the action cannot
  // drift on what "already waived" means.
  const isWaived = isWaivedFee;

  // One row per LINE OF THE TABLE BELOW — each roster player's fee (or nothing,
  // where they have none) followed by the manual entries — so all three figures
  // are counted over the same population with the same test. Paid used to be
  // roster-paid plus `manualFees.length`, which took the manual half on trust
  // rather than testing it, while Outstanding was derived from the roster
  // alone. Waived counts as neither Paid nor Outstanding.
  const collection = summariseFeeCollection([
    ...players.map((p) => feeByPlayer.get(p.id)),
    ...manualFees,
  ]);

  // THE COLLECTION CHARTS, OUT OF THE TWO QUERIES ABOVE AND NO THIRD ONE.
  //
  // Both readings come from rows this page is already holding, through the same
  // folds the dashboard's dues figures come from — so the chart's headline and
  // the dashboard's cannot drift, and drawing them adds nothing to what /fees
  // costs. Gated by `showFeeTable`, which is `showClubFees && tab === 'fees'`:
  // the arithmetic runs over rows that were only fetched under
  // `fees.clubfees.read` in the first place, so there is nothing here to leak.
  //
  // PAID ROWS ONLY, which is exactly the set getClubFeeLedger fetches
  // (`paid_at is not null` over `fee_type = 'dues'`). Waivers are stored as paid
  // rows worth $0, so they are in this set and add no money: matching the club's
  // one dues figure is worth more than a slightly tidier payment count, and the
  // strip above already says how many were waived.
  const collected = showFeeTable ? foldLedgerRows(fees.filter((f) => f.paid_at)) : null;
  // Not offered for a closed term. See the note on `outstandingCents` in
  // ./collection-charts.tsx: the figure is priced from TODAY's roster, which is
  // not the population that was billable in a season that has ended.
  const outstandingCents =
    showFeeTable && !isPast
      ? outstandingClubFeeCents(
          players,
          feeByPlayer as ReadonlyMap<string, FeeStatusRow | undefined>,
          season,
        )
      : null;

  // Everything in and everything out for this season, through the single
  // helper. Income used to be summed from club_fees only, so a recorded
  // reinstatement or tournament payment left the headline reading $0.00 while
  // the money sat in the database — and it was wrong on two pages at once
  // because each page did its own arithmetic. There is one implementation now
  // and both pages call it.
  //
  // Not fetched at all for an exec. This one call reads every income ledger the
  // club has; rendering it conditionally while still awaiting it would put
  // fees, tournament money, reinstatements, donations and the net position into
  // the RSC payload of someone shown none of them.
  const finances = showNetPosition ? await getSeasonFinances(supabase, season) : null;

  return (
    <div className="space-y-6">
      {/* The eyebrow carries the scope. This page can be pointed at any term the
          club has ever run, and which one you are looking at — and whether it is
          finished — was previously discoverable only from the picker below the
          fold on a phone. It is the first fact about every number on the screen,
          so it goes above the title.
          Three states, not two, and "Current" is asked of active_flag rather
          than of !isPast. isPast is derived from the END DATE, so a term the
          club has created but not activated — or any season with no end date on
          it — is not past, and a two-way split would have labelled it Current
          while the season picker three inches below showed its "now" marker
          against a different season entirely. */}
      <PageHeader
        eyebrow={`${season.name} · ${
          season.active_flag ? 'Current' : isPast ? 'Closed' : 'Not active'
        }`}
        title={pageTitle}
        watermark={pageWatermark}
        // The fee amounts are club pricing, so the sub-line follows the
        // club-fee READ rather than the level: they are only in `season` at all
        // when that capability asked for the columns.
        sub={
          showClubFees
            ? `Competitive $${(season.competitive_fee_cents / 100).toFixed(2)} · Recreational $${(season.recreational_fee_cents / 100).toFixed(2)} per member`
            : onlyExpenses
              ? 'Money the club has spent this season'
              : undefined
        }
        actions={
          showAddManualFee
            ? <AddManualFee seasonId={season.id} seasonName={season.name} />
            : undefined
        }
      />

      <div className="space-y-2">
        <SeasonSelect seasons={seasonList} selected={scopedSeason} basePath="/fees" />
        {isPast && scopedSeason && <PastSeasonNotice season={scopedSeason} />}
      </div>

      {/* The answer to "are we in the positives", above the tabs so it is on
          screen no matter which ledger is open. Admin-only, and `finances` is
          null rather than unrendered for an exec — there is nothing to leak
          because nothing was fetched. */}
      {finances && <NetPositionStrip finances={finances} seasonName={season.name} />}

      {/* And the same question over time. The strip answers it for this
          instant; a club that is $40 up having been $600 down in October is in
          a different position from one drifting steadily downwards, and the two
          print the same three figures. Same object, same capability, no extra
          query — the dated rows were already fetched for the totals. */}
      {finances && <NetPositionChart finances={finances} seasonName={season.name} />}

      {/* Tabs. Plain links, matching /players?tab= — the page is an async
          server component, so a client tab control would mean shipping every
          ledger's rows to the browser to show one of them. (@badminton/ui's Tabs
          is a client component driven by onChange, so it cannot do this job.)
          Hidden entirely when there is only one tab to show: a lone "Expenses"
          pill an exec cannot navigate away from is noise, and a full strip
          would advertise two sections that would bounce them.

          A hairline strip rather than pills in a card: cards here hold content,
          and the ledger switch is chrome. Square, hairline-divided and set in
          the console's 11px uppercase micro-label — the same type every other
          control on the page uses — so the strip reads as a control rather than
          as a fourth panel competing with the three below it. Rounded pills
          inset in a rounded card was the one place this page had two radii
          fighting each other. */}
      {visibleTabs.length > 1 && (
      <div className="flex border border-[var(--border)] overflow-x-auto">
        {visibleTabs.map((t) => (
          <Link
            key={t.id}
            href={tabHref(t.id)}
            aria-current={tab === t.id ? 'page' : undefined}
            className={`px-5 min-h-[44px] whitespace-nowrap text-[11px] font-bold uppercase tracking-[0.1em] transition-colors flex items-center border-r border-[var(--border)] last:border-r-0 ${
              tab === t.id
                ? 'bg-[var(--color-accent)] text-white'
                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--border-hover)]'
            }`}
          >
            {t.label}
          </Link>
        ))}
      </div>
      )}

      {(showOtherIncome || incomeWrites.add) && tab === 'income' && (
        <LedgerCard
          kind="income"
          seasonId={season.id}
          seasonName={season.name}
          canRead={showOtherIncome}
          canWrite={incomeWrites}
        />
      )}

      {/* The Expenses ledger, or just its Add control. Rendered when the viewer
          may SEE it or may ADD to it — the two are separate permissions now, and
          somebody holding only the write is exactly the person this section was
          reshaped for. `tab` is not consulted for the write-only case: with no
          reads there is no tab strip to have chosen from, and it falls through
          to 'expenses' anyway. */}
      {(showExpenses || expenseWrites.add) && tab === 'expenses' && (
        <LedgerCard
          kind="expense"
          seasonId={season.id}
          seasonName={season.name}
          canRead={showExpenses}
          canWrite={expenseWrites}
        />
      )}

      {/* The Club fees tab with no club-fee read behind it. The tab is offered
          on the ADD capability as well as on the read, so this is a reachable
          state — and it used to render an empty body, which reads as a broken
          page rather than as a withheld one. Same voice as the ledger cards: you
          may not see this, not there is nothing to see.
          Said only to somebody with a claim on THIS ledger. The tab is also
          opened by the reinstatement pair below, and telling that holder a
          ledger they never asked about is withheld would be a second
          unexplained panel — which is the thing this is fixing. Asked as the
          raw capability rather than through showAddManualFee, so that browsing
          a finished term (where the control is withdrawn) does not silently
          take the explanation with it. */}
      {tab === 'fees' && !showClubFees && may('fees.clubfees.addmanual.write') && (
        <Card>
          <EmptyState
            title="Club fees are not shown to you"
            description={
              showAddManualFee
                ? `You can add a fee to ${season.name} by hand, but not browse who has paid.`
                : 'Who has paid their dues this season is not shown to you.'
            }
          />
        </Card>
      )}

      {showFeeTable && (
      <>
      {/* How collection is going, as the console's stat strip rather than as
          two cards. These are counts of people, not money, so they keep the
          shipped display face; only amounts are forced to mono.
          Outstanding takes the warning tone only when there is something
          outstanding — a permanently amber zero is a warning nobody can act on,
          and it trains people to ignore the colour that matters. Waived appears
          only when the club has actually waived somebody: .stat-strip lays its
          cells out with grid-auto-flow:column, so the other two simply widen.

          All three come out of one call over one list, so they add up to the
          number of rows in the table underneath and a reader can subtract them
          from each other. They did not before. */}
      <div className="stat-strip">
        <div>
          <p className="stat-label">Paid</p>
          <p className="stat-value text-[var(--color-success)]">{collection.paid}</p>
        </div>
        <div>
          <p className="stat-label">Outstanding</p>
          <p className={`stat-value ${collection.outstanding > 0 ? 'text-[var(--color-warning)]' : ''}`}>
            {collection.outstanding}
          </p>
        </div>
        {collection.waived > 0 && (
          <div>
            <p className="stat-label">Waived</p>
            <p className="stat-value">{collection.waived}</p>
          </div>
        )}
      </div>

      {/* Dollars, where the strip above counts people. Forty of ninety members
          paid is not half the money when the two tiers are priced differently,
          and "has collection stalled" is not a question a count can answer at
          all. Costs no query — see the note beside `collected`. */}
      {collected && (
        <CollectionCharts
          seasonName={season.name}
          isPast={isPast}
          collectedCents={collected.total}
          outstandingCents={outstandingCents}
          payments={collected.payments}
        />
      )}

      {/* Fee Table */}
      <Card padding={false}>
        <CardHeading
          title="Club fees"
          sub={`Who owes dues for ${season.name}, and what has been collected.`}
        />
        {/* The empty state REPLACES the table rather than sitting under it. A
            header row with no rows beneath it, followed by a sentence saying
            there are none, states the same thing twice and the first statement
            is furniture. Same shape the two ledger cards use. */}
        {players.length === 0 && manualFees.length === 0 ? (
          <EmptyState
            title="Nobody owes fees yet"
            description={`No member is due to pay for ${season.name}. Members become due when they are approved as competitive or recreational and are not fee-exempt.`}
          />
        ) : (
        <ResponsiveTable
          cards={[
            ...players.map((player) => {
              const fee = feeByPlayer.get(player.id);
              const waived = isWaived(fee);
              const paid = Boolean(fee?.paid_at) && !waived;
              return (
                <TableCard
                  key={player.id}
                  title={personTitle(player.full_name, player.email, player.avatar_url, player.id)}
                  value={
                    <Atomic>
                      {paid && fee?.amount_cents != null ? `$${(fee.amount_cents / 100).toFixed(2)}` : '-'}
                    </Atomic>
                  }
                  badges={
                    <Badge variant={paid ? 'success' : waived ? 'neutral' : 'warning'}>
                      {paid ? 'Paid' : waived ? 'Waived' : 'Unpaid'}
                    </Badge>
                  }
                  fields={[
                    { label: 'Method', value: paid && fee?.method ? formatPaymentMethod(fee.method) : '-' },
                    { label: 'Reference', value: paid && fee?.reference ? <Atomic className="font-mono text-xs">{fee.reference}</Atomic> : '-' },
                  ]}
                  actions={
                    <FeeActions
                      playerId={player.id}
                      playerName={player.full_name}
                      seasonId={season.id}
                      seasonName={season.name}
                      defaultFeeCents={feeForStatus(player.status)}
                      paid={paid}
                      waived={waived}
                    />
                  }
                />
              );
            }),
            ...manualFees.map((fee) => (
              <TableCard
                key={fee.id}
                title={personTitle(fee.manual_name, 'Manual entry')}
                value={<Atomic>{fee.amount_cents != null ? `$${(fee.amount_cents / 100).toFixed(2)}` : '-'}</Atomic>}
                badges={<Badge variant="success">Paid</Badge>}
                fields={[
                  { label: 'Method', value: fee.method ? formatPaymentMethod(fee.method) : '-' },
                  { label: 'Reference', value: fee.reference ? <Atomic className="font-mono text-xs">{fee.reference}</Atomic> : '-' },
                ]}
                actions={<RemoveManualFee id={fee.id} name={fee.manual_name} />}
              />
            )),
          ]}
        >
          <table className="w-full">
            <thead>
              <tr className="border-b border-[var(--border)]">
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Player</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Status</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-[var(--text-muted)] uppercase">Amount</th>
                <th className="px-4 py-3 text-left text-xs font-medium text-[var(--text-muted)] uppercase">Method</th>
                <th className="px-4 py-3 text-right text-xs font-medium text-[var(--text-muted)] uppercase">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--border)]">
              {players.map((player) => {
                const fee = feeByPlayer.get(player.id);
                const waived = isWaived(fee);
                const paid = Boolean(fee?.paid_at) && !waived;
                return (
                  <tr key={player.id} className="hover:bg-[var(--border-hover)] transition-colors">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-3">
                        <AvatarChip name={player.full_name} src={player.avatar_url} size="sm" id={player.id} />
                        <div>
                          <p className="text-sm font-medium text-[var(--text-primary)]">{player.full_name}</p>
                          <p className="text-xs text-[var(--text-muted)]">{player.email}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <Badge variant={paid ? 'success' : waived ? 'neutral' : 'warning'}>
                        {paid ? 'Paid' : waived ? 'Waived' : 'Unpaid'}
                      </Badge>
                    </td>
                    <td className="px-4 py-3 text-right">
                      {/* Atomic, like every other amount on this page: "$120.00"
                          breaking after the "$" in a narrow Amount column is the
                          exact bug this wrapper exists for. */}
                      <Atomic className="font-mono text-[var(--text-primary)]">
                        {paid && fee?.amount_cents != null ? `$${(fee.amount_cents / 100).toFixed(2)}` : '-'}
                      </Atomic>
                    </td>
                    <td className="px-4 py-3 text-sm text-[var(--text-secondary)]">
                      {paid && fee?.method ? formatPaymentMethod(fee.method) : '-'}
                      {paid && fee?.reference && (
                        <span className="block font-mono text-xs text-[var(--text-muted)]">{fee.reference}</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <FeeActions
                        playerId={player.id}
                        playerName={player.full_name}
                        seasonId={season.id}
                        seasonName={season.name}
                        defaultFeeCents={feeForStatus(player.status)}
                        paid={paid}
                        waived={waived}
                      />
                    </td>
                  </tr>
                );
              })}
              {manualFees.map((fee) => (
                <tr key={fee.id} className="hover:bg-[var(--border-hover)] transition-colors">
                  <td className="px-4 py-3">
                    <div className="flex items-center gap-3">
                      <AvatarChip name={fee.manual_name} size="sm" />
                      <div>
                        <p className="text-sm font-medium text-[var(--text-primary)]">{fee.manual_name}</p>
                        <p className="text-xs text-[var(--text-muted)]">Manual entry</p>
                      </div>
                    </div>
                  </td>
                  <td className="px-4 py-3">
                    <Badge variant="success">Paid</Badge>
                  </td>
                  <td className="px-4 py-3 text-right">
                    <Atomic className="font-mono text-[var(--text-primary)]">
                      {fee.amount_cents != null ? `$${(fee.amount_cents / 100).toFixed(2)}` : '-'}
                    </Atomic>
                  </td>
                  <td className="px-4 py-3 text-sm text-[var(--text-secondary)]">
                    {fee.method ? formatPaymentMethod(fee.method) : '-'}
                    {fee.reference && (
                      <span className="block font-mono text-xs text-[var(--text-muted)]">{fee.reference}</span>
                    )}
                  </td>
                  <td className="px-4 py-3 text-right">
                    <RemoveManualFee id={fee.id} name={fee.manual_name} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </ResponsiveTable>
        )}
      </Card>

      </>
      )}

      {/* Stays on the Club fees tab: a reinstatement IS a fee, and the rows
          with no amount recorded are the ones an admin is meant to trip over
          while working through the fee list.
          A SIBLING of the fee table rather than a child of it. Nested inside
          showFeeTable, this card needed fees.clubfees.read to appear — a
          different ledger's capability — so a holder of the reinstatement pair
          and nothing else saw no card at all. */}
      {tab === 'fees' && showReinstatementsTab && (
        <ReinstatementsCard seasonId={season.id} canRead={showReinstatements} />
      )}
    </div>
  );
}
