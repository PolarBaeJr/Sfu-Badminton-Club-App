'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { CheckCircle2, Loader2, XCircle } from 'lucide-react';
import { checkInWithToken } from '@/lib/actions';

type State =
  | { kind: 'pending' }
  | { kind: 'checked_in' }
  | { kind: 'already' }
  | { kind: 'error'; message: string };

export function CheckinClient({ token }: { token: string }) {
  const [state, setState] = useState<State>({ kind: 'pending' });
  // Effects run twice under React StrictMode in dev. The action is idempotent,
  // but the guard keeps the displayed result from flickering.
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    (async () => {
      try {
        const res = await checkInWithToken(token);
        if (!res.ok) {
          setState({ kind: 'error', message: res.error });
          return;
        }
        setState({ kind: res.data.alreadyCheckedIn ? 'already' : 'checked_in' });
      } catch (err) {
        setState({
          kind: 'error',
          message: err instanceof Error ? err.message : 'Something went wrong — please try again.',
        });
      }
    })();
  }, [token]);

  return (
    <div className="max-w-md mx-auto py-16 px-4">
      <div className="card-base" style={{ padding: 28, textAlign: 'center' }}>
        {state.kind === 'pending' && (
          <>
            <Loader2 size={28} className="animate-spin" style={{ margin: '0 auto 14px', color: 'var(--mute)' }} />
            <div style={{ fontFamily: 'var(--display)', fontSize: 22, fontWeight: 700 }}>Checking you in…</div>
          </>
        )}

        {state.kind === 'checked_in' && (
          <>
            <CheckCircle2 size={32} style={{ margin: '0 auto 14px', color: 'var(--red)' }} />
            <div style={{ fontFamily: 'var(--display)', fontSize: 22, fontWeight: 700 }}>You&apos;re checked in</div>
            <div className="page-sub" style={{ marginTop: 8 }}>Have a good session.</div>
          </>
        )}

        {state.kind === 'already' && (
          <>
            <CheckCircle2 size={32} style={{ margin: '0 auto 14px', color: 'var(--mute)' }} />
            <div style={{ fontFamily: 'var(--display)', fontSize: 22, fontWeight: 700 }}>Already checked in</div>
            <div className="page-sub" style={{ marginTop: 8 }}>No need to scan again.</div>
          </>
        )}

        {state.kind === 'error' && (
          <>
            <XCircle size={32} style={{ margin: '0 auto 14px', color: 'var(--red)' }} />
            <div style={{ fontFamily: 'var(--display)', fontSize: 22, fontWeight: 700 }}>Couldn&apos;t check you in</div>
            <div className="alert-danger" style={{ marginTop: 12 }}>{state.message}</div>
          </>
        )}

        <Link href="/sessions" className="btn btn-ghost btn-lg" style={{ marginTop: 20, width: '100%', justifyContent: 'center' }}>
          Go to sessions
        </Link>
      </div>
    </div>
  );
}
