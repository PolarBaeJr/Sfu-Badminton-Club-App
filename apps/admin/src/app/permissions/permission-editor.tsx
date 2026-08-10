'use client';

import { useMemo, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Badge, Button, Card, Dialog, Input, Select, useConfirm } from '@badminton/ui';
import { ChevronDown, ChevronRight, ShieldAlert } from 'lucide-react';
import { useToast } from '@/components/toast-provider';
import { setPlayerPermissions } from '@/lib/actions';
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
  title: string | null;
  level: AccessLevel;
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

type CellState = 'role' | 'granted' | 'revoked' | 'off';

const CELL_TEXT: Record<CellState, string> = {
  role: '● from role',
  granted: '+● granted',
  revoked: '⊘ revoked',
  off: '· off',
};

const CELL_CLASS: Record<CellState, string> = {
  role: 'text-[var(--text-primary)] border-[var(--border-hover)]',
  granted: 'text-[var(--color-success)] border-[var(--color-success)]',
  revoked: 'text-[var(--color-danger)] border-[var(--color-danger)]',
  off: 'text-[var(--text-muted)] border-[var(--border)]',
};

const UNRESTRICTED_OPTION = '';

const LEVEL_LABELS: Record<AccessLevel, string> = {
  admin: 'Admin',
  exec: 'Executive',
  trainer: 'Varsity trainer',
};

// WHAT "UNRESTRICTED" MEANS, IN WORDS, PER LEVEL. Two places describe the state
// somebody returns to when no role is set — the confirmation behind the select
// and the line under it — and both used to say "the executive baseline" because
// only an exec could be composed. On a trainer's row that is simply false, so
// the phrase is read from the row being edited rather than written into the
// prose.
const BASELINE_PHRASE: Record<AccessLevel, string> = {
  admin: 'every capability there is',
  exec: 'the full executive baseline — everything an exec could do before anybody was narrowed',
  trainer: 'the varsity-trainer baseline — opening the roster, reading it, and writing varsity notes',
};

// Built per row for the same reason: the first option names the person's own
// level, so it cannot be a module constant any more.
function roleOptions(level: AccessLevel) {
  return [
    {
      value: UNRESTRICTED_OPTION,
      label: `Unrestricted — today’s ${LEVEL_LABELS[level].toLowerCase()} access`,
    },
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

export function PermissionEditor({
  people,
  viewerId,
  viewerCapabilities,
}: {
  people: PersonRow[];
  viewerId: string;
  viewerCapabilities: Capability[];
}) {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [role, setRole] = useState<PermissionRole | null>(null);
  const [grants, setGrants] = useState<Capability[]>([]);
  const [revokes, setRevokes] = useState<Capability[]>([]);
  const [search, setSearch] = useState('');
  const [expanded, setExpanded] = useState<string[]>([]);
  // The capability awaiting a typed confirmation, and what has been typed.
  const [dangerous, setDangerous] = useState<Capability | null>(null);
  const [typed, setTyped] = useState('');
  const [saving, startSaving] = useTransition();
  const { toast } = useToast();
  const confirm = useConfirm();
  const router = useRouter();

  const held = useMemo(() => new Set(viewerCapabilities), [viewerCapabilities]);
  const selected = people.find((p) => p.id === selectedId) ?? null;

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
          : null;
  const editable = selected !== null && readOnlyReason === null;

  function select(person: PersonRow) {
    setSelectedId(person.id);
    setRole(isRole(person.role) ? person.role : null);
    // Filtered to the vocabulary this build has. A stored element the code no
    // longer knows resolves to nothing anyway — the editor must not offer to
    // re-save it as though it meant something.
    setGrants(person.grants.filter(isKnown));
    setRevokes(person.revokes.filter(isKnown));
    setSearch('');
    setExpanded([]);
  }

  const seededRole = selected && isRole(selected.role) ? selected.role : null;
  const dirty =
    selected !== null &&
    (role !== seededRole ||
      !sameSet(grants, selected.grants) ||
      !sameSet(revokes, selected.revokes));

  const base: readonly Capability[] = role === null ? [] : ROLE_DEFAULTS[role];

  function stateOf(capability: Capability): CellState {
    if (grants.includes(capability)) return 'granted';
    if (revokes.includes(capability)) return 'revoked';
    return base.includes(capability) ? 'role' : 'off';
  }

  // ONE CLICK WRITES EXACTLY ONE DELTA ELEMENT, and only the legal transition.
  // If the role gives it, the only move is on ⇄ revoked; if it does not, the
  // only move is off ⇄ granted. That is what stops a redundant grant ever being
  // stored, and it is why there is no third branch here to get wrong.
  function toggle(capability: Capability) {
    if (base.includes(capability)) {
      setRevokes((prev) =>
        prev.includes(capability) ? prev.filter((c) => c !== capability) : [...prev, capability],
      );
      return;
    }
    setGrants((prev) =>
      prev.includes(capability) ? prev.filter((c) => c !== capability) : [...prev, capability],
    );
  }

  function onCellClick(capability: Capability) {
    // The one capability that can replicate itself. A tick box is the wrong
    // weight of control for "this person can hand out anything they hold,
    // including this", so turning it ON costs a typed phrase; turning it off
    // stays one click, because taking access away is the safe direction.
    if (capability === 'permissions.write' && stateOf(capability) !== 'granted' && !base.includes(capability)) {
      setDangerous(capability);
      setTyped('');
      return;
    }
    toggle(capability);
  }

  async function changeRole(value: string) {
    if (value === UNRESTRICTED_OPTION) {
      const ok = await confirm({
        title: 'Back to unrestricted?',
        message: (
          <>
            <span className="text-[var(--text-primary)] font-medium">{selected?.name}</span> will
            get {selected ? BASELINE_PHRASE[selected.level] : 'their level’s baseline'} again. Both
            the grants and the revokes below are cleared.
          </>
        ),
        confirmLabel: 'Make unrestricted',
      });
      if (!ok) return;
      setRole(null);
      setGrants([]);
      setRevokes([]);
      return;
    }
    setRole(value as PermissionRole);
  }

  // The panel that answers the question the stored row no longer answers by
  // itself. Computed by the SAME effectiveCapabilities the gates call, on the
  // SAME resolver — not by a second reading of the ticks on screen, which is
  // how an editor comes to show one thing while the console does another.
  const permissions = resolvePermissions(role, grants, revokes);
  const effective = effectiveCapabilities(selected?.level ?? null, permissions);

  // WHAT PRESSING SAVE WOULD TAKE AWAY, worked out from the row as it is
  // STORED — the same resolver, run a second time on the values this screen was
  // seeded with.
  //
  // A role REPLACES the base rather than adding to it, so the first role picked
  // for somebody who was unrestricted drops their whole level baseline. On an
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
  // somebody else took away then.
  const before = effectiveCapabilities(
    selected?.level ?? null,
    resolvePermissions(seededRole, selected?.grants ?? [], selected?.revokes ?? []),
  );
  const losing = [...before].filter((capability) => !effective.has(capability));

  const orphanRevokes = revokes.filter((capability) => !base.includes(capability));

  const query = search.trim().toLowerCase();
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
  // leaves, one delta element each, exactly as clicking them would.
  //
  // "Reads" means everything that is not a WRITE, so the page comes with them.
  // A set of reads without the area's page is a set the resolver deletes on the
  // way in, and a button that silently produced one would be a button that does
  // nothing.
  function setAll(node: Node, on: boolean, readsOnly: boolean) {
    const leaves = allLeaves(node)
      .filter((l) => (readsOnly ? l.mode !== 'write' : true))
      .filter((l) => held.has(l.capability))
      .filter((l) => l.capability !== 'permissions.write');
    for (const leaf of leaves) {
      const inBase = base.includes(leaf.capability);
      if (inBase) {
        setRevokes((prev) =>
          on ? prev.filter((c) => c !== leaf.capability)
             : prev.includes(leaf.capability) ? prev : [...prev, leaf.capability],
        );
      } else {
        setGrants((prev) =>
          on ? (prev.includes(leaf.capability) ? prev : [...prev, leaf.capability])
             : prev.filter((c) => c !== leaf.capability),
        );
      }
    }
  }

  function save() {
    if (!selected) return;
    startSaving(async () => {
      try {
        const res = await setPlayerPermissions(selected.id, { role, grants, revokes });
        if (!res.ok) { toast(res.error, 'error'); return; }
        toast(
          role === null
            ? `${selected.name} is unrestricted again`
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

  const cell = (leaf: Leaf) => {
    const state = stateOf(leaf.capability);
    const mine = held.has(leaf.capability);
    const disabled = !editable || role === null || !mine;
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
          disabled={!editable || role === null || !mine}
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
          {editable && role !== null && (
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

  return (
    <div className="space-y-6">
      <Card padding={false}>
        <p className="settings-section-desc px-4 pt-4">
          A role decides what somebody STARTS from; grants and revokes adjust it person by person.
          Leave a role unset and they keep the full access their level has always had. You can only
          hand out capabilities you hold yourself. Every change is recorded in the audit log.
        </p>
        {people.map((person) => (
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
        ))}
      </Card>

      {selected && (
        <Card padding={false}>
          <div className="px-4 py-4 space-y-4">
            <div>
              <h2 className="text-sm font-medium text-[var(--text-primary)]">{selected.name}</h2>
              <p className="text-xs text-[var(--text-muted)]">
                {LEVEL_LABELS[selected.level]}
              </p>
            </div>

            {readOnlyReason && (
              <p className="text-sm text-[var(--text-muted)] max-w-[64ch]">{readOnlyReason}</p>
            )}

            {editable && (
              <>
                <Select
                  label="Starts from"
                  options={roleOptions(selected.level)}
                  value={role ?? UNRESTRICTED_OPTION}
                  onChange={(e) => void changeRole(e.target.value)}
                  className="max-w-sm"
                />
                {/* "Custom" is a DESCRIPTION, not a fifth role. Deltas can only
                    be stored against a named role — the database refuses them
                    otherwise — so a role is always chosen and the word Custom
                    reports that it has been adjusted. */}
                <p className="text-xs text-[var(--text-muted)]">
                  {role === null
                    ? `Unrestricted. Nothing below applies — this person keeps ${BASELINE_PHRASE[selected.level]}.`
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
            {editable && orphanRevokes.length > 0 && (
              <div className="rounded-[8px] border border-[var(--border)] p-3">
                <p className="text-xs text-[var(--text-primary)]">
                  {orphanRevokes.length} revoke{orphanRevokes.length === 1 ? '' : 's'} the{' '}
                  {role === null ? 'current' : PERMISSION_ROLE_LABELS[role]} role does not give
                </p>
                <p className="mt-1 text-[11px] text-[var(--text-muted)]">
                  {orphanRevokes.map((c) => CAPABILITY_GATES[c].label).join(' · ')} — doing nothing
                  today, and will apply again if the role regains them.
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
            {editable && losing.length > 0 && (
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

            {/* NO DELTA CONTROLS FOR AN UNRESTRICTED PERSON, and the tree goes
                with them. An unrestricted person holds their level's baseline —
                70 capabilities for an exec, 3 for a trainer — but they hold them
                because of their LEVEL and not because of anything stored, so
                every cell would read "off" beside a panel saying 70 of 115,
                which is two true statements that look like a contradiction.
                Pick a role first. */}
            {editable && role !== null && (
              <Input
                label="Search"
                placeholder="Filter by name or by dotted path"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            )}
          </div>

          {editable && role !== null && TREE.map((node) => renderNode(node, 0))}

          {editable && (
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
 * that ordering is what changed here. This used to return "roster and varsity
 * notes" for any trainer, because a trainer could not hold a role — now they
 * can, and answering from the level would describe the baseline of somebody who
 * has been composed out of it.
 */
function describe(person: PersonRow): string {
  // Still answered from the level, and still correctly: an admin's stored role
  // is never consulted, so there is nothing else it could say.
  if (person.level === 'admin') return 'Admin — holds everything';
  const level = LEVEL_LABELS[person.level];
  if (!isRole(person.role)) {
    return person.level === 'trainer'
      ? `${level} — roster and varsity notes`
      : `${level} — unrestricted`;
  }
  const label = PERMISSION_ROLE_LABELS[person.role];
  const adjusted = person.grants.length + person.revokes.length;
  return adjusted === 0 ? `${level} — ${label}` : `${level} — ${label}, adjusted`;
}
