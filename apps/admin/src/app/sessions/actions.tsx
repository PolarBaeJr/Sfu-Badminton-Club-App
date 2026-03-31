'use client';

import { useState } from 'react';
import { Button, Dialog, Input } from '@badminton/ui';
import { closeSession, createSession } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';

export function SessionActions({ sessionId }: { sessionId: string }) {
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  async function handleClose() {
    setLoading(true);
    try {
      await closeSession(sessionId);
      toast('Session closed', 'success');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  return (
    <Button variant="danger" size="sm" onClick={handleClose} loading={loading}>
      Close Session
    </Button>
  );
}

export function CreateSessionForm() {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState('');
  const [date, setDate] = useState('');
  const [location, setLocation] = useState('');
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  async function handleCreate(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await createSession({ name, date, location });
      toast('Session created', 'success');
      setOpen(false);
      setName(''); setDate(''); setLocation('');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  return (
    <>
      <Button onClick={() => setOpen(true)}>New Session</Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Create Session">
        <form onSubmit={handleCreate} className="space-y-4">
          <Input label="Name" value={name} onChange={(e) => setName(e.target.value)} required />
          <Input label="Date" type="date" value={date} onChange={(e) => setDate(e.target.value)} required />
          <Input label="Location" value={location} onChange={(e) => setLocation(e.target.value)} required />
          <div className="flex gap-2">
            <Button type="submit" loading={loading}>Create</Button>
            <Button variant="ghost" onClick={() => setOpen(false)} type="button">Cancel</Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
