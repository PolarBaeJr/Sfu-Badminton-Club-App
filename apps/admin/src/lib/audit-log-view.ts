// How the audit log is READ. Pure, React-free, and deliberately separate from
// the component that renders it — every function here is a claim about the data
// that can be checked in isolation, and ./__tests__/audit-log-view.test.ts is
// where the claims are checked.
//
// THE CONSTRAINT THAT SHAPES ALL OF IT: `audit_logs.action_type` is TEXT with no
// enum, no check constraint and no registry. Migrations write it, server actions
// write it, and a feature that lands next week writes a value nothing here has
// seen (`player_permissions_changed` and `player_portfolio_changed` are the most
// recent two). So nothing below may answer "I do not recognise this" with
// "therefore it does not exist": an unknown type gets a neutral tone, lands in
// the `other` group, and stays in every unfiltered view. A row that disappears
// from an audit trail because a colour lookup missed is the worst bug this
// screen can have.

export interface AuditLogEntry {
  id: string;
  created_at: string;
  action_type: string;
  target_type: string | null;
  target_id: string | null;
  reason: string | null;
  actor: { full_name: string } | null;
  /**
   * The person the entry is ABOUT, resolved by the page for the rows whose
   * target is a player. Absent for every other target type, and absent for a
   * player row that no longer exists — a subject uuid with no name is still a
   * complete entry and must still render.
   */
  subject?: { full_name: string; avatar_url: string | null } | null;
}

/* -------------------------------------------------------------------------- */
/* Action tone                                                                 */
/* -------------------------------------------------------------------------- */

export type ActionTone = 'success' | 'warning' | 'danger' | 'neutral';

// Matched against the action's WORDS, not the whole string, so `match_voided`
// and `expense_removed` are read by their verb rather than by a substring that
// happens to appear in the middle of a noun. First list that contains one of
// the action's words wins.
const TONE_WORDS: { tone: Exclude<ActionTone, 'neutral'>; words: string[] }[] = [
  {
    tone: 'danger',
    words: [
      'banned', 'voided', 'removed', 'rejected', 'deleted', 'suspend', 'suspended',
      'anomaly', 'reversed',
      // The old claim strip. Somebody losing console access without asking is
      // not a neutral event, and a neutral badge is what it wore.
      'stripped',
    ],
  },
  {
    tone: 'success',
    words: [
      'created', 'added', 'approved', 'reinstated', 'restored', 'confirmed',
      'resolved', 'activated', 'registered', 'verified', 'paid', 'resumed',
      'recorded', 'reimbursed', 'sent',
    ],
  },
  {
    tone: 'warning',
    words: [
      'updated', 'changed', 'edited', 'ended', 'expired', 'rotated', 'required',
      'adjusted', 'converted', 'merged', 'unpaid', 'archived',
      // 00132's claim decision. Warning rather than danger because it can KEEP
      // privileges as well as hold them, and rather than neutral because either
      // way somebody's console access was decided by a machine and an admin has
      // something to look at.
      'reviewed',
    ],
  },
];
// `marked` is deliberately in none of them: `fee_marked_paid` and
// `fee_marked_unpaid` are opposites that share it, and whichever list held it
// would swallow the other's verb. `cancelled` likewise — the two actions using
// it, `account_deletion_cancelled` and the member's own
// `self_deletion_cancelled`, are both the good outcome, so neutral is the honest
// tone and no list needs to claim the word.

const words = (actionType: string) => actionType.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

/**
 * The Badge variant an action wears.
 *
 * `neutral` is the answer for two different situations and that is on purpose:
 * an action we recognise but have no opinion about (`fee_waived`), and an action
 * we have never seen. Both get a real pill in a muted tone rather than nothing —
 * "no treatment" reads as a rendering bug, and a new action type appearing in
 * the log should look ordinary, not broken.
 */
export function actionTone(actionType: string): ActionTone {
  const w = words(actionType);
  for (const rule of TONE_WORDS) {
    if (w.some((word) => rule.words.includes(word))) return rule.tone;
  }
  return 'neutral';
}

/** `fee_waived` → `FEE WAIVED`. The raw value, made readable, never abridged. */
export function actionLabel(actionType: string): string {
  return actionType.replace(/_/g, ' ').toUpperCase();
}

/* -------------------------------------------------------------------------- */
/* Grouping                                                                    */
/* -------------------------------------------------------------------------- */

export type AuditGroupId =
  | 'members' | 'matches' | 'money' | 'sessions' | 'tournaments' | 'club' | 'other';

/**
 * The tab taxonomy, in the order the tabs are drawn AND the order they are
 * tested — deliberately one list rather than two, because a grouping whose
 * display order differs from its precedence order is a grouping nobody can
 * predict from looking at it.
 *
 * Money sits above sessions/tournaments/club so that `tournament_fee_tier_created`
 * and `season_fees_updated` are filed as money: an officer asking "what happened
 * to the club's money this term" wants those rows, and the tournament tab is
 * where they would never look.
 *
 * These are WORDS of the action type, matched the same way tones are. Prefix
 * matching was the obvious first idea and is wrong here: `other_income_added`
 * and `manual_fee_added` would file under prefixes `other` and `manual`, which
 * are not categories of anything.
 */
const GROUPS: { id: AuditGroupId; label: string; words: string[] }[] = [
  // `permission` and `baseline` are here so the custom baselines (00093) file
  // beside `player_permissions_changed`, which already lands here on the word
  // `player`. Without them a baseline being created, edited or deleted would sit
  // in Other, one tab away from the per-person rows that same edit wrote.
  // `roster`, `claim` and `privileges` are here for 00132's
  // roster_claim_privileges_reviewed and for the older
  // roster_row_claimed_privileges_stripped it replaces. Neither shares a word
  // with anything above, so both used to file under OTHER — an entry saying
  // somebody's admin had just been taken away, sitting one tab from every other
  // thing that ever happened to that member.
  //
  // `deletion`, `reactivated`, `inactive` and `rating` are the same complaint,
  // for the rows a MEMBER and the nightly jobs write about themselves:
  // `self_deletion_requested`, `self_deletion_cancelled`, `self_rating_seeded`,
  // `self_reactivated`, `auto_marked_inactive` and `auto_purged_inactive` share
  // no word with anything above, so the whole self-service and automated half of
  // a member's history filed under OTHER while the console's half — including
  // `account_deletion_cancelled`, the exact counterpart of two of them — filed
  // under Members. `rating` collides with nothing (no action type has ever
  // contained it); `tier` deliberately is NOT here, because it would steal
  // `tournament_fee_tier_*` from Money, which the note below says must not
  // happen.
  { id: 'members',     label: 'Members',     words: ['player', 'players', 'account', 'varsity', 'reliability', 'suspend', 'passkey', 'permission', 'permissions', 'baseline', 'roster', 'claim', 'privileges', 'deletion', 'reactivated', 'inactive', 'rating', 'ratings'] },
  { id: 'matches',     label: 'Matches',     words: ['match', 'challenge', 'walkover', 'dispute'] },
  { id: 'money',       label: 'Money',       words: ['fee', 'fees', 'payment', 'expense', 'income', 'reimbursed'] },
  { id: 'sessions',    label: 'Sessions',    words: ['session'] },
  { id: 'tournaments', label: 'Tournaments', words: ['tournament'] },
  { id: 'club',        label: 'Club',        words: ['season', 'seasons', 'announcement', 'platform', 'legal', 'waiver', 'template', 'event'] },
];

export const ALL_GROUP = 'all';

/** Which tab an action belongs under. Anything unrecognised is `other`. */
export function groupOf(actionType: string): AuditGroupId {
  const w = words(actionType);
  for (const group of GROUPS) {
    if (w.some((word) => group.words.includes(word))) return group.id;
  }
  return 'other';
}

export interface AuditTab {
  id: string;
  label: string;
  count: number;
}

/**
 * The filter's options, derived from the rows on screen.
 *
 * A hard-coded tab list would either show empty tabs for things this club does
 * not do, or — much worse — quietly omit a tab for a group that exists, leaving
 * those rows reachable only through All. So: count first, then emit the tabs
 * that counted something. `All` is always present and always the total, which is
 * what makes the header honest: the tab counts sum to it exactly, including the
 * `Other` bucket holding types nobody has categorised yet.
 */
export function buildTabs(logs: AuditLogEntry[]): AuditTab[] {
  const counts = new Map<AuditGroupId, number>();
  for (const log of logs) {
    const id = groupOf(log.action_type);
    counts.set(id, (counts.get(id) ?? 0) + 1);
  }

  const tabs: AuditTab[] = [{ id: ALL_GROUP, label: 'All', count: logs.length }];
  for (const group of GROUPS) {
    const count = counts.get(group.id) ?? 0;
    if (count > 0) tabs.push({ id: group.id, label: group.label, count });
  }
  const other = counts.get('other') ?? 0;
  if (other > 0) tabs.push({ id: 'other', label: 'Other', count: other });
  return tabs;
}

/**
 * Keep the selection pointing at a tab that is actually on screen.
 *
 * The tab set is data-derived, so it changes underneath the selection: pick
 * `Money`, then switch season to a term with no fee activity, and the selected
 * tab is gone — leaving an empty table, no highlighted tab and nothing to click
 * back to. Falling back to All is the only reading that is never a dead end.
 */
export function resolveTab(tabs: AuditTab[], requested: string): string {
  return tabs.some((t) => t.id === requested) ? requested : ALL_GROUP;
}

/* -------------------------------------------------------------------------- */
/* Search                                                                      */
/* -------------------------------------------------------------------------- */

// Underscores become spaces on BOTH sides, so `fee_waived`, `fee waived` and
// `waived fee` all reach the same rows. Somebody searching an audit log types
// what they saw on screen, and what they saw was the humanised label.
const normalize = (s: string) => s.toLowerCase().replace(/[_\s]+/g, ' ').trim();

/**
 * Whether a row survives the search box.
 *
 * The haystack includes the reason. That is the point of the field — the log is
 * searched for "why", far more often than for "what" — and it is why the reason
 * column is never abridged anywhere on this screen.
 */
export function matchesQuery(log: AuditLogEntry, query: string): boolean {
  const q = normalize(query);
  if (!q) return true;
  const hay = normalize(
    [
      log.actor?.full_name ?? 'system',
      log.action_type,
      log.target_type ?? '',
      log.target_id ?? '',
      // The subject's name, when the page resolved one. "What did we do to
      // Aiko" is the second question anybody brings to an audit log, and
      // without this it could only be answered by a uuid.
      log.subject?.full_name ?? '',
      log.reason ?? '',
      log.id,
    ].join(' ')
  );
  // Every word must land somewhere, so a second word narrows the result the way
  // a reader expects rather than widening it the way an OR would.
  return q.split(' ').every((word) => hay.includes(word));
}

/* -------------------------------------------------------------------------- */
/* Sort                                                                        */
/* -------------------------------------------------------------------------- */

export type SortOrder = 'newest' | 'oldest';

/**
 * Chronological, both directions, and total.
 *
 * `created_at` is an ISO timestamptz string, so lexicographic comparison is
 * chronological — but only for rows written with the same offset, and two rows
 * inserted in the same statement share a timestamp exactly. The id tie-break is
 * what stops those from swapping places between renders and making the table
 * look like it is churning.
 */
export function sortLogs<T extends AuditLogEntry>(logs: T[], order: SortOrder): T[] {
  return [...logs].sort((a, b) => {
    const at = Date.parse(a.created_at);
    const bt = Date.parse(b.created_at);
    const cmp = at === bt ? a.id.localeCompare(b.id) : at - bt;
    return order === 'oldest' ? cmp : -cmp;
  });
}

/** Tab, then search, then order — the whole client-side pipeline in one place. */
export function visibleLogs<T extends AuditLogEntry>(
  logs: T[],
  { tab, query, order }: { tab: string; query: string; order: SortOrder }
): T[] {
  const filtered = logs.filter(
    (log) => (tab === ALL_GROUP || groupOf(log.action_type) === tab) && matchesQuery(log, query)
  );
  return sortLogs(filtered, order);
}

/* -------------------------------------------------------------------------- */
/* Presentation of individual cells                                            */
/* -------------------------------------------------------------------------- */

/**
 * "A. Mercer" — the officer column, at table density.
 *
 * A null actor is a scheduled job or a database trigger, not a missing name, so
 * it says System rather than blanking. Nothing is DERIVED from the abbreviation:
 * the full name rides along in a `title` on the cell and is written out in full
 * on the phone card, because two officers sharing an initial is exactly the kind
 * of ambiguity an audit log must not introduce.
 */
export function abbreviateActor(fullName: string | null | undefined): string {
  const name = (fullName ?? '').trim();
  if (!name) return 'System';
  const [first, ...rest] = name.split(/\s+/);
  if (!first) return 'System';
  if (rest.length === 0) return first;
  return `${first.charAt(0)}. ${rest.join(' ')}`;
}

const startOfLocalDay = (d: Date) => {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
};

const clockOf = (d: Date) =>
  `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;

/**
 * "Today 19:04", "Yesterday 21:12", "2 days ago", "28 Jul 2026".
 *
 * Relative for the first week because that is the window this screen is read in
 * — somebody is checking what just happened — and absolute after it, because
 * "43 days ago" is a number nobody can convert. Days are counted between LOCAL
 * MIDNIGHTS rather than by dividing an elapsed duration: 23:50 and 00:10 are a
 * minute apart and are still yesterday and today, and rounding the midnight
 * difference also absorbs the 23- and 25-hour days at a DST boundary.
 *
 * Today and yesterday keep their clock time; older rows do not, and the exact
 * timestamp is carried in the cell's `title` and its `<time dateTime>` so the
 * precise value is never actually lost.
 *
 * `now` is a parameter, never `new Date()` inside, so this stays pure — and so
 * the caller can withhold it until after mount, which is what keeps the server's
 * timezone from rendering "Yesterday" into HTML the browser then disagrees with.
 */
export function relativeWhen(iso: string, now: Date): string {
  const then = new Date(iso);
  // An unparseable timestamp is shown verbatim. It is still a record.
  if (Number.isNaN(then.getTime())) return iso;

  const days = Math.round(
    (startOfLocalDay(now).getTime() - startOfLocalDay(then).getTime()) / 86_400_000
  );

  if (days <= 0) return `Today ${clockOf(then)}`;
  if (days === 1) return `Yesterday ${clockOf(then)}`;
  if (days < 7) return `${days} days ago`;
  return then.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * The entry's own id, shortened for the REF column.
 *
 * The mockup drew a human reference (`AL-4192`); there is no such column and
 * inventing a numbering scheme for an append-only table would be a fiction the
 * database could not back. The row's uuid is the real reference, and its first
 * segment is enough to quote to somebody who then looks it up.
 */
export function shortRef(id: string): string {
  return (id ?? '').split('-')[0] || '—';
}
