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
  ResponsiveTable,
  TableCard,
  Textarea,
  cn,
} from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import {
  createPermissionBaseline,
  deletePermissionBaseline,
  updatePermissionBaseline,
} from '@/lib/actions';
import { CAPABILITY_GATES } from '@badminton/shared/src/utils/capability-gates';
import {
  baselineCapabilityRefusal,
  baselineNameRefusal,
  normaliseBaselineCapabilities,
  pageOf,
  BASELINE_NAME_MAX,
  EDITOR_OFFERABLE,
  type Area,
  type Capability,
} from '@/lib/permissions';

// THE CLUB'S OWN BASELINES — the answer to "we will have others".
//
// The four VP jobs live in ROLE_DEFAULTS, in code, so a fifth is a deploy. These
// are rows, and this is where they are written.
//
// A BASELINE IS COPIED ONTO A PERSON, NOT REFERENCED BY THEM. Handing one over
// stores role 'custom' with the baseline's capabilities in permission_grants —
// which is why the resolver is untouched by this feature and why editing a
// baseline has to PROPAGATE. Every consequence the club will actually notice
// follows from that, so this screen says it in three places rather than none:
// on the Edit dialog's confirm button ("...and 3 people"), in the refusal when a
// deletion is blocked, and in the holders column.

export interface BaselineRow {
  id: string;
  name: string;
  capabilities: Capability[];
  /** How many people hold it right now — what an edit would reach. */
  holders: number;
}

const MICRO = 'text-[11px] font-bold uppercase tracking-[0.12em]';

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

/** The offerable capabilities, in area order — the same order the editor uses. */
const BY_AREA: { area: Area; label: string; leaves: Capability[] }[] = (() => {
  const areas: { area: Area; label: string; leaves: Capability[] }[] = [];
  for (const capability of EDITOR_OFFERABLE) {
    const { area } = CAPABILITY_GATES[capability];
    let entry = areas.find((a) => a.area === area);
    if (!entry) {
      entry = { area, label: AREA_LABELS[area], leaves: [] };
      areas.push(entry);
    }
    entry.leaves.push(capability);
  }
  return areas;
})();

type DraftBaseline = { name: string; chosen: Set<Capability> };

const emptyDraft = (): DraftBaseline => ({ name: '', chosen: new Set() });

export function BaselineManager({
  baselines,
  viewerCapabilities,
}: {
  baselines: BaselineRow[];
  /**
   * The viewer's own resolved set, from the server. It decides which rows are
   * OFFERED and which baselines are editable at all — the same courtesy the
   * two-pane editor extends. Every one of these checks runs again server-side
   * against the actor's own row, which is the boundary.
   */
  viewerCapabilities: Capability[];
}) {
  const held = useMemo(() => new Set(viewerCapabilities), [viewerCapabilities]);
  const [editing, setEditing] = useState<BaselineRow | 'new' | null>(null);
  const [draft, setDraft] = useState<DraftBaseline>(emptyDraft);
  const [reason, setReason] = useState('');
  const [deleting, setDeleting] = useState<BaselineRow | null>(null);
  const [deleteReason, setDeleteReason] = useState('');
  const [saving, startSaving] = useTransition();
  const { toast } = useToast();
  const router = useRouter();

  const chosen = [...draft.chosen];
  const nameRefusal = baselineNameRefusal(draft.name);
  // The four rules, run on every keystroke against the same function the server
  // runs. Reported as ONE line under the tree rather than as four scattered
  // markers: they are ordered, so only the first one that fires is actionable.
  const capabilityRefusal = baselineCapabilityRefusal(chosen, held);
  const refusal = nameRefusal ?? capabilityRefusal;

  function open(target: BaselineRow | 'new') {
    setEditing(target);
    setReason('');
    setDraft(
      target === 'new'
        ? emptyDraft()
        : { name: target.name, chosen: new Set(target.capabilities) },
    );
  }

  /**
   * Tick one capability.
   *
   * THE AREA PAGE COMES WITH IT, and goes when the last thing in its area does.
   * Not a convenience: the resolver prunes every capability whose area page is
   * absent, so a set without one hands out nothing, and baselineCapabilityRefusal
   * refuses it. Making somebody find the page row themselves would be a rule
   * enforced by an error message rather than by the control.
   */
  function toggle(capability: Capability) {
    setDraft((prev) => {
      const next = new Set(prev.chosen);
      const page = pageOf(capability);
      if (next.has(capability)) {
        next.delete(capability);
        // The page itself: turning it off clears the area, exactly as revoking
        // a page does to a person.
        if (capability === page) {
          for (const other of [...next]) if (pageOf(other) === page) next.delete(other);
        } else if (![...next].some((other) => other !== page && pageOf(other) === page)) {
          next.delete(page);
        }
      } else {
        next.add(capability);
        if (held.has(page)) next.add(page);
      }
      return { ...prev, chosen: next };
    });
  }

  function save() {
    if (editing === null || refusal !== null) return;
    const capabilities = normaliseBaselineCapabilities(chosen);
    startSaving(async () => {
      const result =
        editing === 'new'
          ? await createPermissionBaseline(draft.name.trim(), capabilities)
          : await updatePermissionBaseline(editing.id, draft.name.trim(), capabilities, reason);
      if (!result.ok) {
        toast(result.error, 'error');
        return;
      }
      setEditing(null);
      router.refresh();
      toast(
        editing === 'new'
          ? `${draft.name.trim()} created`
          : editing.holders === 0
            ? `${draft.name.trim()} updated`
            : `${draft.name.trim()} updated · ${editing.holders} ${editing.holders === 1 ? 'person' : 'people'} changed with it`,
        'success',
      );
    });
  }

  // ITS OWN DIALOG RATHER THAN useConfirm, because this is an AUDITED action and
  // the console's rule is that those take a typed reason inside the dialog with
  // the confirm button disabled until it has content. ConfirmOptions carries a
  // message and a label and no field to type into.
  function remove() {
    if (deleting === null) return;
    const target = deleting;
    startSaving(async () => {
      const result = await deletePermissionBaseline(target.id, deleteReason);
      if (!result.ok) {
        toast(result.error, 'error');
        return;
      }
      setDeleting(null);
      router.refresh();
      toast(`${target.name} deleted`, 'success');
    });
  }

  /** Editable when the viewer could have written it — closure, shown early. */
  const canEdit = (baseline: BaselineRow) =>
    baseline.capabilities.every((capability) => held.has(capability));

  const actions = (baseline: BaselineRow) =>
    canEdit(baseline) ? (
      <div className="flex justify-end gap-2">
        <Button variant="ghost" size="sm" onClick={() => open(baseline)}>Edit</Button>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => {
            setDeleting(baseline);
            setDeleteReason('');
          }}
        >
          Delete
        </Button>
      </div>
    ) : (
      // WITHHELD IS NOT EMPTY. A row with no controls and no explanation reads as
      // a rendering fault.
      <span className="text-[11px] text-[var(--mute)]">Holds more than you do</span>
    );

  return (
    <Card padding={false}>
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-[var(--line)] px-4 py-4">
        <div>
          <h2 className="font-display text-[20px] font-bold uppercase leading-none text-[var(--ink)]">
            Baselines
          </h2>
          <p className="mt-1.5 max-w-[70ch] text-[12px] leading-relaxed text-[var(--mute)]">
            Named sets of capabilities the club writes for itself, offered above beside the four
            built-in jobs. Handing one over copies it onto the person, so editing a baseline
            changes everybody holding it — and deleting one is refused while anybody does.
          </p>
        </div>
        <Button variant="secondary" onClick={() => open('new')}>New baseline</Button>
      </div>

      {baselines.length === 0 ? (
        <EmptyState
          title="No baselines yet"
          description="The four built-in jobs — Finance, Tournaments, Internal, External — are always available. Write a baseline when the club has a job none of them describes."
        />
      ) : (
        <ResponsiveTable
          cards={baselines.map((baseline) => (
            <TableCard
              key={baseline.id}
              title={baseline.name}
              value={
                <span className="font-mono text-[13px]">{baseline.capabilities.length}</span>
              }
              badges={
                baseline.holders > 0 ? (
                  <Badge variant="warning">
                    {baseline.holders} {baseline.holders === 1 ? 'holder' : 'holders'}
                  </Badge>
                ) : (
                  <Badge variant="neutral">unused</Badge>
                )
              }
              fields={[{ label: 'Areas', value: areasOf(baseline.capabilities) }]}
              actions={actions(baseline)}
            />
          ))}
        >
          <table className="w-full">
            <thead>
              <tr className="border-b border-[var(--line)]">
                <th className={cn(MICRO, 'px-4 py-3 text-left text-[var(--mute)]')}>Baseline</th>
                <th className={cn(MICRO, 'px-4 py-3 text-left text-[var(--mute)]')}>Areas</th>
                <th className={cn(MICRO, 'px-4 py-3 text-right text-[var(--mute)]')}>Capabilities</th>
                <th className={cn(MICRO, 'px-4 py-3 text-right text-[var(--mute)]')}>Holders</th>
                <th className={cn(MICRO, 'px-4 py-3 text-right text-[var(--mute)]')}>Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-[var(--line)]">
              {baselines.map((baseline) => (
                <tr key={baseline.id}>
                  <td className="px-4 py-3 font-display text-[15px] font-bold uppercase text-[var(--ink)]">
                    {baseline.name}
                  </td>
                  <td className="px-4 py-3 text-[12px] text-[var(--mute)]">
                    {areasOf(baseline.capabilities)}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-[13px] text-[var(--ink)]">
                    {baseline.capabilities.length}
                  </td>
                  <td className="px-4 py-3 text-right font-mono text-[13px] text-[var(--ink)]">
                    {baseline.holders}
                  </td>
                  <td className="px-4 py-3 text-right">{actions(baseline)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </ResponsiveTable>
      )}

      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' || editing === null ? 'New baseline' : `Edit ${editing.name}`}
      >
        <div className="space-y-4">
          <Input
            label="Name"
            value={draft.name}
            maxLength={BASELINE_NAME_MAX}
            placeholder="Socials VP"
            onChange={(e) => setDraft((prev) => ({ ...prev, name: e.target.value }))}
          />

          <div>
            <p className={cn(MICRO, 'mb-2 text-[var(--mute)]')}>
              Capabilities · {chosen.length} chosen
            </p>
            <div className="max-h-[320px] overflow-y-auto border border-[var(--line)]">
              {BY_AREA.map(({ area, label, leaves }) => (
                <div key={area} className="border-b border-[var(--line)] last:border-b-0">
                  <p className={cn(MICRO, 'bg-[var(--surface-2)] px-3 py-2 text-[var(--ink-2)]')}>
                    {label}
                  </p>
                  {leaves.map((capability) => {
                    const gate = CAPABILITY_GATES[capability];
                    // OFFERED ONLY WHERE THE VIEWER HOLDS IT — grant closure as
                    // a control rather than as an error. The server checks the
                    // same thing against the actor's own row.
                    const reachable = held.has(capability);
                    return (
                      <label
                        key={capability}
                        className={cn(
                          'flex items-start gap-3 px-3 py-2 min-h-[44px] border-t border-[var(--line)]',
                          reachable ? 'cursor-pointer' : 'opacity-45',
                        )}
                      >
                        <input
                          type="checkbox"
                          className="mt-1"
                          disabled={!reachable}
                          checked={draft.chosen.has(capability)}
                          onChange={() => toggle(capability)}
                        />
                        <span className="min-w-0">
                          <span className="block text-[13px] text-[var(--ink)]">
                            {gate.label}
                            <span className="text-[var(--mute)]"> ({gate.mode})</span>
                          </span>
                          <span className="block font-mono text-[10px] text-[var(--mute)]">
                            {capability}
                          </span>
                        </span>
                      </label>
                    );
                  })}
                </div>
              ))}
            </div>
          </div>

          {/* A TYPED REASON ON EDIT, NOT ON CREATE. Creating a baseline changes
              nobody's access; editing one changes everybody holding it, and the
              audit row is where that has to be readable back from. */}
          {editing !== null && editing !== 'new' && (
            <Textarea
              label="Reason (required)"
              value={reason}
              placeholder={
                editing.holders > 0
                  ? `Why this is changing — ${editing.holders} ${editing.holders === 1 ? 'person' : 'people'} will change with it`
                  : 'Why this is changing'
              }
              onChange={(e) => setReason(e.target.value)}
            />
          )}

          {refusal !== null && chosen.length > 0 && (
            <p className="text-[12px] text-[var(--color-warning)]">{refusal}</p>
          )}

          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setEditing(null)}>Cancel</Button>
            <Button
              variant="primary"
              disabled={
                saving
                || refusal !== null
                || (editing !== null && editing !== 'new' && reason.trim() === '')
              }
              onClick={save}
            >
              {editing === 'new'
                ? 'Create baseline'
                : editing !== null && editing.holders > 0
                  ? `Save and update ${editing.holders} ${editing.holders === 1 ? 'person' : 'people'}`
                  : 'Save baseline'}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* DESTRUCTIVE CONFIRMATIONS NAME THE THING, and audited ones take a typed
          reason. Both rules, one dialog. */}
      <Dialog
        open={deleting !== null}
        onClose={() => setDeleting(null)}
        title={deleting === null ? 'Delete baseline' : `Delete ${deleting.name}`}
      >
        <div className="space-y-4">
          <p className="text-[13px] leading-relaxed text-[var(--ink-2)]">
            The baseline disappears from the list of jobs.{' '}
            <span className="text-[var(--ink)]">Nobody&rsquo;s access changes</span> — a
            baseline is copied onto a person when it is handed over, so anybody holding
            one keeps every capability they have; only the name for it goes.
          </p>
          {deleting !== null && deleting.holders > 0 && (
            <p className="border border-[var(--color-warning)] p-3 text-[12px] text-[var(--color-warning)]">
              {deleting.holders} {deleting.holders === 1 ? 'person holds' : 'people hold'} it.
              This will be refused until they are moved onto something else — deleting a
              baseline must not be a way to quietly leave people on a set nobody can name.
            </p>
          )}
          <Textarea
            label="Reason (required)"
            value={deleteReason}
            onChange={(e) => setDeleteReason(e.target.value)}
          />
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setDeleting(null)}>Cancel</Button>
            <Button
              variant="danger"
              disabled={saving || deleteReason.trim() === ''}
              onClick={remove}
            >
              Delete baseline
            </Button>
          </div>
        </div>
      </Dialog>
    </Card>
  );
}

/** "Announcements, Legal" — the areas a baseline reaches, for the list. */
function areasOf(capabilities: readonly Capability[]): string {
  const areas = [...new Set(capabilities.map((capability) => CAPABILITY_GATES[capability].area))];
  return areas.map((area) => AREA_LABELS[area]).join(', ') || '-';
}
