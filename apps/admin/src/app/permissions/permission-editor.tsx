'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  Badge,
  Button,
  Card,
  Dialog,
  Input,
  Select,
  Textarea,
  filterPlayerOptions,
  useConfirm,
} from '@badminton/ui';
import { ChevronDown, ChevronRight, ShieldAlert } from 'lucide-react';
import { useToast } from '@/components/toast-provider';
import { setConsoleAccess, setPlayerPermissions } from '@/lib/actions';
// The one mapping between "what console access does this person have" and the
// three columns that store it, shared with the /players Edit dialog.
import { EXEC_ROLE_OPTIONS, accessForLevel, type ExecRole } from '@/lib/console-access';
// Labels and grouping for all 115. Its own module precisely so that pages
// which only need the vocabulary do not ship it; the editor is the one screen
// that genuinely does.
import { CAPABILITY_GATES } from '@badminton/shared/src/utils/capability-gates';
import {
  effectiveCapabilities,
  resolvePermissions,
  CAPABILITIES,
  EDITOR_OFFERABLE,
  PERMISSION_ROLES,
  PERMISSION_ROLE_LABELS,
  ROLE_DEFAULTS,
  type AccessLevel,
  type Area,
  type Capability,
  type PermissionRole,
} from '@/lib/permissions';

export interface PersonRow {
  id: string;
  name: string;
  email: string | null;
  title: string | null;
  // NULL is an ordinary member — somebody with no console access at all. They
  // are listed because giving them some is what this page is for, and their
  // three permission columns are empty by construction: no level means no gate
  // is ever reached, so nothing stored would be consulted.
  level: AccessLevel | null;
  // Standing, not level. A banned or deactivated executive still holds the
  // level and still cannot get through the front door, and a screen describing
  // access nobody has is worse than one that says so.
  canSignIn: boolean;
  role: string | null;
  grants: string[];
  revokes: string[];
}

// Words for the machine-readable path segments. The area and group keys are
// path segments — lower-case, no spaces — and putting them on screen raw would
// make this read like a config file rather than like a list of jobs.
const AREA_LABELS: Record<Area, string> = {
  players: 'Players',
  seasons: 'Seasons',
  sessions: 'Sessions',
  matches: 'Matches',
  challenges: 'Challenges',
  announcements: 'Announcements',
  tournaments: 'Tournaments',
  fees: 'Finances',
  legal: 'Legal',
  walkovers: 'Walkovers',
  disputes: 'Disputes',
  permissions: 'Permissions',
  audit: 'Audit log',
  ratings: 'Ratings',
  accounts: 'Accounts',
  platform: 'Platform',
};

const GROUP_LABELS: Record<string, string> = {
  manage: 'Setup',
  draw: 'Draw',
  results: 'Results',
  fees: 'Entry fees',
  expenses: 'Expenses',
  otherincome: 'Other income',
  clubfees: 'Club fees',
  reinstatements: 'Reinstatements',
  netposition: 'Net position',
  playerflags: 'Fee flags',
};

// TIER 2 APPEARS ONLY WHERE IT EARNS ITS KEEP. Tournaments is 38 of the 70
// offerable capabilities and is unreadable as one flat list; every other area
// is eight rows or fewer, and wrapping four rows in a collapsible group is a
// click that buys nothing. The threshold is a rendering decision, not a
// boundary — nothing about access depends on which tier a leaf is drawn at.
const FLAT_UNDER = 9;

// HOW MANY ORDINARY MEMBERS A SEARCH SHOWS AT ONCE. The list behind the search
// box is the whole club — a hundred people on staging — and a search that
// returns eighty rows has not answered anything. Typing another letter is the
// cheaper way to narrow it, and the count below the list says so.
const OTHERS_SHOWN = 20;

type Leaf = { capability: Capability; label: string; mode: 'page' | 'read' | 'write' };
// `page` is held apart from `leaves` rather than sorted to the front of them.
// It is not a peer of the data reads: it is the thing every other row in the
// area depends on, and the resolver prunes the lot when it is off. Giving it its
// own slot is what lets the area render it as a statement rather than as the
// first tick box in a list.
type Node = { key: string; label: string; page: Leaf | null; leaves: Leaf[]; children: Node[] };

// The tree, built once from the offerable list. Ordering follows
// EDITOR_OFFERABLE, which follows the exec baseline, which reads top-down as
// the club's own list of what an exec does.
function buildTree(): Node[] {
  const areas: Node[] = [];
  for (const capability of EDITOR_OFFERABLE) {
    const entry = CAPABILITY_GATES[capability];
    let area = areas.find((a) => a.key === entry.area);
    if (!area) {
      area = { key: entry.area, label: AREA_LABELS[entry.area], page: null, leaves: [], children: [] };
      areas.push(area);
    }
    const leaf: Leaf = { capability, label: entry.label, mode: entry.mode };
    if (entry.mode === 'page') area.page = leaf;
    else area.leaves.push(leaf);
  }
  for (const area of areas) {
    if (area.leaves.length < FLAT_UNDER) continue;
    for (const leaf of area.leaves) {
      const group = CAPABILITY_GATES[leaf.capability].group;
      if (group === null) continue;
      let child = area.children.find((c) => c.key === `${area.key}.${group}`);
      if (!child) {
        child = {
          key: `${area.key}.${group}`,
          label: GROUP_LABELS[group] ?? group,
          page: null,
          leaves: [],
          children: [],
        };
        area.children.push(child);
      }
      child.leaves.push(leaf);
    }
    // Only the leaves that found a group move down a tier; anything without one
    // stays where it is rather than vanishing.
    if (area.children.length > 0) {
      const grouped = new Set(area.children.flatMap((c) => c.leaves.map((l) => l.capability)));
      area.leaves = area.leaves.filter((l) => !grouped.has(l.capability));
    }
  }
  return areas;
}

const TREE = buildTree();

// `level` is the state a person is in before anybody composes them: they hold
// the capability because of the LEVEL they were given, and nothing is stored.
// Its own state rather than a shade of `role`, because the two answer different
// questions — "their job gives them this" and "the club gave them this level" —
// and the first click on a `level` cell is what turns one into the other.
type CellState = 'level' | 'role' | 'granted' | 'revoked' | 'off';

const CELL_TEXT: Record<CellState, string> = {
  level: '● from level',
  role: '● from role',
  granted: '+● granted',
  revoked: '⊘ revoked',
  off: '· off',
};

const CELL_CLASS: Record<CellState, string> = {
  // Info, not accent: --color-accent is the same #c00 as --color-danger, and
  // "they hold this because of their level" must not be the colour that means
  // "this has been taken away".
  level: 'text-[var(--color-info)] border-[var(--color-info)]',
  role: 'text-[var(--text-primary)] border-[var(--border-hover)]',
  granted: 'text-[var(--color-success)] border-[var(--color-success)]',
  revoked: 'text-[var(--color-danger)] border-[var(--color-danger)]',
  off: 'text-[var(--text-muted)] border-[var(--border)]',
};

const LEVEL_DEFAULT_OPTION = '';

const LEVEL_LABELS: Record<AccessLevel, string> = {
  admin: 'Admin',
  exec: 'Executive',
  trainer: 'Varsity trainer',
};

// THE DEFAULT STATE IS NAMED AFTER WHAT THE PERSON HAS, never after the absence
// of a stored role. It used to read "Unrestricted", which is engineering
// shorthand for permission_role IS NULL and, on a varsity trainer, an outright
// lie: the club owner opened the trainer's row and saw "Unrestricted" directly
// above "Effective access — 3 of 116". Their words were "it is very restricted",
// and they were right.
//
// The underlying concept is untouched — a NULL role still means "not composed",
// and every comment explaining why still says so. This is what the screen calls
// it.
const LEVEL_ACCESS_LABELS: Record<AccessLevel, string> = {
  admin: 'Admin access',
  exec: 'Executive access',
  trainer: 'Varsity access',
};

// WHAT THAT DEFAULT MEANS, IN WORDS, PER LEVEL. Two places describe the state
// somebody returns to when no role is set — the confirmation behind the select
// and the line under it — and both used to say "the executive baseline" because
// only an exec could be composed. On a trainer that is simply false, so the
// phrase is read from the row being edited rather than written into the prose.
const BASELINE_PHRASE: Record<AccessLevel, string> = {
  admin: 'every capability there is',
  exec: 'everything an executive can do',
  trainer: 'opening the roster, reading it, and writing varsity notes',
};

// Built per row for the same reason: the first option names the person's own
// level, so it cannot be a module constant any more.
function roleOptions(level: AccessLevel) {
  return [
    { value: LEVEL_DEFAULT_OPTION, label: LEVEL_ACCESS_LABELS[level] },
    ...PERMISSION_ROLES.map((role) => ({ value: role, label: PERMISSION_ROLE_LABELS[role] })),
  ];
}

const CONFIRM_PHRASE = 'HAND OUT PERMISSIONS';

const KNOWN = new Set<string>(CAPABILITIES);
const isKnown = (value: string): value is Capability => KNOWN.has(value);
const isRole = (value: string | null): value is PermissionRole =>
  (PERMISSION_ROLES as readonly string[]).includes(value ?? '');

const sameSet = (a: readonly string[], b: readonly string[]) =>
  JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

// The shared name-and-email matching, the same one the roster and the pickers
// use. An admin who learns that typing "chen" finds Chen on /players should not
// have to relearn it here.
function search(people: PersonRow[], query: string): PersonRow[] {
  if (query.trim() === '') return people;
  return filterPlayerOptions(people.map((p) => ({ ...p, meta: p.email })), query);
}

export function PermissionEditor({
  holders,
  others,
  viewerId,
  viewerIsAdmin,
  viewerCapabilities,
}: {
  holders: PersonRow[];
  others: PersonRow[];
  viewerId: string;
  viewerIsAdmin: boolean;
  viewerCapabilities: Capability[];
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [role, setRole] = useState<PermissionRole | null>(null);
  const [grants, setGrants] = useState<Capability[]>([]);
  const [revokes, setRevokes] = useState<Capability[]>([]);
  const [capabilitySearch, setCapabilitySearch] = useState('');
  const [memberSearch, setMemberSearch] = useState('');
  const [access, setAccess] = useState<ExecRole>('none');
  const [accessReason, setAccessReason] = useState('');
  const [expanded, setExpanded] = useState<string[]>([]);
  // The capability awaiting a typed confirmation, and what has been typed.
  const [dangerous, setDangerous] = useState<Capability | null>(null);
  const [typed, setTyped] = useState('');
  const [saving, startSaving] = useTransition();
  const [savingAccess, startSavingAccess] = useTransition();
  const { toast } = useToast();
  const confirm = useConfirm();
  const router = useRouter();

  const held = useMemo(() => new Set(viewerCapabilities), [viewerCapabilities]);
  const everyone = useMemo(() => [...holders, ...others], [holders, others]);
  const selected = everyone.find((p) => p.id === selectedId) ?? null;
  const selectedLevel = selected?.level ?? null;

  const seededRole = selected && isRole(selected.role) ? selected.role : null;

  // WHAT THEY HOLD RIGHT NOW, from the row as it is STORED. Computed before
  // anything else needs it because two things read it: the warning about what
  // saving would take away, and the check below on whether this row may be
  // edited at all.
  const before = effectiveCapabilities(
    selectedLevel,
    resolvePermissions(seededRole, selected?.grants ?? [], selected?.revokes ?? []),
  );

  // Every reason this person's permissions cannot be edited, in the order they
  // should be read. Composed rather than collapsed into one boolean so the
  // panel can SAY which one applies — "read-only" with no reason is the state
  // that generates support conversations.
  const readOnlyReason =
    selected === null
      ? null
      : selected.id === viewerId
        ? 'This is you. A permissions screen where the row you are editing might be your own is where misreadings live — ask another admin to change yours.'
        : selected.level === 'admin'
          ? 'Admins are superusers by level. They hold every capability and nothing stored here is consulted for them — a role on this row would look like a narrowing and would not be one. Make them an executive first.'
          : // GRANT CLOSURE, SHOWN AS A LOCKED ROW RATHER THAN AS A FAILED SAVE.
            // setPlayerPermissions refuses any edit to somebody holding a
            // capability the actor does not (check 3), so this is the same
            // answer arriving earlier. It also carries weight now that the tree
            // is live for a person on their level default: the first click there
            // seeds their WHOLE effective set as grants, and the seed cannot be
            // filtered down to what the actor holds — filtering it would turn a
            // grant into a silent revoke of everything else. Locking the row is
            // what makes the unfiltered seed safe.
            [...before].some((capability) => !held.has(capability))
            ? 'They already hold capabilities you do not, so you cannot change their permissions. Ask an admin.'
            : null;
  const composable = selected !== null && selectedLevel !== null && readOnlyReason === null;

  function select(person: PersonRow) {
    setSelectedId(person.id);
    setRole(isRole(person.role) ? person.role : null);
    // Filtered to the vocabulary this build has. A stored element the code no
    // longer knows resolves to nothing anyway — the editor must not offer to
    // re-save it as though it meant something.
    setGrants(person.grants.filter(isKnown));
    setRevokes(person.revokes.filter(isKnown));
    setAccess(accessForLevel(person.level));
    setAccessReason('');
    setCapabilitySearch('');
    setExpanded([]);
  }

  const dirty =
    selected !== null &&
    (role !== seededRole ||
      !sameSet(grants, selected.grants) ||
      !sameSet(revokes, selected.revokes));

  const base: readonly Capability[] = role === null ? [] : ROLE_DEFAULTS[role];

  // The panel that answers the question the stored row no longer answers by
  // itself. Computed by the SAME effectiveCapabilities the gates call, on the
  // SAME resolver — not by a second reading of the ticks on screen, which is
  // how an editor comes to show one thing while the console does another.
  const permissions = resolvePermissions(role, grants, revokes);
  const effective = effectiveCapabilities(selectedLevel, permissions);

  function stateOf(capability: Capability): CellState {
    // Nothing is stored, so nothing can be a grant or a revoke: what they hold,
    // they hold because of their level. Reading it off `effective` rather than
    // off a baseline list of its own is what makes the tree and the summary
    // above it agree by construction — they are the same set.
    if (role === null) return effective.has(capability) ? 'level' : 'off';
    if (grants.includes(capability)) return 'granted';
    if (revokes.includes(capability)) return 'revoked';
    return base.includes(capability) ? 'role' : 'off';
  }

  /**
   * The triple as it would have to be STORED for the ticks on screen to survive
   * a save — which, for somebody on their level default, means turning that
   * default into a hand-picked set first.
   *
   * SEEDED FROM THE RESOLVED EFFECTIVE SET, and getting that backwards is the
   * one way this feature could hurt somebody. A varsity trainer who ticks one
   * extra capability must end up with their three plus that one; seeding from
   * empty would end them up with one, turning a grant into a near-total revoke.
   * That is the same hazard the resolver's "no role but a grant" rule exists to
   * prevent, arriving from the editor instead. The `.page` keys come along for
   * free precisely because the seed is the resolved set — it already satisfies
   * the resolver's own invariant, so nothing it keeps is pruned on the way back.
   *
   * The base is `custom`, whose defaults are empty, so every capability lands in
   * `grants` and the stored row reads back as exactly what was chosen. Borrowing
   * one of the four VP names instead would file the person under a job they do
   * not have and put them inside the blast radius of any later change to what
   * that job means.
   */
  function seedCustom(): { role: PermissionRole; grants: Capability[]; revokes: Capability[] } {
    return { role: 'custom', grants: [...effective], revokes: [] };
  }

  function asCustom(): { role: PermissionRole; grants: Capability[]; revokes: Capability[] } {
    if (role !== null) return { role, grants, revokes };
    return seedCustom();
  }

  // ONE CLICK WRITES EXACTLY ONE DELTA ELEMENT, and only the legal transition.
  // If the base gives it, the only move is on ⇄ revoked; if it does not, the
  // only move is off ⇄ granted. That is what stops a redundant grant ever being
  // stored, and it is why there is no third branch here to get wrong.
  //
  // On a level default the click ALSO performs the switch above, so the first
  // tick does what the person pressing it expects instead of nothing. That was
  // the club owner's report — "i cant edit varsity trainer?" — and it was fair:
  // the cells were inert until a role was picked, with nothing on screen saying
  // that picking one was the way in.
  function toggle(capability: Capability) {
    const next = asCustom();
    const inBase = (ROLE_DEFAULTS[next.role] as readonly Capability[]).includes(capability);
    setRole(next.role);
    if (inBase) {
      setRevokes(
        next.revokes.includes(capability)
          ? next.revokes.filter((c) => c !== capability)
          : [...next.revokes, capability],
      );
      setGrants(next.grants);
      return;
    }
    setGrants(
      next.grants.includes(capability)
        ? next.grants.filter((c) => c !== capability)
        : [...next.grants, capability],
    );
    setRevokes(next.revokes);
  }

  function onCellClick(capability: Capability) {
    // The one capability that can replicate itself. A tick box is the wrong
    // weight of control for "this person can hand out anything they hold,
    // including this", so turning it ON costs a typed phrase; turning it off
    // stays one click, because taking access away is the safe direction.
    if (capability === 'permissions.write' && stateOf(capability) === 'off') {
      setDangerous(capability);
      setTyped('');
      return;
    }
    toggle(capability);
  }

  async function changeRole(value: string) {
    if (value === LEVEL_DEFAULT_OPTION) {
      const ok = await confirm({
        title: selectedLevel ? `Back to ${LEVEL_ACCESS_LABELS[selectedLevel].toLowerCase()}?` : 'Back to their level’s access?',
        message: (
          <>
            <span className="text-[var(--text-primary)] font-medium">{selected?.name}</span> will
            get {selectedLevel ? BASELINE_PHRASE[selectedLevel] : 'their level’s access'} again.
            Both the grants and the revokes below are cleared.
          </>
        ),
        confirmLabel: selectedLevel ? `Use ${LEVEL_ACCESS_LABELS[selectedLevel].toLowerCase()}` : 'Use their level’s access',
      });
      if (!ok) return;
      setRole(null);
      setGrants([]);
      setRevokes([]);
      return;
    }
    // Choosing Hand-picked explicitly is the same act the first tick performs,
    // so it starts from the same place: what they hold today. From a NAMED role
    // as much as from a level default — the base is about to become empty, so
    // without the seed "convert this to a hand-picked set" would silently take
    // away everything the role was giving them.
    if (value === 'custom') {
      const next = seedCustom();
      setRole(next.role);
      setGrants(next.grants);
      setRevokes(next.revokes);
      return;
    }
    setRole(value as PermissionRole);
  }

  // WHAT PRESSING SAVE WOULD TAKE AWAY, worked out from the row as it is
  // STORED — the same resolver, run a second time on the values this screen was
  // seeded with (see `before` above).
  //
  // A role REPLACES the base rather than adding to it, so the first NAMED role
  // picked for somebody on their level default drops their whole baseline. On an
  // exec that is the point of the feature and the confirmation above says so.
  // On a trainer it is a surprise: giving them Tournaments so they can run a
  // session also takes away varsity notes, which is the one thing their level
  // existed to give them. The semantics are correct and deliberately not
  // special-cased in the resolver — a trainer whose baseline survived
  // composition would give the level ladder a second meaning — so the editor is
  // where it has to be visible, and visible BEFORE the save rather than after.
  //
  // Against the STORED row, not against the level's baseline: the question is
  // what this EDIT removes. An exec who was narrowed to Finance months ago
  // should see the delta they are making now, not the fifty-odd capabilities
  // somebody else took away then. It keeps working across the switch to Custom
  // for the same reason — the seed changes what is on screen, never what is
  // stored, so the comparison still has both sides.
  const losing = [...before].filter((capability) => !effective.has(capability));

  const orphanRevokes = revokes.filter((capability) => !base.includes(capability));

  const query = capabilitySearch.trim().toLowerCase();
  const matches = (leaf: Leaf) =>
    query === '' ||
    leaf.label.toLowerCase().includes(query) ||
    leaf.capability.includes(query);

  function allLeaves(node: Node): Leaf[] {
    return [
      ...(node.page ? [node.page] : []),
      ...node.leaves,
      ...node.children.flatMap(allLeaves),
    ];
  }

  function visibleLeaves(node: Node): Leaf[] {
    return allLeaves(node).filter(matches);
  }

  function isOpen(node: Node): boolean {
    // A search opens everything it matched. Making somebody expand three tiers
    // to find the row they just searched for is the same as not having search.
    return query !== '' || expanded.includes(node.key);
  }

  function toggleOpen(key: string) {
    setExpanded((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }

  /** Roll-up for a header. Display only — a header is never a control. */
  function chipFor(node: Node): string {
    const leaves = allLeaves(node);
    const on = leaves.filter((l) => effective.has(l.capability)).length;
    const granted = leaves.filter((l) => stateOf(l.capability) === 'granted').length;
    const revoked = leaves.filter((l) => stateOf(l.capability) === 'revoked').length;
    const parts = [`${on} of ${leaves.length}`];
    if (granted > 0) parts.push(`+${granted} granted`);
    if (revoked > 0) parts.push(`−${revoked} revoked`);
    return parts.join(' · ');
  }

  // "Turn on everything here" is a BUTTON, never the header itself. A header
  // that toggled would need an aggregate state — half on, half off — and an
  // aggregate state is a thing a person can misread. These write the individual
  // leaves, one delta element each, exactly as clicking them would, and they
  // perform the same switch to a hand-picked set that a click does.
  //
  // "Reads" means everything that is not a WRITE, so the page comes with them.
  // A set of reads without the area's page is a set the resolver deletes on the
  // way in, and a button that silently produced one would be a button that does
  // nothing.
  function setAll(node: Node, on: boolean, readsOnly: boolean) {
    const next = asCustom();
    const roleBase = ROLE_DEFAULTS[next.role] as readonly Capability[];
    const nextGrants = new Set(next.grants);
    const nextRevokes = new Set(next.revokes);
    const leaves = allLeaves(node)
      .filter((l) => (readsOnly ? l.mode !== 'write' : true))
      .filter((l) => held.has(l.capability))
      .filter((l) => l.capability !== 'permissions.write');
    for (const leaf of leaves) {
      if (roleBase.includes(leaf.capability)) {
        if (on) nextRevokes.delete(leaf.capability);
        else nextRevokes.add(leaf.capability);
      } else if (on) {
        nextGrants.add(leaf.capability);
      } else {
        nextGrants.delete(leaf.capability);
      }
    }
    setRole(next.role);
    setGrants([...nextGrants]);
    setRevokes([...nextRevokes]);
  }

  function save() {
    if (!selected) return;
    startSaving(async () => {
      try {
        const res = await setPlayerPermissions(selected.id, { role, grants, revokes });
        if (!res.ok) { toast(res.error, 'error'); return; }
        toast(
          role === null
            ? `${selected.name} is back to ${selectedLevel ? LEVEL_ACCESS_LABELS[selectedLevel].toLowerCase() : 'their level’s access'}`
            : `${selected.name} now holds ${effective.size} of ${CAPABILITIES.length} capabilities`,
          'success',
        );
        router.refresh();
        setSelectedId(null);
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to save permissions', 'error');
      }
    });
  }

  // GIVING SOMEBODY THE CONSOLE, OR TAKING IT AWAY. The selection is dropped on
  // success rather than kept: the person moves between the two lists, their
  // stored composition may have been cleared on the way, and a panel still
  // showing what was seeded from the old row would be describing a row that no
  // longer exists.
  function applyAccess() {
    if (!selected) return;
    startSavingAccess(async () => {
      try {
        const res = await setConsoleAccess(selected.id, access, accessReason);
        if (!res.ok) { toast(res.error, 'error'); return; }
        toast(
          access === 'none'
            ? `${selected.name} no longer has console access`
            : `${selected.name} — ${EXEC_ROLE_OPTIONS.find((o) => o.value === access)?.label}`,
          'success',
        );
        setSelectedId(null);
        router.refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to change console access', 'error');
      }
    });
  }

  const cell = (leaf: Leaf) => {
    const state = stateOf(leaf.capability);
    const mine = held.has(leaf.capability);
    const disabled = !composable || !mine;
    const isDangerous = leaf.capability === 'permissions.write';
    return (
      <div
        key={leaf.capability}
        className="flex items-center justify-between gap-3 py-2 pl-6 pr-3 border-t border-[var(--border)]"
      >
        <div className="min-w-0">
          <p className="text-sm text-[var(--text-primary)] flex items-center gap-2">
            {isDangerous && <ShieldAlert className="w-3.5 h-3.5 text-[var(--color-danger)]" />}
            {leaf.label}
            <Badge variant="neutral">{leaf.mode}</Badge>
          </p>
          <p className="font-mono text-[11px] text-[var(--text-muted)]">{leaf.capability}</p>
          {!mine && (
            <p className="text-[11px] text-[var(--text-muted)]">You do not hold this.</p>
          )}
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={() => onCellClick(leaf.capability)}
          className={`flex-shrink-0 min-h-[36px] px-3 rounded-[8px] border text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${CELL_CLASS[state]}`}
        >
          {CELL_TEXT[state]}
        </button>
      </div>
    );
  };

  // THE PAGE ROW. Its own shape at the top of the area, not a cell in the list
  // below it, because it is not one more thing you can tick: it is the switch
  // the rest of the area hangs off. Everything else here is deleted by the
  // resolver while this is off, and a row that looked like a peer of the data
  // reads would make that look like a bug rather than the rule.
  const pageCell = (leaf: Leaf) => {
    const state = stateOf(leaf.capability);
    const mine = held.has(leaf.capability);
    const on = effective.has(leaf.capability);
    return (
      <div className="flex items-center justify-between gap-3 py-2.5 pl-6 pr-3 border-t border-[var(--border)] bg-[var(--bg-elevated)]">
        <div className="min-w-0">
          <p className="text-sm font-medium text-[var(--text-primary)]">{leaf.label}</p>
          <p className="text-[11px] text-[var(--text-muted)]">
            {on
              ? 'They can open this section. What they see and do inside it is set below.'
              : 'Off — nothing else in this area applies, whatever is set below.'}
          </p>
          <p className="font-mono text-[11px] text-[var(--text-muted)]">{leaf.capability}</p>
          {!mine && <p className="text-[11px] text-[var(--text-muted)]">You do not hold this.</p>}
        </div>
        <button
          type="button"
          disabled={!composable || !mine}
          onClick={() => toggle(leaf.capability)}
          className={`flex-shrink-0 min-h-[36px] px-3 rounded-[8px] border text-xs font-medium transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${CELL_CLASS[state]}`}
        >
          {CELL_TEXT[state]}
        </button>
      </div>
    );
  };

  const renderNode = (node: Node, depth: number) => {
    const leaves = visibleLeaves(node);
    if (leaves.length === 0) return null;
    const open = isOpen(node);
    return (
      <div key={node.key} className={depth === 0 ? 'border-t border-[var(--border)]' : ''}>
        <div className="flex items-center gap-2 px-3 py-2.5">
          {/* Expands, NEVER toggles. The chip beside it is a read-out. */}
          <button
            type="button"
            onClick={() => toggleOpen(node.key)}
            className="flex items-center gap-2 min-h-[36px] text-left flex-1 min-w-0"
          >
            {open ? <ChevronDown className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
            <span className={depth === 0 ? 'text-sm font-medium text-[var(--text-primary)]' : 'text-sm text-[var(--text-secondary)]'}>
              {node.label}
            </span>
            <span className="text-xs text-[var(--text-muted)] truncate">{chipFor(node)}</span>
          </button>
          {composable && (
            <div className="flex items-center gap-1 flex-shrink-0">
              <Button variant="ghost" onClick={() => setAll(node, true, true)}>Reads</Button>
              <Button variant="ghost" onClick={() => setAll(node, true, false)}>All</Button>
              <Button variant="ghost" onClick={() => setAll(node, false, false)}>None</Button>
            </div>
          )}
        </div>
        {open && (
          <div>
            {node.page && matches(node.page) && pageCell(node.page)}
            {node.leaves.filter(matches).map(cell)}
            {node.children.map((child) => renderNode(child, depth + 1))}
          </div>
        )}
      </div>
    );
  };

  const personRow = (person: PersonRow) => (
    <div key={person.id} className="settings-row">
      <div className="min-w-0">
        <div className="settings-row-label">
          {person.name}
          {person.id === viewerId && (
            <span className="ml-2 text-[var(--text-muted)]">(you)</span>
          )}
        </div>
        <div className="settings-row-hint">
          {person.title ? `${person.title} · ` : ''}
          {describe(person)}
          {person.level !== null && !person.canSignIn && ' · cannot sign in'}
        </div>
      </div>
      <div className="settings-row-control">
        <Button
          variant={selectedId === person.id ? 'secondary' : 'ghost'}
          onClick={() => select(person)}
        >
          {selectedId === person.id ? 'Editing' : 'Open'}
        </Button>
      </div>
    </div>
  );

  const shownHolders = search(holders, memberSearch);
  // EVERY MEMBER IS HERE; ONLY THE PEOPLE WITH THE CONSOLE ARE LISTED UNPROMPTED.
  // The club is a hundred people and four of them can open this screen, so a
  // list of all of them would bury the answer to the question the page is
  // named after. Searching is what brings the rest in, which is also the act
  // somebody performs when they have a specific person in mind — the only
  // reason to look at an ordinary member here at all.
  const matchedOthers = memberSearch.trim() === '' ? [] : search(others, memberSearch);
  const shownOthers = matchedOthers.slice(0, OTHERS_SHOWN);

  return (
    <div className="space-y-6">
      <Card padding={false}>
        <p className="settings-section-desc px-4 pt-4">
          {viewerIsAdmin
            ? 'Console access is the level somebody holds; capabilities are what they may do once they have it. Leave a role unset and they keep everything their level has always had. You can only hand out capabilities you hold yourself. Every change is recorded in the audit log.'
            : 'A role decides what somebody STARTS from; grants and revokes adjust it person by person. Leave a role unset and they keep the full access their level has always had. You can only hand out capabilities you hold yourself. Every change is recorded in the audit log.'}
        </p>
        <div className="px-4 pt-3 pb-1">
          <Input
            label="Find a member"
            placeholder={
              viewerIsAdmin
                ? 'Search the whole club by name or email'
                : 'Search by name or email'
            }
            value={memberSearch}
            onChange={(e) => setMemberSearch(e.target.value)}
          />
        </div>

        {shownHolders.length > 0 && (
          <>
            <p className="px-4 pt-3 pb-1 text-xs font-medium text-[var(--text-muted)]">
              With console access
            </p>
            {shownHolders.map(personRow)}
          </>
        )}

        {!viewerIsAdmin ? (
          memberSearch.trim() !== '' && shownHolders.length === 0 && (
            <p className="px-4 py-3 text-xs text-[var(--text-muted)]">
              Nobody with console access matches “{memberSearch.trim()}”.
            </p>
          )
        ) : memberSearch.trim() === '' ? (
          <p className="px-4 py-3 text-xs text-[var(--text-muted)]">
            {others.length} other {others.length === 1 ? 'member has' : 'members have'} no console
            access. Search for one by name to give them some.
          </p>
        ) : (
          <>
            {shownOthers.length > 0 && (
              <>
                <p className="px-4 pt-3 pb-1 text-xs font-medium text-[var(--text-muted)]">
                  No console access
                </p>
                {shownOthers.map(personRow)}
              </>
            )}
            {matchedOthers.length > shownOthers.length && (
              <p className="px-4 py-3 text-xs text-[var(--text-muted)]">
                {matchedOthers.length - shownOthers.length} more match “{memberSearch.trim()}”. Type
                a little more to narrow it.
              </p>
            )}
            {shownHolders.length === 0 && matchedOthers.length === 0 && (
              <p className="px-4 py-3 text-xs text-[var(--text-muted)]">
                Nobody matches “{memberSearch.trim()}”.
              </p>
            )}
          </>
        )}
      </Card>

      {selected && (
        <Card padding={false}>
          <div className="px-4 py-4 space-y-4">
            <div>
              <h2 className="text-sm font-medium text-[var(--text-primary)]">{selected.name}</h2>
              <p className="text-xs text-[var(--text-muted)]">
                {selectedLevel ? LEVEL_LABELS[selectedLevel] : 'No console access'}
                {selected.email ? ` · ${selected.email}` : ''}
              </p>
            </div>

            {/* CONSOLE ACCESS — the half of this page's subtitle it could not
                answer until now. It is a LEVEL, not a capability: admins alone
                hand it out (the hard floor in player-field-access.ts, which no
                grant reaches), so the control is not drawn for anybody else and
                the server refuses it again regardless. */}
            {viewerIsAdmin && (
              <div className="rounded-[8px] border border-[var(--border)] p-3 space-y-3">
                <p className="text-xs font-medium text-[var(--text-primary)]">Console access</p>
                {selected.id === viewerId ? (
                  <p className="text-[11px] text-[var(--text-muted)] max-w-[64ch]">
                    You cannot change your own. This is the only page that hands console access out,
                    so an admin who takes their own away loses the screen they would need to put it
                    back — and the database only protects the last admin holding a passkey, which is
                    not the same promise. Ask another admin.
                  </p>
                ) : (
                  <>
                    <Select
                      label="Level"
                      options={EXEC_ROLE_OPTIONS}
                      value={access}
                      onChange={(e) => setAccess(e.target.value as ExecRole)}
                      className="max-w-sm"
                    />
                    {selectedLevel !== null && !selected.canSignIn && (
                      <p className="text-[11px] text-[var(--color-danger)]">
                        They hold this level but cannot sign in — banned, suspended, awaiting
                        approval or deactivated. Their access starts working when their account
                        does.
                      </p>
                    )}
                    {access !== accessForLevel(selected.level) && (
                      <>
                        <p className="text-[11px] text-[var(--text-muted)] max-w-[64ch]">
                          {access === 'none'
                            ? 'They lose the console entirely, and anything set below is cleared with it — a stored role nobody can reach would sit dormant and wake up if they were ever promoted again.'
                            : selected.level === null
                              ? 'They get the console, starting from everything that level has always had. Narrow it below afterwards.'
                              : access === 'admin'
                                ? 'Admins hold every capability by level, so anything set below stops being consulted and is cleared.'
                                : 'Their level changes. Anything set below still applies — the resolver does not look at levels.'}
                        </p>
                        <Textarea
                          label="Reason (required)"
                          value={accessReason}
                          onChange={(e) => setAccessReason(e.target.value)}
                          placeholder="Why is this changing?"
                        />
                        <div className="flex justify-end">
                          <Button
                            onClick={applyAccess}
                            loading={savingAccess}
                            disabled={accessReason.trim().length < 2}
                          >
                            Apply console access
                          </Button>
                        </div>
                      </>
                    )}
                  </>
                )}
              </div>
            )}

            {selectedLevel === null ? (
              <p className="text-sm text-[var(--text-muted)] max-w-[64ch]">
                An ordinary member. Capabilities are what somebody with the console may do inside
                it, so there is nothing to set here until they have one.
              </p>
            ) : (
              <>
                {readOnlyReason && (
                  <p className="text-sm text-[var(--text-muted)] max-w-[64ch]">{readOnlyReason}</p>
                )}

                {composable && (
                  <>
                    <Select
                      label="Starts from"
                      options={roleOptions(selectedLevel)}
                      value={role ?? LEVEL_DEFAULT_OPTION}
                      onChange={(e) => void changeRole(e.target.value)}
                      className="max-w-sm"
                    />
                    <p className="text-xs text-[var(--text-muted)]">
                      {role === null
                        ? `${LEVEL_ACCESS_LABELS[selectedLevel]} — ${BASELINE_PHRASE[selectedLevel]}. Nothing is stored; tick anything below and they become a hand-picked set starting from exactly this.`
                        : role === 'custom'
                          ? `Hand-picked — ${grants.length} ${grants.length === 1 ? 'capability' : 'capabilities'} chosen one at a time, starting from no job at all.`
                          : grants.length === 0 && revokes.length === 0
                            ? `${PERMISSION_ROLE_LABELS[role]}, unadjusted.`
                            : `Custom — ${PERMISSION_ROLE_LABELS[role]} with ${grants.length} granted and ${revokes.length} revoked.`}
                    </p>
                  </>
                )}

                {/* ORPHANED REVOKES — a revoke of something the current role does
                    not give. Inert today, and KEPT rather than tidied away: if the
                    role ever regains that capability, the revoke should bite again,
                    and deleting it now would be a silent future re-grant nobody
                    chose. Surfaced instead, with a one-click clear, so that "inert"
                    is a state somebody can see rather than one they discover. */}
                {composable && orphanRevokes.length > 0 && (
                  <div className="rounded-[8px] border border-[var(--border)] p-3">
                    <p className="text-xs text-[var(--text-primary)]">
                      {orphanRevokes.length} revoke{orphanRevokes.length === 1 ? '' : 's'} the{' '}
                      {role === null ? 'current' : PERMISSION_ROLE_LABELS[role]} role does not give
                    </p>
                    <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                      {orphanRevokes.map((c) => CAPABILITY_GATES[c].label).join(' · ')} — doing
                      nothing today, and will apply again if the role regains them.
                    </p>
                    <div className="mt-2">
                      <Button
                        variant="ghost"
                        onClick={() => setRevokes((prev) => prev.filter((c) => !orphanRevokes.includes(c)))}
                      >
                        Clear them
                      </Button>
                    </div>
                  </div>
                )}

                {/* ALWAYS VISIBLE. The cost of a model where a role is a name and
                    the deltas are two lists is that the stored row no longer says
                    what a person can do. This panel is where that is paid back, and
                    it is computed by the same function the gates call. */}
                <div className="rounded-[8px] border border-[var(--border)] bg-[var(--bg-elevated)] p-3">
                  <p className="text-xs font-medium text-[var(--text-primary)]">
                    Effective access — {effective.size} of {CAPABILITIES.length}
                  </p>
                  <p className="mt-2 text-[11px] text-[var(--text-muted)] leading-relaxed">
                    {effective.size === 0
                      ? 'Nothing. This person can sign in and reach the dashboard, and no section at all.'
                      : [...effective]
                          .map((capability) => CAPABILITY_GATES[capability].label)
                          .join(' · ')}
                  </p>
                </div>

                {/* WHAT SAVING WOULD TAKE AWAY. The panel above answers "what will
                    they hold"; this one answers the question that actually catches
                    people out, which is "what do they hold RIGHT NOW that they
                    would stop holding". They are not the same question and only the
                    second one is a warning. See the note on `losing` above for why
                    a trainer needs it more sharply than an exec does. */}
                {composable && losing.length > 0 && (
                  <div className="rounded-[8px] border border-[var(--color-danger)] p-3">
                    <p className="text-xs font-medium text-[var(--color-danger)]">
                      Saving takes away {losing.length}{' '}
                      {losing.length === 1 ? 'capability' : 'capabilities'} they hold today
                    </p>
                    <p className="mt-1 text-[11px] text-[var(--text-muted)] leading-relaxed">
                      {losing.map((capability) => CAPABILITY_GATES[capability].label).join(' · ')}
                    </p>
                  </div>
                )}

                {/* THE TREE IS ALWAYS HERE, and that is what changed. It used to be
                    hidden for anybody on their level default, on the grounds that
                    every cell would read "off" beside a panel saying 71 of 116 —
                    two true statements that look like a contradiction. The
                    contradiction was real; hiding the tree was the wrong end of it.
                    Showing the level's own capabilities in their own state fixes
                    the disagreement instead, and leaves the common case — which is
                    everybody, on day one — looking like something you can edit. */}
                {composable && (
                  <Input
                    label="Search capabilities"
                    placeholder="Filter by name or by dotted path"
                    value={capabilitySearch}
                    onChange={(e) => setCapabilitySearch(e.target.value)}
                  />
                )}
              </>
            )}
          </div>

          {composable && TREE.map((node) => renderNode(node, 0))}

          {composable && (
            <div className="flex items-center justify-end gap-2 px-4 py-4 border-t border-[var(--border)]">
              <Button variant="ghost" onClick={() => select(selected)} disabled={saving}>
                Reset
              </Button>
              <Button onClick={save} loading={saving} disabled={!dirty}>
                Save permissions
              </Button>
            </div>
          )}
        </Card>
      )}

      <Dialog
        open={dangerous !== null}
        onClose={() => setDangerous(null)}
        title="Hand out permissions?"
      >
        <div className="space-y-4">
          <p className="text-sm text-[var(--text-secondary)]">
            This person will be able to hand out any capability they themselves hold, including
            this one. They will not be able to hand out anything they do not hold — but within
            that bound there is no further limit, and the audit log is the only trace.
          </p>
          <Input
            label={`Type ${CONFIRM_PHRASE} to confirm`}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
          />
          <div className="flex items-center justify-end gap-2">
            <Button variant="ghost" onClick={() => setDangerous(null)}>Cancel</Button>
            <Button
              disabled={typed !== CONFIRM_PHRASE}
              onClick={() => {
                if (dangerous) toggle(dangerous);
                setDangerous(null);
              }}
            >
              Grant it
            </Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}

/**
 * The one-line summary on a person's row in the list.
 *
 * THE ROLE IS CONSULTED BEFORE THE LEVEL IS ALLOWED TO ANSWER FOR ITSELF, and
 * that ordering is what changed when trainers became composable. This used to
 * return "roster and varsity notes" for any trainer, because a trainer could not
 * hold a role — now they can, and answering from the level would describe the
 * baseline of somebody who has been composed out of it.
 */
function describe(person: PersonRow): string {
  if (person.level === null) return 'No console access';
  // Still answered from the level, and still correctly: an admin's stored role
  // is never consulted, so there is nothing else it could say.
  if (person.level === 'admin') return 'Admin access — holds everything';
  if (!isRole(person.role)) {
    return `${LEVEL_ACCESS_LABELS[person.level]} — ${BASELINE_PHRASE[person.level]}`;
  }
  const level = LEVEL_LABELS[person.level];
  const label = PERMISSION_ROLE_LABELS[person.role];
  // "Adjusted" means a delta on top of a named job. A hand-picked set is ALL
  // deltas by construction — its base is empty — so the count that means
  // "somebody changed this afterwards" for the other four roles means nothing
  // here, and reporting it would call every hand-picked row adjusted.
  if (person.role === 'custom') return `${level} — ${label}`;
  const adjusted = person.grants.length + person.revokes.length;
  return adjusted === 0 ? `${level} — ${label}` : `${level} — ${label}, adjusted`;
}
