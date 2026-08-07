'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Dialog, Input, Select, Switch, Dropdown, Textarea, DatePicker } from '@badminton/ui';
import { MEMBERSHIP_TYPES, ALL_MEMBERSHIP_TYPES, resolveEventWaiverTemplate } from '@badminton/shared';
import { createTournament, updateTournament, archiveTournament, deleteTournament } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';
import { MoreVertical } from 'lucide-react';

interface TournamentData {
  id: string;
  name: string;
  scope: string;
  type: string;
  format: string;
  start_date: string;
  end_date: string | null;
  bracket_size: number | null;
  event_multiplier: number;
  placement_bonus_enabled: boolean;
  waiver_text: string | null;
  // Which season's waiver template this tournament's editor offers. Present on
  // the page's `select('*')`; declared here so the template lookup is typed.
  season_id?: string | null;
  status: string;
}

// The per-season event-waiver templates from Legal (00074), passed down from
// the page so the dialog can pre-fill the waiver box without a round trip.
export interface WaiverTemplateContext {
  templates: { season_id: string; content: string }[];
  activeSeasonId: string | null;
}

function TournamentFormDialog({
  open,
  onClose,
  tournament,
  waiverTemplates,
}: {
  open: boolean;
  onClose: () => void;
  tournament?: TournamentData;
  waiverTemplates: WaiverTemplateContext;
}) {
  const isEdit = !!tournament;
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState(tournament?.name ?? '');
  const [scope, setScope] = useState(tournament?.scope ?? 'open');
  const [type, setType] = useState(tournament?.type ?? 'internal');
  const [format, setFormat] = useState(tournament?.format ?? 'singles');
  const [startDate, setStartDate] = useState(tournament?.start_date ?? '');
  const [endDate, setEndDate] = useState(tournament?.end_date ?? '');
  const [bracketSize, setBracketSize] = useState(tournament?.bracket_size ?? 8);
  const [eventMultiplier, setEventMultiplier] = useState(tournament?.event_multiplier ?? 1.15);
  const [placementBonus, setPlacementBonus] = useState(tournament?.placement_bonus_enabled ?? true);
  const [waiverText, setWaiverText] = useState(tournament?.waiver_text ?? '');
  const [allowedMemberships, setAllowedMemberships] = useState<string[]>(
    (tournament as { allowed_memberships?: string[] } | undefined)?.allowed_memberships
      ?? ALL_MEMBERSHIP_TYPES,
  );
  const { toast } = useToast();
  const router = useRouter();

  // An existing tournament offers its own season's wording; a new one offers
  // the active season's, which is the season createTournament will stamp on it.
  const seasonTemplate = resolveEventWaiverTemplate(
    waiverTemplates.templates,
    tournament?.season_id,
    waiverTemplates.activeSeasonId
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      const data = {
        name,
        scope,
        type,
        format,
        start_date: startDate,
        end_date: endDate || undefined,
        bracket_size: bracketSize,
        allowed_memberships: allowedMemberships,
        event_multiplier: eventMultiplier,
        placement_bonus_enabled: placementBonus,
        waiver_text: waiverText,
      };
      if (isEdit) {
        await updateTournament(tournament.id, data);
        toast('Tournament updated', 'success');
      } else {
        await createTournament(data);
        toast('Tournament created', 'success');
      }
      onClose();
      if (!isEdit) {
        setName(''); setStartDate(''); setEndDate('');
        setScope('open'); setType('internal'); setFormat('singles');
        setBracketSize(8); setEventMultiplier(1.15); setPlacementBonus(true);
        setWaiverText('');
      }
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  return (
    <Dialog open={open} onClose={onClose} title={isEdit ? 'Edit Tournament' : 'Create Tournament'}>
      <form onSubmit={handleSubmit} className="space-y-4">
        <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
        {/* Who may register. Unticking a group stops it at registration — the
            check is in the server action, since that path uses the service-role
            key and bypasses RLS entirely. At least one must stay ticked; an
            empty list bars everyone, including admins. */}
        <fieldset className="space-y-1">
          <legend className="block text-[13px] font-medium text-[var(--text-secondary)] mb-1.5">
            Open to
          </legend>
          <div className="flex flex-wrap gap-3">
            {MEMBERSHIP_TYPES.map((m) => {
              const checked = allowedMemberships.includes(m.value);
              const isLastChecked = checked && allowedMemberships.length === 1;
              return (
                <label key={m.value} className="flex items-center gap-2 text-sm" title={m.description}>
                  <input
                    type="checkbox"
                    checked={checked}
                    disabled={isLastChecked}
                    onChange={(e) =>
                      setAllowedMemberships((prev) =>
                        e.target.checked ? [...prev, m.value] : prev.filter((v) => v !== m.value),
                      )
                    }
                  />
                  {m.label}
                </label>
              );
            })}
          </div>
        </fieldset>
        <div className="grid grid-cols-2 gap-4">
          <Select
            label="Scope"
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            options={[
              { value: 'open', label: 'Open' },
              { value: 'eligible_only', label: 'Eligible Only' },
            ]}
          />
          <Select
            label="Type"
            value={type}
            onChange={(e) => setType(e.target.value)}
            options={[
              { value: 'internal', label: 'Internal' },
              { value: 'open_official', label: 'Open Official' },
              { value: 'invitational', label: 'Invitational' },
            ]}
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <Select
            label="Format"
            value={format}
            onChange={(e) => setFormat(e.target.value)}
            options={[
              { value: 'singles', label: 'Singles' },
              { value: 'doubles', label: 'Doubles' },
              { value: 'mixed_event', label: 'Mixed Event' },
            ]}
          />
          <Select
            label="Bracket Size"
            value={String(bracketSize)}
            onChange={(e) => setBracketSize(Number(e.target.value))}
            options={[
              { value: '4', label: '4 players' },
              { value: '8', label: '8 players' },
              { value: '16', label: '16 players' },
              { value: '32', label: '32 players' },
            ]}
          />
        </div>
        <div className="grid grid-cols-2 gap-4">
          <DatePicker label="Start Date" value={startDate} onChange={setStartDate} required />
          <DatePicker label="End Date" value={endDate} onChange={setEndDate} />
        </div>
        <Input
          label="Elo Multiplier"
          type="number"
          value={String(eventMultiplier)}
          onChange={(e) => setEventMultiplier(Number(e.target.value))}
        />
        <div className="flex items-center gap-3">
          <Switch checked={placementBonus} onChange={setPlacementBonus} />
          <span className="text-sm text-[var(--text-secondary)]">Enable placement bonuses</span>
        </div>
        <div>
          <Textarea
            label="Event waiver (optional)"
            value={waiverText}
            onChange={(e) => setWaiverText(e.target.value)}
            rows={5}
          />
          <div className="flex items-start justify-between gap-3 mt-1">
            <p className="text-xs text-[var(--text-muted)]">
              Participants must accept this before registering. Leave blank for none.
            </p>
            {/* Copies the season's template text in — it is not linked. Editing
                the template in Legal afterwards must not change a waiver
                participants have already accepted (event_waiver_acceptances
                pins a hash of the accepted text).
                The label changes when the box is non-empty rather than opening
                a confirm dialog: this is already inside a Dialog, and the
                wording is enough to say the click overwrites. */}
            <Button
              type="button"
              variant="ghost"
              className="text-xs flex-shrink-0"
              disabled={!seasonTemplate || waiverText === seasonTemplate}
              title={
                seasonTemplate
                  ? "Fill the box with this season's event waiver template from Legal"
                  : 'No event waiver template for this season — add one in Legal'
              }
              onClick={() => {
                if (!seasonTemplate) return;
                setWaiverText(seasonTemplate);
              }}
            >
              {waiverText.trim() ? 'Replace with template' : 'Use season template'}
            </Button>
          </div>
        </div>
        <div className="flex items-center justify-between">
          <Button variant="ghost" onClick={onClose} type="button" className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">Cancel</Button>
          <Button type="submit" loading={loading} className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">{isEdit ? 'Save Changes' : 'Create'}</Button>
        </div>
      </form>
    </Dialog>
  );
}

export function CreateTournamentForm({ waiverTemplates }: { waiverTemplates: WaiverTemplateContext }) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button onClick={() => setOpen(true)} className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">New Tournament</Button>
      <TournamentFormDialog open={open} onClose={() => setOpen(false)} waiverTemplates={waiverTemplates} />
    </>
  );
}

export function TournamentMenu({
  tournament,
  waiverTemplates,
}: {
  tournament: TournamentData;
  waiverTemplates: WaiverTemplateContext;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  const router = useRouter();

  async function handleArchive() {
    try {
      await archiveTournament(tournament.id);
      toast('Tournament archived', 'success');
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
  }

  async function handleDelete() {
    setLoading(true);
    try {
      await deleteTournament(tournament.id);
      toast('Tournament deleted', 'success');
      setConfirmDelete(false);
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  return (
    <div onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}>
      <Dropdown
        trigger={
          <button
            aria-label="Tournament menu"
            className="p-1.5 rounded-lg hover:bg-[var(--border-hover)] transition-colors text-[var(--text-muted)] hover:text-[var(--text-primary)] focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:outline-none"
          >
            <MoreVertical className="w-4 h-4" />
          </button>
        }
        items={[
          { label: 'Edit', onClick: () => setEditOpen(true) },
          ...(tournament.status !== 'archived' ? [{ label: 'Archive', onClick: handleArchive }] : []),
          { label: 'Delete', onClick: () => setConfirmDelete(true), danger: true },
        ]}
      />

      <TournamentFormDialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        tournament={tournament}
        waiverTemplates={waiverTemplates}
      />

      <Dialog open={confirmDelete} onClose={() => setConfirmDelete(false)} title="Delete Tournament">
        <div className="space-y-4">
          <p className="text-sm text-[var(--text-secondary)]">
            Are you sure you want to permanently delete <strong>{tournament.name}</strong>? This will also remove all participants and events. This action cannot be undone.
          </p>
          <div className="flex items-center justify-between">
            <Button variant="ghost" onClick={() => setConfirmDelete(false)} className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">Cancel</Button>
            <Button variant="danger" onClick={handleDelete} loading={loading} className="focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-blue-500 focus-visible:outline-none">Delete</Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
