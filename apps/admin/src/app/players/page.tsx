import { createAdminClient, getAuthenticatedConsoleUser } from '@/lib/supabase-server';
import { accessLevelFor, permissionsOf, permits, type Capability } from '@/lib/permissions';
import { Badge, Card, AvatarChip, EmptyState, PageHeader, TableCard } from '@badminton/ui';
import {
  PLAYER_STATUS_LABELS,
  formatRelativeTime,
  getMissingLegalDocuments,
  getWinRate,
  unwrap,
  parsePrivilegeClaimReview,
  hasPrivilegeClaimReview,
  describePrivileges,
} from '@badminton/shared';
import Link from 'next/link';
import { PlayerActions } from './player-actions';
import { AddPlayerButton } from './add-player-button';
import { MergePlayersButton } from './merge-players-button';
import { PrivilegeReviewActions } from './privilege-review-actions';
import { RosterTable, type RosterRow } from './roster-table';
import { RowLink } from '@/components/row-link';
import { RosterCharts } from './roster-charts';
import { memberIdentifier } from '@/lib/member-identifier';
import { rosterActionsFor, rosterActionKey, type RosterAction } from '@/lib/roster-actions';

/**
 * ONE badge answers "how does this member stand with the club", which is the
 * question the column is for. It is not the status column reprinted: status,
 * active_flag, is_banned and the waiver are four separate facts, and an officer
 * at the door needs the one that stops play, not all four.
 *
 * Ordered by what overrules what. A banned member is banned whatever their
 * waiver says, and telling an officer "No waiver" about somebody who cannot
 * come in anyway would send them chasing a signature instead of a
 * reinstatement.
 *
 * "Banned" is kept apart from "Suspended" though both read danger: they are
 * undone by different controls (reinstatePlayer, which files a fee, versus a
 * status change), and roster-actions.ts turns on exactly that distinction.
 */
function standingOf(
  player: { status: string; is_banned?: boolean | null; active_flag?: boolean | null },
  waiverCurrent: boolean,
): { label: string; variant: 'success' | 'warning' | 'danger' | 'neutral' } {
  if (player.is_banned) return { label: 'Banned', variant: 'danger' };
  if (player.status === 'suspended') return { label: 'Suspended', variant: 'danger' };
  if (player.active_flag === false) return { label: 'Inactive', variant: 'neutral' };
  if (player.status === 'pending_approval') return { label: 'New', variant: 'neutral' };
  if (!waiverCurrent) return { label: 'No waiver', variant: 'warning' };
  return { label: 'Active', variant: 'success' };
}

/** Radius 0 everywhere on this screen but a dialog; Badge ships rounded-full. */
const BADGE = 'rounded-none';
/** The console's column-header voice: 9px mono, wide tracking, muted. */
const TH = 'px-4 py-3 font-mono text-[9px] font-medium uppercase tracking-[0.14em] text-[var(--text-muted)]';
/** An unrated player, an unplayed record. An em-dash, never a blank cell. */
const NONE = <span className="text-[var(--text-muted)]">—</span>;

export default async function PlayersPage({
  searchParams,
}: {
  searchParams: Promise<{ tab?: string; search?: string }>;
}) {
  const params = await searchParams;
  const requestedTab = params.tab || 'competitive';
  // Execs manage the roster; only admins grant privilege, remove, or merge.
  // Hiding those controls is cosmetic — the server actions are the real gate —
  // but showing a button that is guaranteed to fail is worse than not showing
  // it at all.
  const viewer = await getAuthenticatedConsoleUser();
  const level = accessLevelFor(viewer);
  const permissions = permissionsOf(accessLevelFor(viewer), viewer);
  const isAdmin = level === 'admin';
  const can = (capability: Capability) => permits(level, permissions, capability);
  // MAY THEY SEE THE ROSTER? Its own capability, separate from the page key that
  // let them through the door — this is the section the club owner wanted split
  // ("access the page to add stuff, but not see the details in them"), and until
  // now it was the only section that could not be, because the roster query was
  // never gated at all. A varsity trainer holds it, an exec holds it, and
  // somebody handed the page and players.create.write does not.
  const canRead = can('players.read');
  // Editing is what most controls here end up invoking, so ask for that rather
  // than for a level: the controls and the actions behind them then agree by
  // construction, instead of by two people remembering the same rule.
  const canManage = can('players.update.write');
  // Adding is NOT editing. AddPlayerButton saves through createPlayer, which
  // asks for its own capability — riding on canManage meant the one control the
  // page-without-the-roster case exists for was hidden from exactly the person
  // meant to use it.
  const canCreate = can('players.create.write');
  // Its own question, not a second reading of canManage. The Edit dialog does
  // approve AND update through one Save, and the two are separate capabilities
  // — so somebody who may edit a member but not let a new one in must not be
  // offered the control that only they can complete.
  const canApprove = can('players.approve.write');
  // ONE CAPABILITY PER BUTTON, matching the action each one calls. These rode on
  // canManage, which was wrong in both directions: banPlayer asks for
  // players.ban.write and reinstatePlayer for players.reinstate.write, so
  // somebody granted only the update could press either, and somebody granted
  // only the ban could press neither.
  const canBan = can('players.ban.write');
  const canReinstate = can('players.reinstate.write');
  const canRemove = can('players.remove.write');
  // Merge is its own capability and always was — the button asked `isAdmin`,
  // which is the same answer for every baseline today and the wrong question
  // the moment a portfolio hands it to an exec.
  const canMerge = can('players.merge.write');
  // Resolving a permission review restores a console level, so it asks for the
  // capability the /permissions editor asks for — not players.update.write, or
  // somebody who may edit member details could grant admin through a review.
  const canConsoleAccess = can('players.consoleaccess.write');
  /**
   * Which of the actions the tab offers are this viewer's to press.
   *
   * roster-actions.ts decides WHICH buttons a row gets — that is the tab's
   * business, and it is a pure function with tests. This decides which of them
   * you may complete, which is the viewer's business. Keeping the two apart is
   * why that function takes no capabilities and why this filter sits outside
   * it.
   */
  const mayRun = (action: RosterAction, pending: boolean): boolean => {
    switch (action.kind) {
      // Edit is the Needs Attention tab's ONLY control, and there it approves
      // rather than updates (see lib/player-approval.ts). Somebody holding just
      // players.approve.write must therefore still be offered it on a pending
      // signup, or the queue they were given is one they cannot clear.
      case 'edit': return canManage || (pending && canApprove);
      case 'ban': return canBan;
      case 'unban': return canReinstate;
      case 'restore':
      case 'inactive': return canManage;
      case 'remove': return canRemove;
    }
  };
  // Hiding the tab is not the same as closing it: /players?tab=suspended is a
  // URL anyone can type, and the moderation queues are exec business. Fall back
  // rather than error — a trainer following a stale link should land on the
  // roster, not a wall.
  //
  // The question is "can you act on ANY of these queues", not "can you edit":
  // somebody granted only players.ban.write has business on Suspended and would
  // have been bounced off it by a check that asked about updates.
  const canModerate = canManage || canBan || canReinstate;
  // 00132 adds two: `incomplete` lists people who signed in and never finished
  // setup, `permissions` lists claims that withheld or kept console privileges.
  // Both are moderation queues by the same test as the other three — every
  // action they offer asks for a players.*.write — so a trainer is not shown
  // queues they cannot act on, and a stale link falls back to the roster rather
  // than erroring.
  const MODERATION_TABS = ['attention', 'incomplete', 'permissions', 'suspended', 'inactive'];
  const tab = !canModerate && MODERATION_TABS.includes(requestedTab) ? 'competitive' : requestedTab;
  const supabase = createAdminClient();

  let query = supabase
    .from('players')
    .select('id, full_name, handle, member_code, email, avatar_url, status, role, active_flag, last_active_at, is_exec, is_trainer, fee_exempt, is_banned, deletion_requested_at, waiver_reset_at, user_id, onboarding_completed, privilege_claim_review, ratings(singles_elo, doubles_elo, singles_provisional, doubles_provisional, singles_wins, singles_losses, doubles_wins, doubles_losses), waiver_acceptances(document, version, accepted_at)')
    .order('created_at', { ascending: false })
    .limit(500);

  if (tab === 'competitive') {
    // Show all active players (not recreational, suspended, or pending)
    query = query.not('status', 'in', '("recreational","suspended","pending_approval")');
  } else if (tab === 'recreational') {
    query = query.eq('status', 'recreational');
  } else if (tab === 'attention') {
    // Pending approval ONLY. Suspended members used to match here too, so they
    // appeared on this tab AND on Suspended — and this tab offers Recreational /
    // Competitive, which writes status directly and so lifted the suspension
    // without going through Restore. A suspension is undone on the Suspended
    // tab, deliberately, because that is where the ban/suspension distinction
    // is made.
    //
    // 00132: AND NOT AN UNFINISHED SIGNUP. A stub created at first sign-in is
    // also 'pending_approval' — deliberately, because that status is what keeps
    // it off the ladder, out of the pickers and invisible to other members — but
    // it is not waiting on the club to approve it. It is waiting on the MEMBER
    // to finish setup, which is a different queue with a different action, and
    // putting the two in one list would bury the people an exec can actually
    // help behind the people they cannot.
    query = query.eq('status', 'pending_approval').or('onboarding_completed.is.true,user_id.is.null');
  } else if (tab === 'incomplete') {
    // Signed in, never finished. `user_id IS NOT NULL AND NOT onboarding_completed`
    // is the whole definition and it needs no new column: a row with no login and
    // no onboarding is a roster row an exec pre-added, which is a different thing
    // and belongs on Needs Attention where it has always been.
    query = query.not('user_id', 'is', null).eq('onboarding_completed', false);
  } else if (tab === 'permissions') {
    query = query.not('privilege_claim_review', 'is', null);
  } else if (tab === 'suspended') {
    query = query.or('status.eq.suspended,is_banned.eq.true');
  } else if (tab === 'inactive') {
    query = query.eq('active_flag', false);
  }

  // ?search= only seeds the box now — the filtering itself is client-side over
  // the rows below, so it costs no round trip per keystroke and cannot show a
  // list that disagrees with its own tab count.
  //
  // THE FETCH IS SKIPPED, not the table hidden. A row that reaches this
  // component reaches the RSC payload whether or not it is drawn, so the whole
  // point of withholding the roster would be lost by rendering it conditionally
  // after awaiting it. Same rule the five fetches on /fees follow.
  const players = canRead ? unwrap(await query) : [];

  // Current legal-document versions — a player's waiver status is "accepted"
  // only when they've accepted the current version of every document AND the
  // waiver itself within the last year (annual renewal — the shared
  // getMissingLegalDocuments helper is the single source of truth). Nothing
  // outside the roster rows reads them, so there is no round trip when there is
  // no roster.
  const { data: legalDocs } = canRead
    ? await supabase.from('legal_documents').select('document, version, reacceptance_required_since')
    : { data: null };

  // Tab counts are derived from a single fetch of every player's status flags
  // and computed here in JS, so each badge uses the exact same predicate as its
  // tab's list filter. (Per-tab head:true count queries with .in()/.or() were
  // silently returning 0 on the self-hosted PostgREST, so "Needs Attention"
  // showed 0 while listing pending players.)
  // Also selects the identity columns the merge picker needs, so the dialog
  // doesn't cost a second query.
  //
  // Behind players.read like the list itself: it is every member's name, email
  // and avatar, which is the roster by another route. The counts it feeds all
  // collapse to 0 on an empty list, and nothing renders them without the read.
  //
  // `created_at` rides along for the growth curve. One more column on a query
  // that already runs, rather than a second round trip: the chart asks the same
  // question of the same rows this fetch exists to count, and gating it on
  // anything but `players.read` would be a second answer to who may see the
  // roster.
  const { data: countRows } = canRead
    ? await supabase
        .from('players')
        .select(
          'id, full_name, handle, email, avatar_url, user_id, status, is_banned, active_flag, created_at, onboarding_completed, privilege_claim_review',
        )
        .order('full_name')
        .limit(5000)
    : { data: null };
  const forCount = countRows ?? [];
  // 00132. Somebody who signed in and never finished setup: a real person with a
  // proved address, no name and no waiver. They are NOT a member of the club yet,
  // and the point of this predicate is that every headcount below can say so.
  const isIncompleteSignup = (p: { user_id: string | null; onboarding_completed: boolean | null }) =>
    p.user_id !== null && p.onboarding_completed !== true;
  const members = forCount.filter((p) => !isIncompleteSignup(p));
  const isCompetitive = (s: string) => !['recreational', 'suspended', 'pending_approval'].includes(s);
  const compCount = forCount.filter((p) => isCompetitive(p.status)).length;
  const recCount = forCount.filter((p) => p.status === 'recreational').length;
  // Must use the same predicate as the tab's list filter above, or the badge
  // counts rows the tab will not show.
  const attCount = forCount.filter(
    (p) => p.status === 'pending_approval' && !isIncompleteSignup(p),
  ).length;
  const incompleteCount = forCount.filter(isIncompleteSignup).length;
  const permissionReviewCount = forCount.filter((p) =>
    hasPrivilegeClaimReview(p.privilege_claim_review),
  ).length;
  const susCount = forCount.filter((p) => p.status === 'suspended' || p.is_banned).length;
  const inactCount = forCount.filter((p) => p.active_flag === false).length;

  // Needs Attention, Suspended and Inactive are moderation states: every action
  // they offer (edit, approve, ban, restore, mark inactive) asks for a
  // players.*.write. A trainer reads the roster to find the player they are
  // writing a varsity note about, so they get the two tabs that list people who
  // actually play, and are not shown queues they cannot act on.
  const tabs = [
    { id: 'competitive', label: 'Competitive', count: compCount },
    { id: 'recreational', label: 'Recreational', count: recCount },
    ...(canModerate ? [
      { id: 'attention', label: 'Needs Attention', count: attCount },
      // Both hidden at zero rather than shown as "0". They are new queues most
      // clubs will never have anything in, and a permanently empty tab teaches
      // an exec to stop reading the tab strip. Permission review in particular
      // must MEAN something the day it appears.
      ...(incompleteCount > 0 ? [{ id: 'incomplete', label: 'Incomplete', count: incompleteCount }] : []),
      ...(permissionReviewCount > 0
        ? [{ id: 'permissions', label: 'Permission review', count: permissionReviewCount }]
        : []),
      { id: 'suspended', label: 'Suspended', count: susCount },
      { id: 'inactive', label: 'Inactive', count: inactCount },
    ] : []),
  ];

  // Rows are built here, on the server, and handed to the client table as
  // already-rendered nodes: the waiver arithmetic below needs legal_documents
  // and the rating columns need the joined ratings, none of which should be
  // shipped to the browser just so a search box can hide a row.
  //
  // Each row is rendered TWICE — as a <tr> and as a <TableCard> — from the same
  // data on the same server. ResponsiveTable shows the second below `md`,
  // which is the whole point: an officer checking members in at the door is
  // holding a phone, and eight columns in a sideways-scrolling box is not a
  // roster they can read.
  // The tab's standings, counted AS THE ROWS ARE BUILT rather than by a second
  // pass over the same players. standingOf() needs the waiver arithmetic that
  // happens inside this map, and computing it twice is how a chart and the
  // badges beside it end up disagreeing about one member.
  const standingCounts = new Map<string, number>();

  const rows: RosterRow[] = (players ?? []).map((player) => {
    const r = Array.isArray(player.ratings) ? player.ratings[0] : player.ratings;
    const acceptances = (player.waiver_acceptances ?? []) as { document: string; version: string; accepted_at: string }[];
    const waiverCurrent =
      (legalDocs?.length ?? 0) > 0 &&
      getMissingLegalDocuments(legalDocs ?? [], acceptances, new Date(), player.waiver_reset_at).length === 0;
    const standing = standingOf(player, waiverCurrent);
    standingCounts.set(standing.label, (standingCounts.get(standing.label) ?? 0) + 1);
    const claimReview = parsePrivilegeClaimReview(player.privilege_claim_review);
    // A stub has first_name = '' and therefore full_name = '' — deliberately, in
    // 00132: we do not know their name, and inventing one from the email would
    // put something in the roster and the merge picker that reads as real. The
    // blank is rendered as a blank ONCE, here, so the row still identifies
    // somebody (the email is already the row's meta line) instead of showing an
    // empty cell with an avatar beside it.
    const displayName = player.full_name?.trim() ? player.full_name : 'No name yet';
    // The handle if they picked one, else the seven-character code the club
    // assigned. One helper decides which, so the roster and the member's own
    // page cannot disagree about what identifies somebody.
    const identifier = memberIdentifier(player);
    // ONE record, both disciplines summed. The two rating columns beside it
    // already say which discipline is which, and a fifth number in a row read
    // at arm's length buys nothing; the per-discipline split is on the member's
    // own page, where there is room for it to mean something.
    const wins = r ? r.singles_wins + r.doubles_wins : 0;
    const losses = r ? r.singles_losses + r.doubles_losses : 0;
    const record = r && wins + losses > 0 ? `${wins}-${losses} (${getWinRate(wins, losses)})` : null;
    // The division, only where the tab does not already say it. On Competitive
    // and Recreational it would be the tab's own name printed on every row; on
    // Inactive and Suspended it is the thing a Restore has to decide.
    const showDivision = !['competitive', 'recreational'].includes(tab)
      && ['competitive', 'recreational'].includes(player.status);

    const rating = (elo: number | null | undefined, provisional: boolean | null | undefined) =>
      elo == null ? NONE : (
        <>
          <span className="font-mono text-sm text-[var(--text-primary)]">{elo}</span>
          {provisional && <span className="ml-1 font-mono text-[10px] text-[var(--text-muted)]">P</span>}
        </>
      );

    const badges = (
      <>
        <Badge variant={standing.variant} className={BADGE}>{standing.label}</Badge>
        {showDivision && (
          <Badge variant="neutral" className={BADGE}>
            {PLAYER_STATUS_LABELS[player.status as keyof typeof PLAYER_STATUS_LABELS] || player.status}
          </Badge>
        )}
        {/* 00132. Two states that are new because a `players` row no longer
            means "a member of the club". Both are on every tab, not only their
            own, because the merge picker and the Competitive list can show these
            rows too and a nameless row with no explanation is worse than none. */}
        {isIncompleteSignup(player) && (
          <Badge variant="warning" className={BADGE}>Signup unfinished</Badge>
        )}
        {claimReview && (
          <Badge variant={claimReview.state === 'kept' ? 'info' : 'danger'} className={BADGE}>
            {claimReview.state === 'kept' ? 'Kept ' : 'Holding '}
            {describePrivileges(
              claimReview.state === 'kept' ? claimReview.kept : claimReview.withheld,
            )}
          </Badge>
        )}
        {player.is_exec && <Badge variant="info" className={BADGE}>Exec</Badge>}
        {player.is_trainer && <Badge variant="info" className={BADGE}>Trainer</Badge>}
        {player.fee_exempt && <Badge variant="neutral" className={BADGE}>Fee exempt</Badge>}
        {/* Kept although it is not "standing": it is the only badge on this row
            with a deadline in it, and it is the one warning an officer gets
            before the account goes. */}
        {player.deletion_requested_at && (
          <Badge variant="danger" className={BADGE}>
            Deletion {new Date(new Date(player.deletion_requested_at).getTime() + 30 * 24 * 60 * 60 * 1000).toLocaleDateString()}
          </Badge>
        )}
      </>
    );

    // View is not gated: it goes to a page whose own read is players.read,
    // which anybody seeing this row already holds. Every other control is one
    // capability each — see mayRun. WHICH controls appear is the tab's answer,
    // from lib/roster-actions.ts, so an inactive account offers a way back and
    // a suspended one is never offered "Ban".
    const actions = (
      <>
        <Link
          href={`/players/${player.id}`}
          className="inline-flex min-h-[44px] items-center px-3 text-sm text-[var(--text-secondary)] transition-colors hover:bg-[var(--border-hover)] hover:text-[var(--text-primary)]"
        >
          View
        </Link>
        {/* Only where the review is, and only for somebody who can act on it.
            Rendered beside View rather than inside the tab's action set because
            it is not a roster action — it decides a flag, not a member. */}
        {claimReview && (
          <PrivilegeReviewActions
            playerId={player.id}
            playerName={displayName}
            review={claimReview}
            canResolve={canConsoleAccess}
          />
        )}
        {rosterActionsFor(tab, player, { isAdmin })
          .filter((action) => mayRun(action, player.status === 'pending_approval'))
          .map((action) => (
            <PlayerActions
              key={rosterActionKey(action)}
              mode={action.kind}
              playerId={player.id}
              playerName={displayName}
              playerData={player}
              isAdmin={isAdmin}
              canApprove={canApprove}
            />
          ))}
      </>
    );

    const name = (
      <Link href={`/players/${player.id}`} className="group flex items-center gap-3">
        <AvatarChip name={displayName} src={player.avatar_url} size="sm" id={player.id} />
        <span className="min-w-0">
          <span className="block truncate text-sm text-[var(--text-primary)] transition-colors group-hover:text-[var(--color-accent)]">
            {displayName}
          </span>
          {identifier && (
            <span className="block font-mono text-[10px] text-[var(--text-muted)]">{identifier}</span>
          )}
        </span>
      </Link>
    );

    return {
      id: player.id,
      name: displayName,
      handle: player.handle,
      meta: player.email,
      row: (
        <RowLink
          href={`/players/${player.id}`}
          className="cursor-pointer transition-colors hover:bg-[var(--border-hover)]"
        >
          <td className="px-4 py-3">{name}</td>
          <td className="px-4 py-3">
            <div className="flex flex-wrap items-center gap-1">{badges}</div>
          </td>
          <td className="px-4 py-3 text-right">{rating(r?.singles_elo, r?.singles_provisional)}</td>
          <td className="px-4 py-3 text-right">{rating(r?.doubles_elo, r?.doubles_provisional)}</td>
          <td className="px-4 py-3 text-right font-mono text-[13px] text-[var(--text-secondary)]">
            {record ?? NONE}
          </td>
          <td className="px-4 py-3 font-mono text-xs text-[var(--text-muted)]">
            {formatRelativeTime(player.last_active_at)}
          </td>
          {/* 44px on every control here, matching the phone layout: this is the
              same `actions` node TableCard renders, and a thumb does not get a
              second try at a 32px button.
              nowrap, not flex-wrap: three actions were folding onto a second
              line and shoving the row taller than every other one. The table
              sits inside ResponsiveTable's overflow-x-auto, so letting this
              column claim the width it needs costs a horizontal scroll on a
              narrow DESKTOP rather than a ragged two-line row on every wide
              one — and below `md` there is no table to scroll at all. */}
          <td className="whitespace-nowrap px-4 py-3 text-right align-middle">
            <div className="inline-flex flex-nowrap items-center justify-end gap-2 [&_button]:min-h-[44px]">
              {actions}
            </div>
          </td>
        </RowLink>
      ),
      card: (
        <TableCard
          title={name}
          badges={badges}
          fields={[
            { label: 'Singles', value: rating(r?.singles_elo, r?.singles_provisional) },
            { label: 'Doubles', value: rating(r?.doubles_elo, r?.doubles_provisional) },
            { label: 'Record', value: record ?? NONE },
            { label: 'Last seen', value: formatRelativeTime(player.last_active_at) },
          ]}
          actions={actions}
        />
      ),
    };
  });

  return (
    <div className="space-y-6">
      <PageHeader
        // The club's own size, in the console's eyebrow voice. Omitted rather
        // than printed as 0 for somebody without the read: they never fetched
        // the roster, so they have no number to print.
        // `members`, not `forCount`: an unfinished signup is a real person but
        // not yet a member of the club, and 00132 made those rows exist. Counting
        // them here would have made the club's stated size jump on deploy day for
        // a reason nobody could find.
        eyebrow={canRead ? `Roster · ${members.length} members` : 'Roster'}
        title="Players"
        sub="Standing, rating and last seen for every member."
        watermark="P"
        actions={
          <div className="flex items-center gap-2">
            {/* Merge candidates come from the count query, which already loads
                every player — no extra round-trip just to populate the picker.
                It needs the roster read as well as the merge capability: with
                no countRows there is nobody to pick between. */}
            {canMerge && canRead && (
              <MergePlayersButton
                players={(countRows ?? []).map((p) => ({
                  id: p.id,
                  // Unfinished signups stay IN the picker on purpose: merging a
                  // stub into the roster row an exec pre-added is exactly the
                  // recovery an officer needs if one ever slips past the claim.
                  // They are named rather than hidden, because an unlabelled
                  // blank row in a merge dialog is the worst of both.
                  full_name: p.full_name?.trim()
                    ? p.full_name
                    : `No name yet · ${p.email ?? 'unknown address'}`,
                  handle: p.handle,
                  email: p.email,
                  avatar_url: p.avatar_url,
                  has_login: p.user_id !== null,
                  status: p.status,
                }))}
              />
            )}
            {canCreate && <AddPlayerButton isAdmin={isAdmin} />}
          </div>
        }
      />

      {!canRead ? (
        <Card>
          {/* "You may not see this" and "there is nothing to see" are different
              statements, and an empty roster is the one lie this page could
              tell that nobody would question — the club has members. */}
          <EmptyState
            title="The roster is not shown to you"
            description={
              canCreate
                ? 'You can add a member, but not browse the people already on the roster.'
                : 'Nothing on the roster is shown to you.'
            }
          />
        </Card>
      ) : (
        <>
        {/* Above the roster, not below it: five hundred rows is not a scroll
            anybody makes on the way to a summary. Both cards fold rows the page
            has already fetched, and neither is rendered at all without
            players.read — they sit inside this branch for that reason. */}
        <RosterCharts
          standings={[...standingCounts].map(([label, value]) => ({ label, value }))}
          tabLabel={tabs.find((t) => t.id === tab)?.label ?? tab}
          tabTotal={tabs.find((t) => t.id === tab)?.count ?? rows.length}
          // `members`, not `countRows`. A signup that was never finished is not
          // a join: plotting it would put a step on the growth curve for
          // somebody who never became a member, and — because the headline
          // figure below is the same set — the two numbers on this one card
          // would have to agree about which rows count. They do, by using the
          // same list.
          joins={members
            // `players.created_at` is NOT NULL DEFAULT now(), so this drops
            // nothing today and is kept only so a schema change cannot put an
            // undated member on a time axis. It matters that it is dead: the
            // headline figure below is the CLUB's size and the chart's own axis
            // counts the members plotted, and a filter that bit would print two
            // different numbers on one card.
            .filter((p) => p.created_at)
            // One member, valued at one — see the note in roster-charts.tsx on
            // why the field is called `cents`.
            .map((p) => ({ at: p.created_at as string, cents: 1 }))}
          totalMembers={members.length}
          capped={forCount.length >= 5000}
        />
        {/* Remounted per tab (key) so a query typed on one tab cannot carry over
            and silently hide rows on the next. */}
        <RosterTable
          key={tab}
          initialQuery={params.search ?? ''}
          // The tab's own count, not the number of rows fetched. They are the
          // same number until a tab passes the 500-row cap on the list query
          // above, and on the day one does, this is what says so.
          total={tabs.find((t) => t.id === tab)?.count ?? rows.length}
          // True only of the controls this viewer can reach. Every one of those
          // dialogs keeps its Save disabled until a reason is typed, and an
          // officer should learn that before they open one rather than after —
          // but telling a trainer costs them a line about a button they will
          // never see.
          note={canBan || canManage ? 'Suspensions and removals take a typed reason' : undefined}
          tabs={
            <div className="-mx-1 flex gap-1 overflow-x-auto px-1">
              {tabs.map((t) => (
                <Link
                  key={t.id}
                  href={`/players?tab=${t.id}`}
                  aria-current={tab === t.id ? 'page' : undefined}
                  // Radius 0, and the tab you are on is marked by a red rule
                  // rather than a filled pill — the same 2px underline the
                  // console's top bar gives the section you are in, so "where
                  // am I" is answered the same way twice on one screen.
                  className={`flex min-h-[44px] items-center gap-2 whitespace-nowrap border-b-2 px-3 text-sm transition-colors ${
                    tab === t.id
                      ? 'border-[var(--color-accent)] text-[var(--text-primary)]'
                      : 'border-transparent text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  {t.label}
                  <span className="font-mono text-xs text-[var(--text-muted)]">{t.count}</span>
                </Link>
              ))}
            </div>
          }
          head={
            <tr className="border-b border-[var(--border)]">
              <th className={`${TH} text-left`}>Player</th>
              <th className={`${TH} text-left`}>Standing</th>
              <th className={`${TH} text-right`}>Singles</th>
              <th className={`${TH} text-right`}>Doubles</th>
              <th className={`${TH} text-right`}>Record</th>
              <th className={`${TH} text-left`}>Last seen</th>
              <th className={`${TH} text-right`}>Actions</th>
            </tr>
          }
          rows={rows}
        />
        </>
      )}
    </div>
  );
}
