'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Button, Card, Dialog, Input, Select, Badge } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import type { Term } from '@badminton/shared';
import { createTerm, updateTerm, setActiveTerm, deleteTerm } from '@/lib/actions';

const SEASON_OPTIONS = [
  { value: 'Spring', label: 'Spring' },
  { value: 'Summer', label: 'Summer' },
  { value: 'Fall', label: 'Fall' },
];

type Season = 'Spring' | 'Summer' | 'Fall';

function TermDialog({
  term,
  open,
  onClose,
}: {
  term?: Term;
  open: boolean;
  onClose: () => void;
}) {
  const [isPending, startTransition] = useTransition();
  const [label, setLabel] = useState(term?.label ?? '');
  const [season, setSeason] = useState<Season>(term?.season ?? 'Fall');
  const [year, setYear] = useState(String(term?.year ?? new Date().getFullYear()));
  const [fee, setFee] = useState(term ? (term.default_fee_cents / 100).toFixed(2) : '');
  const [sortOrder, setSortOrder] = useState(String(term?.sort_order ?? 0));
  const { toast } = useToast();
  const router = useRouter();

  function handleSave() {
    startTransition(async () => {
      try {
        const payload = {
          label: label.trim(),
          season,
          year: parseInt(year, 10),
          default_fee_cents: Math.round(parseFloat(fee || '0') * 100),
          active: term?.active ?? false,
          sort_order: parseInt(sortOrder || '0', 10),
        };
        if (term) {
          await updateTerm(term.id, payload);
          toast('Term updated', 'success');
        } else {
          await createTerm(payload);
          toast('Term created', 'success');
        }
        onClose();
        router.refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to save term', 'error');
      }
    });
  }

  return (
    <Dialog open={open} onClose={onClose} title={term ? 'Edit Term' : 'New Term'}>
      <div className="space-y-4">
        <Input label="Label" value={label} onChange={(e) => setLabel(e.target.value)} placeholder="e.g. Fall 2026" />
        <div className="flex gap-2">
          <Select label="Season" options={SEASON_OPTIONS} value={season} onChange={(e) => setSeason(e.target.value as Season)} />
          <Input label="Year" type="number" value={year} onChange={(e) => setYear(e.target.value)} />
        </div>
        <div className="flex gap-2">
          <Input label="Default Fee $" type="number" step="0.01" min="0" value={fee} onChange={(e) => setFee(e.target.value)} placeholder="e.g. 15.00" />
          <Input label="Sort Order" type="number" value={sortOrder} onChange={(e) => setSortOrder(e.target.value)} />
        </div>
        <div className="flex gap-2">
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSave} loading={isPending} className="flex-1" disabled={!label.trim()}>
            {term ? 'Save Changes' : 'Create Term'}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

export function TermsManager({ terms }: { terms: Term[] }) {
  const [createOpen, setCreateOpen] = useState(false);
  const [editTerm, setEditTerm] = useState<Term | null>(null);
  const [isPending, startTransition] = useTransition();
  const { toast } = useToast();
  const router = useRouter();

  function handleActivate(id: string) {
    startTransition(async () => {
      try {
        await setActiveTerm(id);
        toast('Term activated', 'success');
        router.refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to activate term', 'error');
      }
    });
  }

  function handleDelete(id: string) {
    startTransition(async () => {
      try {
        await deleteTerm(id);
        toast('Term deleted', 'success');
        router.refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to delete term', 'error');
      }
    });
  }

  return (
    <Card>
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-lg font-semibold text-[var(--text-primary)]">Terms</h2>
        <Button variant="ghost" size="sm" onClick={() => setCreateOpen(true)}>New Term</Button>
      </div>

      <div className="divide-y divide-[var(--border)]">
        {terms.map((term) => (
          <div key={term.id} className="flex items-center justify-between py-3">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium text-[var(--text-primary)]">{term.label}</span>
              {term.active && <Badge variant="success">Active</Badge>}
              <span className="text-xs text-[var(--text-muted)] font-mono">
                ${(term.default_fee_cents / 100).toFixed(2)}
              </span>
            </div>
            <div className="flex gap-1">
              {!term.active && (
                <Button variant="ghost" size="sm" onClick={() => handleActivate(term.id)} loading={isPending}>
                  Set Active
                </Button>
              )}
              <Button variant="ghost" size="sm" onClick={() => setEditTerm(term)}>Edit</Button>
              <Button variant="danger" size="sm" onClick={() => handleDelete(term.id)} loading={isPending}>Delete</Button>
            </div>
          </div>
        ))}
      </div>

      {terms.length === 0 && (
        <p className="text-center text-[var(--text-muted)] py-4 text-sm">No terms yet</p>
      )}

      <TermDialog open={createOpen} onClose={() => setCreateOpen(false)} />
      {editTerm && (
        <TermDialog term={editTerm} open={Boolean(editTerm)} onClose={() => setEditTerm(null)} />
      )}
    </Card>
  );
}
