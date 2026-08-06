'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { startAuthentication } from '@simplewebauthn/browser';
import { createClient } from '@/lib/supabase-browser';
// Deep import, not the '@badminton/shared' barrel — see the player middleware.
import { clearHostOnlyAuthCookies } from '@badminton/shared/src/utils/constants';
import { Button } from '@badminton/ui';
import { KeyRound, LogOut } from 'lucide-react';
import { friendlyPasskeyError } from '@/lib/passkey/errors';
import { withBase } from '@/lib/base-path';

// Only allow same-app relative paths (no protocol-relative '//', no
// backslash tricks) so ?next= can't be used as an open redirect.
function sanitizeNext(next: string | null): string {
  if (!next) return '/dashboard';
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return '/dashboard';
  return next;
}

function UnavailableContent() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [noCredentials, setNoCredentials] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) router.replace('/login');
    });
  }, [router]);

  async function handlePasskeyLogin() {
    setLoading(true);
    setError('');
    try {
      // withBase, not a bare path: fetch() does not apply Next's basePath, so
      // on the path-mounted console this would hit the player app instead.
      const optRes = await fetch(withBase('/api/passkey/auth/options'), { method: 'POST' });
      if (optRes.status === 400) {
        setNoCredentials(true);
        return;
      }
      if (!optRes.ok) throw new Error('Could not start passkey login');
      const optionsJSON = await optRes.json();

      const assertion = await startAuthentication({ optionsJSON });

      const verifyRes = await fetch(withBase('/api/passkey/auth/verify'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ credential: assertion }),
      });
      if (!verifyRes.ok) throw new Error('Passkey verification failed');

      router.replace(sanitizeNext(searchParams.get('next')));
    } catch (err) {
      setError(friendlyPasskeyError(err, 'Passkey login failed'));
    } finally {
      setLoading(false);
    }
  }

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    // See clearHostOnlyAuthCookies: signOut alone can leave a pre-migration
    // host-only cookie behind, which would still read as a live session.
    clearHostOnlyAuthCookies();
    window.location.href = withBase('/login');
  }

  return (
    <div className="min-h-screen flex items-center bg-[var(--bg-primary)]">
      <div className="max-w-xl w-full mx-auto px-6">
        <div className="page-eyebrow">
          <span className="bar" />
          Security check
        </div>
        <h1 className="page-title">Passkey required</h1>
        <p className="page-sub">
          This account is protected by a passkey. Confirm it&apos;s you to reach the admin console.
        </p>

        {noCredentials ? (
          <div className="mt-8 space-y-6">
            <p className="text-sm text-[var(--text-muted)] max-w-[52ch]">
              No passkey is enrolled for this account, but access still requires one.
              Sign out and back in, or contact another admin if this persists.
            </p>
            <Button variant="ghost" onClick={handleSignOut}>
              <LogOut className="w-4 h-4" />
              Sign out
            </Button>
          </div>
        ) : (
          <div className="mt-8 space-y-4">
            <div className="flex items-center gap-3">
              <Button onClick={handlePasskeyLogin} loading={loading}>
                <KeyRound className="w-4 h-4" />
                Log in with passkey
              </Button>
              <Button variant="ghost" onClick={handleSignOut}>
                <LogOut className="w-4 h-4" />
                Sign out
              </Button>
            </div>
            {error && <p className="text-sm text-[var(--color-danger)]">{error}</p>}
          </div>
        )}
      </div>
    </div>
  );
}

export default function UnavailablePage() {
  return (
    <Suspense fallback={null}>
      <UnavailableContent />
    </Suspense>
  );
}
