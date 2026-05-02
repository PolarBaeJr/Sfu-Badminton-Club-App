'use client';

import { createClient } from '@badminton/shared/supabase-browser';
import { Shield, LogOut } from 'lucide-react';

export default function UnauthorizedPage() {
  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    window.location.href = '/login';
  }

  return (
    <div className="min-h-screen flex items-center justify-center bg-[var(--bg-primary)]">
      <div className="max-w-md w-full mx-4 text-center space-y-6">
        <div className="flex items-center justify-center w-16 h-16 mx-auto rounded-full bg-red-500/10">
          <Shield className="w-8 h-8 text-red-500" />
        </div>
        <div>
          <h1 className="text-2xl font-bold font-display text-[var(--text-primary)]">
            Admin Access Required
          </h1>
          <p className="mt-2 text-[var(--text-muted)]">
            You don&apos;t have admin access to this application.
            Contact a club executive to request access.
          </p>
        </div>
        <button
          onClick={handleSignOut}
          className="inline-flex items-center gap-2 px-4 py-2 bg-[var(--bg-elevated)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors border border-[var(--border)]"
        >
          <LogOut className="w-4 h-4" />
          Sign out
        </button>
      </div>
    </div>
  );
}
