'use client';

import { useState, useTransition } from 'react';
import { Button, Dialog, Input, Select } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import { createPlayer } from '@/lib/actions';
import { Plus } from 'lucide-react';

const STATUS_OPTIONS = [
  { value: 'competitive', label: 'Competitive' },
  { value: 'recreational', label: 'Recreational' },
];

// Admin accounts are never created from this dialog — promote an existing,
// signed-up member via Edit instead (an added "player" has no login yet, and
// a passwordless admin account would bypass the passkey enrollment flow).
const ROLE_OPTIONS = [
  { value: 'player', label: 'Player' },
  { value: 'exec', label: 'Executive' },
];

export function AddPlayerButton() {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState('recreational');
  const [role, setRole] = useState('player');
  const { toast } = useToast();
  const router = useRouter();

  function handleSubmit() {
    if (!fullName.trim() || !email.trim()) {
      toast('Name and email are required', 'error');
      return;
    }
    startTransition(async () => {
      try {
        const res = await createPlayer({
          full_name: fullName.trim(),
          email: email.trim().toLowerCase(),
          status,
          role: 'player',
          is_exec: role === 'exec',
        });
        if (!res.ok) { toast(res.error, 'error'); return; }
        toast('Player created', 'success');
        setOpen(false);
        setFullName('');
        setEmail('');
        setStatus('recreational');
        setRole('player');
        router.refresh();
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Failed to create player', 'error');
      }
    });
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>
        <Plus className="w-4 h-4 mr-1.5" /> Add Player
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Add New Player">
        <div className="space-y-4">
          <Input
            label="Full Name"
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            placeholder="John Doe"
          />
          <Input
            label="Email"
            type="email"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            placeholder="john@sfu.ca"
          />
          <Select
            label="Status"
            options={STATUS_OPTIONS}
            value={status}
            onChange={(e) => setStatus(e.target.value)}
          />
          <Select
            label="Role"
            options={ROLE_OPTIONS}
            value={role}
            onChange={(e) => setRole(e.target.value)}
          />
          <div className="flex items-center justify-between pt-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>Cancel</Button>
            <Button
              onClick={handleSubmit}
              loading={isPending}
              disabled={!fullName.trim() || !email.trim()}
            >
              Create Player
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
