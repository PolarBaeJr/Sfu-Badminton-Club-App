'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import {
  Badge,
  Button,
  Card,
  Dialog,
  EmptyState,
  Input,
  SearchFilter,
  Select,
  Textarea,
  cn,
  filterPlayerOptions,
  useConfirm,
} from '@badminton/ui';
import { AlertTriangle, ArrowLeft, ChevronDown, ChevronRight, ShieldAlert } from 'lucide-react';
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

const ALL_KEYS = TREE.flatMap((area) => [area.key, ...area.children.map((c) => c.key)]);

// `level` is the state a person is in before anybody composes them: they hold
// the capability because of the LEVEL they were given, and nothing is stored.
// Its own state rather than a shade of `role`, because the two answer different
// questions — "their job gives them this" and "the club gave them this level" —
// and the first click on a `level` cell is what turns one into the other.
type CellState = 'level' | 'role' | 'granted' | 'revoked' | 'off';

// THE THREE SEGMENTS, and the whole of the model they stand for. `inherit` is
// no delta at all — whatever the base gives, they get; `on` is a grant; `off` is
// a revoke. Five cell states collapse onto three segments because two pairs of
// them are the SAME stored row read against different bases: "from level" and
// "from role" are both "nothing stored for this", and so is an `off` under a
// role that never gave it.
type Segment = 'inherit' | 'off' | 'on';

const SEGMENT_OF: Record<CellState, Segment> = {
  level: 'inherit',
  role: 'inherit',
  off: 'inherit',
  granted: 'on',
  revoked: 'off',
};

// The active segment is FILLED and the other two are not, so a row reads as one
// answer rather than as three buttons. Green is the only colour here that means
// anything on its own — it is the same green the counts use for "they hold this".
const SEGMENTS: readonly { value: Segment; label: string; activeClass: string }[] = [
  { value: 'inherit', label: 'Inherit', activeClass: 'bg-[var(--surface-2)] text-[var(--mute)]' },
  { value: 'off', label: 'Off', activeClass: 'bg-[var(--surface-3)] text-[var(--ink)]' },
  { value: 'on', label: 'On', activeClass: 'bg-[var(--win)] text-[var(--bg)]' },
];

// page has no badge. The design called for purple and the console has no purple
// token — and adding one is the single thing ds-bundle/guidelines/admin-console
// forbids outright ("No new colour values", "Badge — success/warning/danger/
// neutral only"). It costs nothing here: the page row is already the one row in
// an area drawn on its own surface with its own prose, so it is told apart by
// shape rather than by hue.
const SCOPE_BADGE: Record<Leaf['mode'], 'info' | 'warning' | null> = {
  page: null,
  read: 'info',
  write: 'warning',
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

/** 11px/700 uppercase — the console's one micro-label, used for every field name here. */
const MICRO = 'text-[11px] font-bold uppercase tracking-[0.12em]';

type FilterMode = 'all' | 'granted' | 'changed';

const MODES: readonly { value: FilterMode; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'granted', label: 'Granted' },
  { value: 'changed', label: 'Changed' },
];

/**
 * A row of hairline-joined buttons where exactly one is filled.
 *
 * Not a Tabs and not a Switch: the tri-state below has three answers and no
 * "current view", and the filter above it has three that are peers. Both are one
 * question with one answer, which is what makes them the same control.
 */
function Segmented<T extends string>({
  value,
  options,
  onChange,
  disabled,
  label,
  className,
}: {
  value: T;
  options: readonly { value: T; label: string; activeClass?: string }[];
  onChange: (next: T) => void;
  disabled?: boolean;
  label: string;
  className?: string;
}) {
  return (
    <div role="group" aria-label={label} className={cn('inline-flex flex-shrink-0 border border-[var(--line)]', className)}>
      {options.map((option) => {
        const active = option.value === value;
        return (
          <button
            key={option.value}
            type="button"
            aria-pressed={active}
            disabled={disabled}
            onClick={() => onChange(option.value)}
            className={cn(
              MICRO,
              'px-2.5 min-h-[36px] border-l border-[var(--line)] first:border-l-0 transition-colors disabled:opacity-40 disabled:cursor-not-allowed',
              active
                ? option.activeClass ?? 'bg-[var(--surface-3)] text-[var(--ink)]'
                : 'text-[var(--mute)] hover:bg-[var(--surface-2)] hover:text-[var(--ink)]',
            )}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
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
  const [mode, setMode] = useState<FilterMode>('all');
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
    setMode('all');
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

  // WHAT INHERITING WOULD GIVE THEM — the answer the `Inherit` segment stands
  // for, said out loud beside it. Off a level default that is the level's own
  // baseline (nothing is stored, so `effective` IS the baseline); under a role
  // it is what the role gives.
  const inherits = (capability: Capability) =>
    role === null ? effective.has(capability) : base.includes(capability);

  // DIFFERS FROM SAVED, measured in what the person can DO rather than in what
  // the row stores. Switching somebody from their level default to a hand-picked
  // set of exactly the same capabilities changes the row and changes nothing
  // about them, and marking sixty rows amber for it would bury the one row that
  // did move.
  const changed = (capability: Capability) => before.has(capability) !== effective.has(capability);

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

  // ONE CLICK WRITES EXACTLY ONE DELTA ELEMENT, and only the one the chosen
  // segment needs. `inherit` clears both lists; `on` stores a grant ONLY where
  // the base does not already give it; `off` stores a revoke ONLY where it does.
  // That is what stops a redundant grant ever being stored — the same rule the
  // old two-state cell enforced by having nowhere else to go, said explicitly
  // now that there are three places to go.
  //
  // On a level default the click ALSO performs the switch to a hand-picked set,
  // so the first segment pressed does what the person pressing it expects
  // instead of nothing. That was the club owner's report — "i cant edit varsity
  // trainer?" — and it was fair: the cells were inert until a role was picked,
  // with nothing on screen saying that picking one was the way in.
  function setCell(capability: Capability, target: Segment) {
    const next = asCustom();
    const inBase = (ROLE_DEFAULTS[next.role] as readonly Capability[]).includes(capability);
    const nextGrants = next.grants.filter((c) => c !== capability);
    const nextRevokes = next.revokes.filter((c) => c !== capability);
    if (target === 'on' && !inBase) nextGrants.push(capability);
    if (target === 'off' && inBase) nextRevokes.push(capability);
    setRole(next.role);
    setGrants(nextGrants);
    setRevokes(nextRevokes);
  }

  function onCellClick(capability: Capability, target: Segment) {
    // The one capability that can replicate itself. A segment is the wrong
    // weight of control for "this person can hand out anything they hold,
    // including this", so turning it ON costs a typed phrase; every other move
    // stays one click, because taking access away is the safe direction — and so
    // is putting back something a revoke had taken off a role that still gives
    // it, which is why the test is the cell's state and not its effect.
    if (capability === 'permissions.write' && target === 'on' && stateOf(capability) === 'off') {
      setDangerous(capability);
      setTyped('');
      return;
    }
    setCell(capability, target);
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
    // Choosing Hand-picked explicitly is the same act the first segment press
    // performs, so it starts from the same place: what they hold today. From a
    // NAMED role as much as from a level default — the base is about to become
    // empty, so without the seed "convert this to a hand-picked set" would
    // silently take away everything the role was giving them.
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
  const gaining = [...effective].filter((capability) => !before.has(capability));

  const orphanRevokes = revokes.filter((capability) => !base.includes(capability));

  const query = capabilitySearch.trim().toLowerCase();
  // A search or a mode OPENS everything it matched. Making somebody expand three
  // tiers to find the row they just filtered for is the same as not having a
  // filter — so while either is active the expand/collapse toggle has nothing
  // left to do, and is disabled rather than left looking broken.
  const filtering = query !== '' || mode !== 'all';
  const matches = (leaf: Leaf) =>
    (query === '' ||
      leaf.label.toLowerCase().includes(query) ||
      leaf.capability.includes(query)) &&
    (mode === 'all' ||
      (mode === 'granted' ? effective.has(leaf.capability) : changed(leaf.capability)));

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

  const shownLeaves = TREE.reduce((total, area) => total + visibleLeaves(area).length, 0);

  function isOpen(node: Node): boolean {
    return filtering || expanded.includes(node.key);
  }

  function toggleOpen(key: string) {
    setExpanded((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));
  }

  const allExpanded = ALL_KEYS.every((key) => expanded.includes(key));

  // "Turn on everything here" is a BUTTON, never the header itself. A header
  // that toggled would need an aggregate state — half on, half off — and an
  // aggregate state is a thing a person can misread. These write the individual
  // leaves, one delta element each, exactly as pressing their segments would,
  // and they perform the same switch to a hand-picked set that a press does.
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

  const segments = (leaf: Leaf, state: CellState) => (
    <Segmented
      label={leaf.label}
      value={SEGMENT_OF[state]}
      options={SEGMENTS}
      disabled={!composable || !held.has(leaf.capability)}
      onChange={(target) => onCellClick(leaf.capability, target)}
    />
  );

  const cell = (leaf: Leaf, dimmed: boolean) => {
    const state = stateOf(leaf.capability);
    const mine = held.has(leaf.capability);
    const isDangerous = leaf.capability === 'permissions.write';
    const badge = SCOPE_BADGE[leaf.mode];
    return (
      <div
        key={leaf.capability}
        className={cn(
          'group flex items-center justify-between gap-3 py-2 pl-4 pr-3 border-t border-t-[var(--line)] border-l-[3px] transition-opacity',
          changed(leaf.capability) ? 'border-l-[var(--color-warning)]' : 'border-l-transparent',
          dimmed && 'opacity-45',
        )}
      >
        <div className="min-w-0">
          <p className="flex flex-wrap items-center gap-2 text-sm text-[var(--ink)]">
            {isDangerous && <ShieldAlert className="w-3.5 h-3.5 flex-shrink-0 text-[var(--red)]" />}
            {leaf.label}
            {badge && <Badge variant={badge}>{leaf.mode}</Badge>}
            {SEGMENT_OF[state] === 'inherit' && (
              <span className="text-[11px] text-[var(--mute)]">
                from {role === null ? 'level' : 'role'} · {inherits(leaf.capability) ? 'on' : 'off'}
              </span>
            )}
          </p>
          {/* THE DOTTED PATH IS THERE WHEN IT IS WANTED AND SILENT WHEN IT IS
              NOT. It is what an engineer greps for and what nobody else needs to
              read 116 times, so it is drawn at zero opacity and always occupies
              its line — fading it in rather than revealing it keeps every row
              the same height as the pointer crosses the list. */}
          <p className="font-mono text-[11px] text-[var(--mute)] opacity-0 transition-opacity duration-150 group-hover:opacity-50 group-focus-within:opacity-50">
            {leaf.capability}
          </p>
          {!mine && (
            <p className="text-[11px] text-[var(--mute)]">You do not hold this.</p>
          )}
        </div>
        {segments(leaf, state)}
      </div>
    );
  };

  // THE PAGE ROW. Its own shape at the top of the area, not a cell in the list
  // below it, because it is not one more thing you can tick: it is the switch
  // the rest of the area hangs off. Everything else here is deleted by the
  // resolver while this is off, and a row that looked like a peer of the data
  // reads would make that look like a bug rather than the rule. It is also the
  // one row never dimmed by the gate below it — the control you need to fix the
  // state cannot be the one faded out.
  const pageCell = (leaf: Leaf) => {
    const state = stateOf(leaf.capability);
    const mine = held.has(leaf.capability);
    const on = effective.has(leaf.capability);
    return (
      <div
        className={cn(
          'group flex items-center justify-between gap-3 py-2.5 pl-4 pr-3 border-t border-t-[var(--line)] border-l-[3px] bg-[var(--surface-2)]',
          changed(leaf.capability) ? 'border-l-[var(--color-warning)]' : 'border-l-transparent',
        )}
      >
        <div className="min-w-0">
          <p className="text-sm font-medium text-[var(--ink)]">{leaf.label}</p>
          <p className="text-[11px] text-[var(--mute)]">
            {on
              ? 'They can open this section. What they see and do inside it is set below.'
              : 'Off — nothing else in this area applies, whatever is set below.'}
          </p>
          <p className="font-mono text-[11px] text-[var(--mute)] opacity-0 transition-opacity duration-150 group-hover:opacity-50 group-focus-within:opacity-50">
            {leaf.capability}
          </p>
          {!mine && <p className="text-[11px] text-[var(--mute)]">You do not hold this.</p>}
        </div>
        {segments(leaf, state)}
      </div>
    );
  };

  const renderNode = (node: Node, depth: number, dimmed: boolean) => {
    if (visibleLeaves(node).length === 0) return null;
    const open = isOpen(node);
    // COUNTED OVER THE WHOLE AREA, never over what the filter left standing. A
    // header that read "2 of 2" because the filter hid the other nine would be
    // the one number on this screen that is not the truth about the person.
    const leaves = allLeaves(node);
    const on = leaves.filter((l) => effective.has(l.capability)).length;
    const areaChanged = leaves.some((l) => changed(l.capability));
    // GATED, NOT BROKEN. The resolver deletes every other key in an area whose
    // page is off, so the rows below are describing something that cannot
    // happen. Dimming them and saying why is the difference between a screen
    // that looks wrong and one that explains itself.
    const gated = node.page !== null && !effective.has(node.page.capability);
    return (
      <div key={node.key} className={cn(depth === 0 && 'border-t border-[var(--line)]')}>
        <div className={cn('flex items-center gap-2 px-3 py-2.5', dimmed && 'opacity-45')}>
          {/* Expands, NEVER toggles. The counts beside it are a read-out. */}
          <button
            type="button"
            onClick={() => toggleOpen(node.key)}
            aria-expanded={open}
            className="flex flex-1 min-w-0 items-center gap-2 min-h-[36px] text-left"
          >
            {open ? (
              <ChevronDown className="w-4 h-4 flex-shrink-0 text-[var(--mute)]" />
            ) : (
              <ChevronRight className="w-4 h-4 flex-shrink-0 text-[var(--mute)]" />
            )}
            <span
              className={cn(
                'font-display font-bold uppercase tracking-[0.02em] truncate',
                depth === 0 ? 'text-[15px] text-[var(--ink)]' : 'text-[13px] text-[var(--ink-2)]',
              )}
            >
              {node.label}
            </span>
            <span
              className={cn(
                'font-mono text-[11px] flex-shrink-0',
                on > 0 ? 'text-[var(--win)]' : 'text-[var(--mute)]',
              )}
            >
              {on} of {leaves.length}
            </span>
            {areaChanged && <Badge variant="warning">changed</Badge>}
          </button>
          {composable && (
            <div className="flex items-center gap-1 flex-shrink-0">
              <Button variant="ghost" size="sm" onClick={() => setAll(node, true, true)}>Reads</Button>
              <Button variant="ghost" size="sm" onClick={() => setAll(node, true, false)}>All</Button>
              <Button variant="ghost" size="sm" onClick={() => setAll(node, false, false)}>None</Button>
            </div>
          )}
        </div>
        {open && (
          <div>
            {node.page && matches(node.page) && pageCell(node.page)}
            {gated && !dimmed && node.page && (
              <div className="flex items-start gap-2 border-t border-[var(--line)] bg-[color-mix(in_oklab,var(--color-warning)_10%,transparent)] px-4 py-2">
                <AlertTriangle className="mt-px w-3.5 h-3.5 flex-shrink-0 text-[var(--color-warning)]" />
                <p className="text-[11px] text-[var(--color-warning)]">
                  {node.page.label} is off — nothing below applies until it is on
                </p>
              </div>
            )}
            {node.leaves.filter(matches).map((leaf) => cell(leaf, dimmed || gated))}
            {node.children.map((child) => renderNode(child, depth + 1, dimmed || gated))}
          </div>
        )}
      </div>
    );
  };

  /** The badge on a person's row — one word for how their access was arrived at. */
  const personBadge = (person: PersonRow) => {
    if (person.level === null) return <Badge variant="neutral">no access</Badge>;
    // An admin's stored row is never consulted, so "custom" would be a lie
    // whatever is in it.
    if (person.level === 'admin') return <Badge variant="success">all</Badge>;
    const deltas = person.grants.length + person.revokes.length;
    if (deltas > 0) return <Badge variant="warning">{deltas} custom</Badge>;
    return <Badge variant="neutral">role only</Badge>;
  };

  const personRow = (person: PersonRow) => {
    const active = selectedId === person.id;
    return (
      <button
        key={person.id}
        type="button"
        onClick={() => select(person)}
        aria-current={active}
        className={cn(
          'flex w-full items-center gap-3 px-3 py-2.5 text-left border-b border-b-[var(--line)] border-l-[3px] transition-colors',
          active
            ? 'border-l-[var(--red)] bg-[var(--surface-2)]'
            : 'border-l-transparent hover:bg-[var(--surface-2)]',
        )}
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate font-display text-[15px] font-bold uppercase tracking-[0.01em] text-[var(--ink)]">
            {person.name}
            {person.id === viewerId && <span className="text-[var(--mute)]"> (you)</span>}
          </span>
          <span className="mt-0.5 block truncate text-[11px] text-[var(--mute)]">
            {describe(person)}
          </span>
        </span>
        {personBadge(person)}
      </button>
    );
  };

  const shownHolders = search(holders, memberSearch);
  // EVERY MEMBER IS HERE; ONLY THE PEOPLE WITH THE CONSOLE ARE LISTED UNPROMPTED.
  // The club is a hundred people and four of them can open this screen, so a
  // list of all of them would bury the answer to the question the page is
  // named after. Searching is what brings the rest in, which is also the act
  // somebody performs when they have a specific person in mind — the only
  // reason to look at an ordinary member here at all.
  const matchedOthers = memberSearch.trim() === '' ? [] : search(others, memberSearch);
  const shownOthers = matchedOthers.slice(0, OTHERS_SHOWN);

  const groupHeading = (text: string) => (
    <p className={cn(MICRO, 'px-3 pt-3 pb-1.5 text-[var(--mute)]')}>{text}</p>
  );

  const note = (text: string) => (
    <p className="px-3 py-3 text-[11px] text-[var(--mute)]">{text}</p>
  );

  const changes = gaining.length + losing.length;

  return (
    <>
      {/* TWO PANES ON A LAPTOP, ONE COLUMN ON A PHONE. Below `md` the grid
          collapses and exactly one of the two is drawn: the list until somebody
          is picked, the editor afterwards, with a back control that clears the
          selection. A 296px rail beside a capability tree on a 390px screen
          would be two unusable columns rather than one usable one. */}
      <Card padding={false} className="md:grid md:grid-cols-[296px_minmax(0,1fr)]">
        <div
          className={cn(
            'md:sticky md:top-[120px] md:self-start md:h-[calc(100vh-140px)] md:flex md:flex-col md:border-r md:border-[var(--line)]',
            selected && 'hidden md:flex',
          )}
        >
          <div className="p-3">
            <SearchFilter
              label="Find a person by name or email"
              placeholder="Find a person"
              value={memberSearch}
              onChange={setMemberSearch}
              resultCount={shownHolders.length + shownOthers.length}
              noun="person"
              nounPlural="people"
            />
          </div>

          <div className="md:flex-1 md:min-h-0 md:overflow-y-auto border-t border-[var(--line)]">
            {shownHolders.length > 0 && (
              <>
                {groupHeading('With console access')}
                {shownHolders.map(personRow)}
              </>
            )}

            {!viewerIsAdmin
              ? memberSearch.trim() !== '' &&
                shownHolders.length === 0 &&
                note(`Nobody with console access matches “${memberSearch.trim()}”.`)
              : memberSearch.trim() !== '' && (
                  <>
                    {shownOthers.length > 0 && (
                      <>
                        {groupHeading('No console access')}
                        {shownOthers.map(personRow)}
                      </>
                    )}
                    {matchedOthers.length > shownOthers.length &&
                      note(
                        `${matchedOthers.length - shownOthers.length} more match “${memberSearch.trim()}”. Type a little more to narrow it.`,
                      )}
                    {shownHolders.length === 0 &&
                      matchedOthers.length === 0 &&
                      note(`Nobody matches “${memberSearch.trim()}”.`)}
                  </>
                )}
          </div>

          {/* THE FOOTNOTE IS PERMANENT, and it is where the page's one paragraph
              of explanation lives now that the list is a rail rather than a
              card. It also carries the reason the rail looks short: every member
              of the club is reachable from that search box, and only the people
              who already hold the console are listed without being asked for. */}
          <p className="border-t border-[var(--line)] px-3 py-3 text-[11px] leading-relaxed text-[var(--mute)]">
            {viewerIsAdmin
              ? `Console access is the level somebody holds; capabilities are what they may do once they have it. ${others.length} other ${others.length === 1 ? 'member has' : 'members have'} none — search by name or email to bring one in. You can only hand out capabilities you hold yourself, and every change is recorded in the audit log.`
              : 'A role decides what somebody STARTS from; grants and revokes adjust it person by person. Leave a role unset and they keep the full access their level has always had. You can only hand out capabilities you hold yourself, and every change is recorded in the audit log.'}
          </p>
        </div>

        <div className={cn('min-w-0', !selected && 'hidden md:block')}>
          {selected === null ? (
            <EmptyState
              title="Nobody picked"
              description="Choose somebody on the left to see what they can do, and to change it."
            />
          ) : (
            <>
              <div className="border-b border-[var(--line)] px-4 py-4">
                <button
                  type="button"
                  onClick={() => setSelectedId(null)}
                  className={cn(
                    MICRO,
                    'md:hidden mb-3 inline-flex items-center gap-2 min-h-[36px] text-[var(--mute)] hover:text-[var(--ink)] transition-colors',
                  )}
                >
                  <ArrowLeft className="w-4 h-4" />
                  All people
                </button>

                <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-4">
                  <div className="min-w-0">
                    <h2 className="font-display text-[26px] font-bold uppercase leading-none text-[var(--ink)]">
                      {selected.name}
                    </h2>
                    <p className="mt-1.5 text-[13px] text-[var(--mute)]">
                      {selected.title ? `${selected.title} · ` : ''}
                      {selectedLevel ? LEVEL_LABELS[selectedLevel] : 'No console access'}
                      {selected.email ? ` · ${selected.email}` : ''}
                      {selectedLevel !== null && !selected.canSignIn ? ' · cannot sign in' : ''}
                    </p>
                  </div>

                  <div className="flex flex-wrap items-end gap-x-8 gap-y-4">
                    {selectedLevel !== null && composable && (
                      <div className="w-[200px]">
                        <Select
                          label="Starts from"
                          options={roleOptions(selectedLevel)}
                          value={role ?? LEVEL_DEFAULT_OPTION}
                          onChange={(e) => void changeRole(e.target.value)}
                        />
                      </div>
                    )}
                    {selectedLevel !== null && (
                      <div>
                        <p className={cn(MICRO, 'text-[var(--mute)]')}>Effective access</p>
                        <p className="mt-1.5 font-mono text-[22px] leading-none text-[var(--ink)]">
                          {effective.size}
                          <span className="text-[var(--mute)]"> of {CAPABILITIES.length}</span>
                        </p>
                      </div>
                    )}
                  </div>
                </div>

                {selectedLevel !== null && composable && (
                  <p className="mt-3 text-[11px] leading-relaxed text-[var(--mute)]">
                    {role === null
                      ? `${LEVEL_ACCESS_LABELS[selectedLevel]} — ${BASELINE_PHRASE[selectedLevel]}. Nothing is stored; move anything below off Inherit and they become a hand-picked set starting from exactly this.`
                      : role === 'custom'
                        ? `Hand-picked — ${grants.length} ${grants.length === 1 ? 'capability' : 'capabilities'} chosen one at a time, starting from no job at all.`
                        : grants.length === 0 && revokes.length === 0
                          ? `${PERMISSION_ROLE_LABELS[role]}, unadjusted.`
                          : `Custom — ${PERMISSION_ROLE_LABELS[role]} with ${grants.length} granted and ${revokes.length} revoked.`}
                  </p>
                )}
              </div>

              <div className="px-4 py-4 space-y-4">
                {/* CONSOLE ACCESS — the half of this page's subtitle it could not
                    answer until now. It is a LEVEL, not a capability: admins alone
                    hand it out (the hard floor in player-field-access.ts, which no
                    grant reaches), so the control is not drawn for anybody else and
                    the server refuses it again regardless. */}
                {viewerIsAdmin && (
                  <div className="border border-[var(--line)] p-3 space-y-3">
                    <p className={cn(MICRO, 'text-[var(--mute)]')}>Console access</p>
                    {selected.id === viewerId ? (
                      <p className="text-[11px] text-[var(--mute)] max-w-[64ch]">
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
                          <p className="text-[11px] text-[var(--red)]">
                            They hold this level but cannot sign in — banned, suspended, awaiting
                            approval or deactivated. Their access starts working when their account
                            does.
                          </p>
                        )}
                        {access !== accessForLevel(selected.level) && (
                          <>
                            <p className="text-[11px] text-[var(--mute)] max-w-[64ch]">
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
                  <p className="text-sm text-[var(--mute)] max-w-[64ch]">
                    An ordinary member. Capabilities are what somebody with the console may do inside
                    it, so there is nothing to set here until they have one.
                  </p>
                ) : (
                  <>
                    {readOnlyReason && (
                      <p className="text-sm text-[var(--mute)] max-w-[64ch]">{readOnlyReason}</p>
                    )}

                    {/* WHAT SAVING WOULD TAKE AWAY. The figure in the header
                        answers "what will they hold"; this band answers the
                        question that actually catches people out, which is "what
                        do they hold RIGHT NOW that they would stop holding". They
                        are not the same question and only the second one is a
                        warning. See the note on `losing` above for why a trainer
                        needs it more sharply than an exec does. */}
                    {composable && losing.length > 0 && (
                      <div className="border border-[var(--red-border)] bg-[var(--red-wash)] p-3">
                        <p className={cn(MICRO, 'text-[var(--red)]')}>
                          Saving takes away {losing.length}{' '}
                          {losing.length === 1 ? 'capability' : 'capabilities'} they hold today
                        </p>
                        <p className="mt-2 text-[11px] text-[var(--mute)] leading-relaxed">
                          {losing.map((capability) => CAPABILITY_GATES[capability].label).join(' · ')}
                        </p>
                      </div>
                    )}

                    {/* ORPHANED REVOKES — a revoke of something the current role does
                        not give. Inert today, and KEPT rather than tidied away: if the
                        role ever regains that capability, the revoke should bite again,
                        and deleting it now would be a silent future re-grant nobody
                        chose. Surfaced instead, with a one-click clear, so that "inert"
                        is a state somebody can see rather than one they discover. */}
                    {composable && orphanRevokes.length > 0 && (
                      <div className="border border-[var(--line)] p-3">
                        <p className={cn(MICRO, 'text-[var(--ink)]')}>
                          {orphanRevokes.length} revoke{orphanRevokes.length === 1 ? '' : 's'} the{' '}
                          {role === null ? 'current' : PERMISSION_ROLE_LABELS[role]} role does not give
                        </p>
                        <p className="mt-2 text-[11px] text-[var(--mute)]">
                          {orphanRevokes.map((c) => CAPABILITY_GATES[c].label).join(' · ')} — doing
                          nothing today, and will apply again if the role regains them.
                        </p>
                        <div className="mt-2">
                          <Button
                            variant="ghost"
                            size="sm"
                            onClick={() => setRevokes((prev) => prev.filter((c) => !orphanRevokes.includes(c)))}
                          >
                            Clear them
                          </Button>
                        </div>
                      </div>
                    )}

                    {/* ALWAYS VISIBLE. The cost of a model where a role is a name and
                        the deltas are two lists is that the stored row no longer says
                        what a person can do. The figure above is the count; this is
                        the same set in words, and it is computed by the same function
                        the gates call. */}
                    <div className="border border-[var(--line)] bg-[var(--surface-2)] p-3">
                      <p className={cn(MICRO, 'text-[var(--mute)]')}>Everything they hold</p>
                      <p className="mt-2 text-[11px] text-[var(--mute)] leading-relaxed">
                        {effective.size === 0
                          ? 'Nothing. This person can sign in and reach the dashboard, and no section at all.'
                          : [...effective]
                              .map((capability) => CAPABILITY_GATES[capability].label)
                              .join(' · ')}
                      </p>
                    </div>
                  </>
                )}
              </div>

              {/* THE TREE IS ALWAYS HERE, and that is what changed when trainers
                  became composable. It used to be hidden for anybody on their
                  level default, on the grounds that every cell would read "off"
                  beside a panel saying 71 of 116 — two true statements that look
                  like a contradiction. The contradiction was real; hiding the
                  tree was the wrong end of it. Showing the level's own
                  capabilities in their own state fixes the disagreement instead,
                  and leaves the common case — which is everybody, on day one —
                  looking like something you can edit. */}
              {composable && (
                <>
                  <div className="sticky top-[120px] z-10 flex flex-wrap items-center gap-2 border-y border-[var(--line)] bg-[var(--surface)] px-3 py-2.5">
                    <SearchFilter
                      className="min-w-[200px] flex-1"
                      label="Filter capabilities by name or dotted path"
                      placeholder="Filter by name or by dotted path"
                      value={capabilitySearch}
                      onChange={setCapabilitySearch}
                      resultCount={shownLeaves}
                      noun="capability"
                      nounPlural="capabilities"
                    />
                    <Segmented label="Show" value={mode} options={MODES} onChange={setMode} />
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={filtering}
                      onClick={() => setExpanded(allExpanded ? [] : ALL_KEYS)}
                    >
                      {allExpanded ? 'Collapse all' : 'Expand all'}
                    </Button>
                  </div>

                  {TREE.map((node) => renderNode(node, 0, false))}

                  {shownLeaves === 0 && (
                    <p className="border-t border-[var(--line)] px-4 py-6 text-center text-[11px] text-[var(--mute)]">
                      No capability matches this filter.
                    </p>
                  )}
                </>
              )}

              {/* THE SAVE BAR EXISTS ONLY WHEN THERE IS SOMETHING TO SAVE, and
                  says what that something is. `dirty` is about the stored ROW;
                  the two figures beside it are about the PERSON, and the two can
                  disagree — turning a level default into a hand-picked set of
                  exactly the same capabilities rewrites the row and changes
                  nothing about them. That state is reachable in one click here,
                  so it gets a sentence rather than a "0". */}
              {composable && dirty && (
                <div className="sticky bottom-0 z-10 flex flex-wrap items-center justify-between gap-3 border-t border-[var(--line)] bg-[var(--surface)] px-4 py-3">
                  <div className="min-w-0">
                    <p className={cn(MICRO, 'text-[var(--ink)]')}>
                      {changes === 0 ? (
                        'Nothing changes for them'
                      ) : (
                        <>
                          <span className="font-mono">{changes}</span>{' '}
                          {changes === 1 ? 'change' : 'changes'} pending
                        </>
                      )}
                    </p>
                    <p className="mt-1 text-[11px] text-[var(--mute)]">
                      {changes === 0
                        ? 'The stored row changes; what they can do does not.'
                        : [
                            gaining.length > 0 &&
                              `${gaining.length} ${gaining.length === 1 ? 'capability' : 'capabilities'} added`,
                            losing.length > 0 &&
                              `${losing.length} taken away`,
                          ]
                            .filter(Boolean)
                            .join(' · ')}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <Button variant="ghost" onClick={() => select(selected)} disabled={saving}>
                      Reset
                    </Button>
                    <Button onClick={save} loading={saving}>
                      Save
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      </Card>

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
                if (dangerous) setCell(dangerous, 'on');
                setDangerous(null);
              }}
            >
              Grant it
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}

/**
 * The one-line summary under a person's name in the rail.
 *
 * THE ROLE IS CONSULTED BEFORE THE LEVEL IS ALLOWED TO ANSWER FOR ITSELF, and
 * that ordering is what changed when trainers became composable. This used to
 * return "roster and varsity notes" for any trainer, because a trainer could not
 * hold a role — now they can, and answering from the level would describe the
 * baseline of somebody who has been composed out of it.
 *
 * The title leads it where there is one, because "Treasurer · Finance" is how
 * the club refers to the person and "Finance" alone is how the code does.
 */
function describe(person: PersonRow): string {
  const parts: string[] = [];
  if (person.title) parts.push(person.title);
  parts.push(accessSummary(person));
  if (person.level !== null && !person.canSignIn) parts.push('cannot sign in');
  return parts.join(' · ');
}

function accessSummary(person: PersonRow): string {
  if (person.level === null) return 'No console access';
  // Still answered from the level, and still correctly: an admin's stored role
  // is never consulted, so there is nothing else it could say.
  if (person.level === 'admin') return 'Admin';
  if (!isRole(person.role)) return LEVEL_ACCESS_LABELS[person.level];
  return PERMISSION_ROLE_LABELS[person.role];
}
