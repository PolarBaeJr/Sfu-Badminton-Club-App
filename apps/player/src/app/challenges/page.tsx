import { createServerSupabaseClient, getCurrentPlayer } from '@/lib/supabase-server';
import {
  MATCH_FORMAT_LABELS,
  formatRelativeTime,
  pickOne,
  CHALLENGE_STATUS_LABEL,
  CHALLENGE_STATUS_TAG,
  getAccountStanding,
} from '@badminton/shared';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { Plus, ChevronRight, Swords, CalendarClock, Hourglass } from 'lucide-react';
import { PageHeader, AvatarChip } from '@badminton/ui';
import { StandingNote } from '@/components/standing-notice';
import { getChallengeRules } from '@/lib/challenge-settings';
import {
  expiryState,
  challengeQuota,
  partitionChallenges,
  challengeSearchKeys,
  ACTIVE_CHALLENGE_STATUSES,
  type ExpiryState,
} from '@/lib/challenge-rules';
import { ChallengeSections } from './challenge-sections';

export default async function ChallengesPage() {
  const player = await getCurrentPlayer();
  if (!player) redirect('/login');
  // The history stays — a suspended member should still be able to read what
  // they played. Only the "issue one" entry points go, since createChallenge
  // would refuse them.
  const standing = getAccountStanding(player);

  const supabase = await createServerSupabaseClient();

  // Three independent reads, so they go together rather than one after another.
  // Nothing here feeds anything else — the rules and the quota count are both
  // keyed on the signed-in member alone — and awaiting them in sequence would
  // cost three round-trips for a screen that needs one.
  const [rules, myChallengesRes, activeIssuedRes] = await Promise.all([
    // The club's live rules, not the constants in packages/shared: the caps are
    // configurable (00048/00053) and the database re-reads platform_settings on
    // every validate_challenge_creation call. See challenge-settings.ts.
    getChallengeRules(supabase),

    supabase
      .from('challenge_participants')
      // expires_at, scheduled_date and scheduled_time have been on challenges
      // since 00001 and were never selected, so the list could not say when a
      // challenge lapses or when it is being played — the two things a member
      // opens this screen to find out. handle arrives with 00092 and is rendered
      // beside every name.
      .select('id, confirmation_status, challenge:challenges(id, created_by, type, format, rated_flag, status, created_at, expires_at, scheduled_date, scheduled_time, creator:players!challenges_created_by_fkey(id, full_name, handle, avatar_url), challenge_participants(id, player_id, role, team_side, player:players(id, full_name, handle)))')
      .eq('player_id', player.id)
      // No server-side order: challenge_participants has no timestamp of its own,
      // and the previous `referencedTable: 'challenges'` order sorted *within* the
      // embedded resource — which is to-one, so it did nothing. Rows therefore came
      // back arbitrarily, and a LIMIT over an unordered set silently dropped
      // whichever challenges the planner happened not to return. Order below, on
      // the embedded created_at, once the rows are in hand.
      .limit(200),

    // The quota, counted at the database rather than over the 200 rows above.
    // That list is capped and unordered, so a long-standing member's open
    // challenge can simply not be in it — and a quota that undercounts is the
    // exact bug this meter exists to prevent, promising a slot the server will
    // refuse. Same predicate as validate_challenge_creation, over the same
    // table; challenges_select is USING (TRUE) for authenticated, so no
    // escalation is needed.
    supabase
      .from('challenges')
      .select('id', { count: 'exact', head: true })
      .eq('created_by', player.id)
      .in('status', [...ACTIVE_CHALLENGE_STATUSES]),
  ]);

  const myChallenges = myChallengesRes.data;

  type CP = NonNullable<typeof myChallenges>[number];
  type Person = { id: string; full_name: string; handle?: string | null; avatar_url?: string | null };
  type Challenge = {
    id: string;
    created_by: string;
    type: string;
    format: string;
    rated_flag: boolean;
    status: string;
    created_at: string;
    expires_at: string | null;
    scheduled_date: string | null;
    scheduled_time: string | null;
    creator: Person | Person[] | null;
    challenge_participants: { id: string; player_id: string; role: string; team_side: string; player: Person | Person[] | null }[];
  };

  function pickChallenge(cp: CP): Challenge | null {
    const c = cp.challenge as unknown;
    if (!c) return null;
    return Array.isArray(c) ? (c[0] ?? null) : (c as Challenge);
  }
  // Newest first, once — every section below derives from this, so they all
  // inherit a sensible order instead of the arbitrary one the query returned.
  const all = (myChallenges ?? [])
    .map((cp) => ({ cp, c: pickChallenge(cp) }))
    .filter((x): x is { cp: CP; c: Challenge } => Boolean(x.c))
    .sort((a, b) => new Date(b.c.created_at).getTime() - new Date(a.c.created_at).getTime());

  // The split lives in challenge-rules.ts and is unit-tested there: it is the
  // one piece of this screen that was silently wrong (lapsed challenges leaked
  // into the live sections) and the one a reader cannot check by looking.
  const { incoming, active, outgoing, archived } = partitionChallenges(
    all.map((row) => ({ ...row, challenge: { ...row.c, confirmation_status: row.cp.confirmation_status } })),
    player.id,
  );

  // One clock for the whole render. Calling Date.now() inside each card would
  // let two cards a millisecond apart disagree about whether the same deadline
  // has passed.
  const now = Date.now();

  const quota = challengeQuota(activeIssuedRes.count ?? 0, rules.maxActive);

  // The quota is the club's rule, so it gates the entry points the same way
  // standing does — validate_challenge_creation refuses a fourth challenge, and
  // finding that out after picking an opponent and a format is the bad version
  // of being told. `canIssue` is display only; the database still decides.
  const canIssue = standing.ok && !quota.full;
  const quotaFullNote = `You have ${quota.used} of ${quota.max} challenges open. Play or cancel one to issue another.`;

  // Who is in reach, for the empty state. Both limits are genuinely enforced by
  // validate_challenge_creation (00053) whatever their value, so this is not a
  // guess about whether the rule runs — it is a judgement about whether it is
  // worth saying. 9999 is the number 00053 chose to mean "a settings row went
  // missing, do not start refusing challenges on a figure nobody picked", and
  // repeating it back as "within 9999 Elo" would dress a non-limit up as a rule.
  //
  // Deliberately NOT on the cards or the header: the check is creator-vs-
  // opponent, so it only means something once there is a pair. That is
  // /challenges/new's job, and this screen has no opponent in hand.
  const NO_LIMIT = 9999;
  const reach = [
    rules.ladderRange < NO_LIMIT ? `${rules.ladderRange} ladder positions` : null,
    rules.eloRange < NO_LIMIT ? `${rules.eloRange} Elo` : null,
  ].filter(Boolean);
  const reachClause = reach.length ? ` — from opponents within ${reach.join(' and ')}` : '';

  /** The deadline chip. Absent entirely on a challenge that can no longer expire. */
  function ExpiryChip({ state }: { state: ExpiryState }) {
    if (!state.label) return null;
    return (
      <span
        className={state.kind === 'open' ? 'tag tag-outline' : state.kind === 'urgent' ? 'tag tag-gold' : 'tag tag-red'}
        // "3h left" does not say left until what. The colour answers that only
        // for people who can see it, so the sentence is here as well.
        title={state.kind === 'expired' ? 'Past its reply window' : 'Time left to answer'}
      >
        <Hourglass size={11} style={{ verticalAlign: '-1px', marginRight: 4 }} />
        {state.label}
      </span>
    );
  }

  /** "Kiera Watanabe · @kiera" as elements, so the handle can be dimmed. */
  function Named({ person, fallback = 'Unknown' }: { person: Person | null | undefined; fallback?: string }) {
    const name = person?.full_name?.trim() || fallback;
    return (
      <>
        {name}
        {person?.handle && (
          <span className="muted" style={{ fontWeight: 400 }}> · @{person.handle}</span>
        )}
      </>
    );
  }

  function ChallengeCard({ c, awaitingYou }: { c: Challenge; awaitingYou: boolean }) {
    const creator = pickOne(c.creator);
    const isMine = c.created_by === player.id;
    const expiry = expiryState(c.expires_at, c.status, now);
    const roster = c.challenge_participants
      .map((p) => ({ ...p, person: pickOne(p.player) }))
      .filter((p) => p.person);
    const youSide = roster.find((p) => p.person?.id === player.id)?.team_side;
    const opponents = roster.filter((p) => p.team_side !== youSide);
    const teammates = roster.filter((p) => p.team_side === youSide && p.person?.id !== player.id);

    return (
      <Link
        href={`/challenges/${c.id}`}
        className="press"
        style={{
          display: 'block',
          padding: 18,
          border: '1px solid var(--line)',
          borderRadius: 'var(--r-lg)',
          background: 'var(--surface)',
          // The one card that is a question addressed to the reader gets the
          // accent edge. Everything else on this screen is something they have
          // already answered or are waiting on somebody else for.
          ...(awaitingYou ? { borderLeft: '3px solid var(--red)' } : null),
        }}
      >
        <div className="row" style={{ marginBottom: 12, fontSize: 12, flexWrap: 'wrap', gap: 8 }}>
          <span className="tag tag-red">{(c.type || '').toUpperCase()}</span>
          <span className="tag">{MATCH_FORMAT_LABELS[c.format as keyof typeof MATCH_FORMAT_LABELS] || c.format}</span>
          {c.rated_flag && <span className="tag tag-gold">RATED</span>}
          <ExpiryChip state={expiry} />
          <span className="mono muted" style={{ marginLeft: 'auto' }}>
            {formatRelativeTime(c.created_at)}
          </span>
        </div>

        <div className="row" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
          <div className="row" style={{ gap: 10, flex: 1, minWidth: 200 }}>
            <AvatarChip name={creator?.full_name ?? '?'} id={creator?.id} src={creator?.avatar_url} size="md" />
            <div style={{ minWidth: 0 }}>
              <div style={{ fontWeight: 600, fontSize: 14 }}>
                {isMine ? <>You challenged</> : <><Named person={creator} /> challenged you</>}
              </div>
              <div className="mono muted" style={{ fontSize: 11, marginTop: 2 }}>
                {opponents.length > 0 ? (
                  <>vs {opponents.map((o, i) => (
                    <span key={o.id}>{i > 0 && ' & '}<Named person={o.person} /></span>
                  ))}</>
                ) : (
                  'Awaiting roster'
                )}
                {teammates.length > 0 && (
                  <> · with {teammates.map((t, i) => (
                    <span key={t.id}>{i > 0 && ', '}<Named person={t.person} /></span>
                  ))}</>
                )}
              </div>
              {c.scheduled_date && (
                // Only when the challenge actually carries one. Most do not:
                // scheduled_date is nullable and the create form leaves it
                // empty, so a "Not scheduled" line would be noise on the
                // majority of cards.
                <div className="mono muted" style={{ fontSize: 11, marginTop: 2 }}>
                  <CalendarClock size={11} style={{ verticalAlign: '-1px', marginRight: 4 }} />
                  {c.scheduled_date}
                  {c.scheduled_time && ` · ${c.scheduled_time.slice(0, 5)}`}
                </div>
              )}
            </div>
          </div>
          {/* The status the database holds, always — the expiry chip above is a
              reading of the clock and never overrides it. Nothing in the system
              actually moves a lapsed challenge to 'expired' (see
              challenge-rules.ts), so a card can honestly read "Proposed" and
              "Expired" at once. */}
          <span className={CHALLENGE_STATUS_TAG[c.status] ?? 'tag'}>{CHALLENGE_STATUS_LABEL[c.status] ?? c.status}</span>
          <ChevronRight size={16} className="text-[var(--mute)]" />
        </div>
      </Link>
    );
  }

  // Everyone named on a challenge, for the search key. Creator included: on one
  // nobody has answered yet they may be the only other person on the card.
  function namesOn(c: Challenge): string[] {
    return challengeSearchKeys([pickOne(c.creator), ...c.challenge_participants.map((p) => pickOne(p.player))]);
  }

  const toItems = (list: { cp: CP; c: Challenge }[], awaitingYou = false) =>
    list.map(({ cp, c }) => ({ id: cp.id, players: namesOn(c), card: <ChallengeCard c={c} awaitingYou={awaitingYou} /> }));

  const sections = [
    { title: 'Awaiting your answer', items: toItems(incoming, true) },
    { title: 'Active', items: toItems(active) },
    { title: 'Your challenges', items: toItems(outgoing) },
    {
      title: 'Archived',
      // Completed and rejected/cancelled both live here; each card keeps its
      // own status badge (Completed / Rejected / Cancelled) so they stay
      // distinguishable within the single archived group.
      //
      // Sorted singles-then-doubles, newest first within each. Simply
      // concatenating the two lists grouped by status instead, which is
      // already on every card, and left the dates unordered.
      items: toItems(
        [...archived].sort((a, b) =>
          a.c.type !== b.c.type
            ? a.c.type === 'singles' ? -1 : 1
            : new Date(b.c.created_at).getTime() - new Date(a.c.created_at).getTime())
      ),
    },
  ];

  return (
    <div data-screen-label="Challenges">
      <PageHeader
        title="Challenges"
        sub="Issue, accept, and track challenges. Whatever is waiting on you sits at the top — answer it so the queue clears."
        actions={
          standing.ok ? (
            canIssue ? (
              <Link href="/challenges/new" className="btn btn-primary">
                <Plus size={14} /> New challenge
              </Link>
            ) : (
              // Not a disabled button: a control that cannot be pressed and does
              // not say why is the thing this screen keeps being asked to fix.
              <p className="mono muted" style={{ fontSize: 12, maxWidth: '34ch', margin: 0 }} role="status">
                {quotaFullNote}
              </p>
            )
          ) : (
            <StandingNote standing={standing} activity="New challenges" />
          )
        }
      />

      {/* The club's rules, stated before they are hit rather than quoted back as
          a refusal. All three numbers come from platform_settings, which is what
          validate_challenge_creation reads — so what this strip says and what
          the server does cannot drift apart.

          Withheld from a gated member: their limit is not the cap, it is their
          standing, and the StandingBanner has already said so. */}
      {standing.ok && (
        // .stat-strip is used bare elsewhere (my-stats, the admin dashboard) —
        // it draws its own hairlines and cell padding, so wrapping it in a
        // .card-base would double both.
        <div className="stat-strip" style={{ marginBottom: 20 }}>
          <div className="stat">
            <span className="stat-label">Open challenges</span>
            {/* --mono, not the .stat-value default of --display: these three are
                quantities read against each other and a limit, and tabular
                figures are what keeps "2 / 3" from shifting as the count does. */}
            <span className="stat-value" style={{ fontFamily: 'var(--mono)' }}>
              {quota.used}
              <span className="muted" style={{ fontSize: '0.55em' }}> / {quota.max}</span>
            </span>
            <div className="capacity-bar" style={{ marginTop: 8 }}>
              <div
                className={`fill${quota.full ? ' full' : quota.ratio >= 0.66 ? ' warn' : ''}`}
                style={{ width: `${Math.round(quota.ratio * 100)}%` }}
              />
            </div>
          </div>
          <div className="stat">
            <span className="stat-label">Awaiting you</span>
            <span className="stat-value" style={{ fontFamily: 'var(--mono)' }}>{incoming.length}</span>
          </div>
          <div className="stat">
            <span className="stat-label">Reply window</span>
            <span className="stat-value" style={{ fontFamily: 'var(--mono)' }}>{rules.expiryHours}h</span>
          </div>
        </div>
      )}

      {all.length === 0 ? (
        <div className="card-base">
          <div className="empty">
            <span className="empty-icon"><Swords size={20} /></span>
            <div className="empty-title">No challenges yet</div>
            <p className="empty-hint">
              Pick someone from the ladder and send one. You can have {quota.max} open at a time,
              and an unanswered challenge stands for {rules.expiryHours} hours{reachClause}.
            </p>
            {canIssue ? (
              <Link href="/challenges/new" className="btn btn-primary">
                <Plus size={14} /> Issue your first challenge
              </Link>
            ) : standing.ok ? (
              <p className="mono muted" style={{ fontSize: 12, margin: 0 }} role="status">{quotaFullNote}</p>
            ) : (
              <StandingNote standing={standing} activity="New challenges" />
            )}
          </div>
        </div>
      ) : (
        <ChallengeSections sections={sections} />
      )}
    </div>
  );
}
