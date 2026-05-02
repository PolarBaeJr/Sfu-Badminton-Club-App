'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { acceptChallenge, rejectChallenge } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';

export function InlineChallengeActions({ challengeId }: { challengeId: string }) {
  const { toast } = useToast();
  const router = useRouter();
  const [pending, setPending] = useState<'accept' | 'reject' | null>(null);

  async function run(action: 'accept' | 'reject', e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();
    setPending(action);
    try {
      if (action === 'accept') {
        await acceptChallenge(challengeId);
        toast('Challenge accepted', 'success');
      } else {
        await rejectChallenge(challengeId);
        toast('Challenge rejected', 'info');
      }
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setPending(null);
  }

  return (
    <>
      <button
        type="button"
        onClick={(e) => run('accept', e)}
        disabled={pending !== null}
        aria-label="Accept challenge"
        style={{
          width: 36,
          height: 36,
          background: '#da291c',
          border: 'none',
          color: '#fff',
          fontSize: 16,
          cursor: pending ? 'not-allowed' : 'pointer',
          opacity: pending === 'accept' ? 0.6 : 1,
          fontFamily: 'inherit',
        }}
      >
        ✓
      </button>
      <button
        type="button"
        onClick={(e) => run('reject', e)}
        disabled={pending !== null}
        aria-label="Reject challenge"
        style={{
          width: 36,
          height: 36,
          background: 'transparent',
          border: '1px solid #303030',
          color: '#fff',
          fontSize: 16,
          cursor: pending ? 'not-allowed' : 'pointer',
          opacity: pending === 'reject' ? 0.6 : 1,
          fontFamily: 'inherit',
        }}
      >
        ✕
      </button>
    </>
  );
}
