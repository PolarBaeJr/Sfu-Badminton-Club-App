'use client';

import { useState } from 'react';
import { usePathname, useRouter } from 'next/navigation';
import { Loader2, LogOut } from 'lucide-react';
import { createClient } from '@/lib/supabase-browser';
// Deep import, not the '@badminton/shared' barrel — see the player middleware.
import { clearHostOnlyAuthCookies } from '@badminton/shared/src/utils/constants';
import { restoreMyAccount } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';

const RETENTION_DAYS = 30;

// Paths where the gate must never render — mirrors WaiverGate's exempt list
// (the public routes from middleware.ts plus /onboarding).
function isExemptPath(pathname: string) {
  return (
    pathname === '/' ||
    pathname.startsWith('/login') ||
    pathname.startsWith('/auth') ||
    pathname.startsWith('/exec') ||
    pathname === '/leaderboard' ||
    pathname.startsWith('/onboarding')
  );
}

// Full-screen, non-dismissable overlay shown while an account sits inside its
// 30-day deletion-retention window (players.deletion_requested_at set).
// Signing back in and hitting restore is the player's self-service revert
// path; the layout suppresses the waiver gate while this one is active.
export function DeletionGate({ deletionRequestedAt }: { deletionRequestedAt: string | null }) {
  const pathname = usePathname();
  const router = useRouter();
  const { toast } = useToast();
  const [restoring, setRestoring] = useState(false);

  const active = !!deletionRequestedAt && !isExemptPath(pathname);
  if (!active) return null;

  const purgeDate = new Date(
    new Date(deletionRequestedAt!).getTime() + RETENTION_DAYS * 24 * 60 * 60 * 1000
  );
  const purgeLabel = purgeDate.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  async function handleRestore() {
    setRestoring(true);
    try {
      const res = await restoreMyAccount();
      if (!res.ok) {
        toast(res.error, 'error');
        setRestoring(false);
        return;
      }
      toast('Welcome back — your account has been restored', 'success');
      // Deliberately stay in the restoring state: refresh() re-runs the
      // server layout, which recomputes deletion_requested_at and unmounts
      // the gate.
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to restore account', 'error');
      setRestoring(false);
    }
  }

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    // See clearHostOnlyAuthCookies: signOut alone can leave a pre-migration
    // host-only cookie behind, which would still read as a live session.
    clearHostOnlyAuthCookies();
    router.push('/login');
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Account scheduled for deletion"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        background: 'var(--bg-overlay)',
        backdropFilter: 'blur(6px)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 16,
      }}
    >
      <div
        className="card-base"
        style={{ width: '100%', maxWidth: 480, display: 'flex', flexDirection: 'column', gap: 14 }}
      >
        <div>
          <div className="card-title card-title-lg">Account scheduled for deletion</div>
          <div className="card-sub">
            Your account is deactivated and will be permanently anonymized on {purgeLabel}.
          </div>
        </div>

        <p className="muted" style={{ fontSize: 13, lineHeight: 1.5, margin: 0 }}>
          Signing in before that date lets you restore your account. After it, your
          personal information is removed and your login deleted — your match and
          rating history remains under an anonymous name.
        </p>

        <button
          type="button"
          onClick={handleRestore}
          disabled={restoring}
          className="btn btn-primary btn-lg"
          style={{ width: '100%', justifyContent: 'center', height: 48 }}
        >
          {restoring ? <Loader2 size={16} className="animate-spin" /> : null}
          Restore my account
        </button>
        <button
          type="button"
          onClick={handleSignOut}
          className="btn btn-ghost"
          style={{ width: '100%', justifyContent: 'center' }}
        >
          <LogOut size={14} />
          Sign out
        </button>
      </div>
    </div>
  );
}
