'use client';

import { useRouter } from 'next/navigation';
import { Button } from '@badminton/ui';
import { LogOut } from 'lucide-react';
import { createClient } from '@/lib/supabase-browser';
// Deep import, not the '@badminton/shared' barrel: see the player middleware.
import { signOutThisDevice } from '@badminton/shared/src/utils/sign-out';
import { withBase } from '@/lib/base-path';
import { AddConsolePasskey } from '../settings/add-console-passkey';

export function PasskeyRequiredActions({ next }: { next: string }) {
  const router = useRouter();

  async function handleSignOut() {
    await signOutThisDevice(createClient().auth);
    window.location.href = withBase('/login');
  }

  return (
    <div className="mt-8 space-y-4">
      {/* The register verify route sets the verified cookie, so the next
          request passes the gate. */}
      <AddConsolePasskey onAdded={() => router.replace(next)} />
      <Button variant="ghost" onClick={handleSignOut}>
        <LogOut className="w-4 h-4" />
        Sign out
      </Button>
    </div>
  );
}
