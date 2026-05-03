'use client';

import { useState, type CSSProperties, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import {
  acceptChallenge,
  rejectChallenge,
  cancelChallenge,
  reportWalkover,
} from '@/lib/actions';
import { useToast } from '@/components/toast-provider';

// ─────────────────────────────────────────────────────────────────
// Mode controls which buttons render. Computed at the page level
// from each challenge's status + the player's role on it.
//
//   incoming-pending — challenge sent TO me, awaiting my response
//   sent-pending     — challenge I sent, awaiting opponent
//   active           — accepted, no result logged yet
//   disputed         — match result is under dispute
//   completed        — done (no inline actions)
// ─────────────────────────────────────────────────────────────────
export type ChallengeCardMode =
  | 'incoming-pending'
  | 'sent-pending'
  | 'active'
  | 'disputed'
  | 'completed';

interface Props {
  challengeId: string;
  mode: ChallengeCardMode;
  /** UUID of the opposing player — required for the inline "no-show" button
   *  in active mode (so we can call reportWalkover without a round-trip).
   *  Optional for other modes. */
  opponentId?: string | null;
  /** Caller-provided callback fired when this card should disappear from the list
   *  (accept/reject/cancel succeeded). Optional — caller may rely on
   *  router.refresh() instead. */
  onRemoved?: () => void;
}

export function InlineChallengeActions({ challengeId, mode, opponentId, onRemoved }: Props) {
  const { toast } = useToast();
  const router = useRouter();
  const [pending, setPending] = useState<string | null>(null);
  // 2-tap confirm state — null = first-tap state, key = "confirm next tap"
  const [confirming, setConfirming] = useState<string | null>(null);

  async function run(
    label: string,
    fn: () => Promise<unknown>,
    successMsg: string,
    successKind: 'success' | 'info' = 'success',
    removesCard = true
  ) {
    setPending(label);
    setConfirming(null);
    try {
      await fn();
      toast(successMsg, successKind);
      if (removesCard) onRemoved?.();
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
      setPending(null);
    }
    // Don't clear `pending` on success when we hide the card — the parent
    // unmounts the row, so leaving the button visually "pending" until the
    // re-render is preferable to a flash of "ready" state.
  }

  // ── incoming-pending: Accept (1-tap) + Reject (2-tap confirm) ──
  if (mode === 'incoming-pending') {
    const rejectConfirming = confirming === 'reject';
    return (
      <>
        <IconButton
          variant="primary"
          ariaLabel="Accept challenge"
          disabled={pending !== null}
          loading={pending === 'accept'}
          onClick={(e) => {
            e.stopPropagation();
            void run('accept', () => acceptChallenge(challengeId), 'Challenge accepted', 'success');
          }}
        >
          ✓
        </IconButton>
        <IconButton
          variant={rejectConfirming ? 'danger-active' : 'ghost'}
          ariaLabel={rejectConfirming ? 'Confirm reject' : 'Reject challenge'}
          disabled={pending !== null && pending !== 'reject'}
          loading={pending === 'reject'}
          onClick={(e) => {
            e.stopPropagation();
            if (!rejectConfirming) {
              setConfirming('reject');
              return;
            }
            void run('reject', () => rejectChallenge(challengeId), 'Challenge rejected', 'info');
          }}
        >
          {rejectConfirming ? '?' : '✕'}
        </IconButton>
      </>
    );
  }

  // ── sent-pending: Cancel (2-tap confirm) ──
  if (mode === 'sent-pending') {
    const cancelConfirming = confirming === 'cancel';
    return (
      <CompactButton
        variant={cancelConfirming ? 'danger-active' : 'ghost'}
        disabled={pending !== null && pending !== 'cancel'}
        loading={pending === 'cancel'}
        onClick={(e) => {
          e.stopPropagation();
          if (!cancelConfirming) {
            setConfirming('cancel');
            return;
          }
          void run('cancel', () => cancelChallenge(challengeId), 'Challenge cancelled', 'info');
        }}
      >
        {cancelConfirming ? 'Tap to confirm' : 'Cancel'}
      </CompactButton>
    );
  }

  // ── active: Log Result link + Walkover (2-tap confirm) ──
  if (mode === 'active') {
    const walkoverConfirming = confirming === 'walkover';
    // Without a known opponent we can't fire the no-show action without a
    // round-trip; degrade gracefully to a link to the detail page where the
    // existing walkover dialog lets the user pick the type.
    const canInlineWalkover = !!opponentId;
    return (
      <>
        <CompactLink href={`/challenges/${challengeId}`}>Log result →</CompactLink>
        {canInlineWalkover ? (
          <CompactButton
            variant={walkoverConfirming ? 'danger-active' : 'ghost'}
            disabled={pending !== null && pending !== 'walkover'}
            loading={pending === 'walkover'}
            onClick={(e) => {
              e.stopPropagation();
              if (!walkoverConfirming) {
                setConfirming('walkover');
                return;
              }
              void run(
                'walkover',
                () =>
                  reportWalkover({
                    challenge_id: challengeId,
                    forfeit_player_id: opponentId,
                    walkover_type: 'no_show',
                  }),
                'Walkover reported. Admin will review.',
                'info',
                false
              );
            }}
          >
            {walkoverConfirming ? 'Confirm no-show?' : 'No-show'}
          </CompactButton>
        ) : (
          <CompactLink href={`/challenges/${challengeId}`}>No-show →</CompactLink>
        )}
      </>
    );
  }

  // ── disputed: View only (read-only inline) ──
  if (mode === 'disputed') {
    return <CompactLink href={`/challenges/${challengeId}`}>View dispute →</CompactLink>;
  }

  // ── completed: nothing inline (the card is just informational) ──
  return null;
}

// ─────────────────────────────────────────────────────────────────
// Shared button primitives — small, tokenized, no Tailwind. Mirrors
// the existing card surface so the actions read as part of the row.
// ─────────────────────────────────────────────────────────────────

const baseButtonStyle: CSSProperties = {
  fontFamily: 'inherit',
  cursor: 'pointer',
  fontWeight: 700,
  letterSpacing: '0.04em',
};

function IconButton({
  children,
  variant,
  onClick,
  disabled,
  loading,
  ariaLabel,
}: {
  children: ReactNode;
  variant: 'primary' | 'ghost' | 'danger-active';
  onClick: (e: React.MouseEvent) => void;
  disabled?: boolean;
  loading?: boolean;
  ariaLabel: string;
}) {
  const styles: Record<typeof variant, CSSProperties> = {
    primary: {
      background: 'var(--red)',
      color: '#F2F2F2',
      border: 'none',
    },
    ghost: {
      background: 'transparent',
      color: '#F2F2F2',
      border: '1px solid var(--hairline)',
    },
    'danger-active': {
      background: 'var(--red)',
      color: '#F2F2F2',
      border: '1px solid var(--red)',
    },
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || loading}
      aria-label={ariaLabel}
      style={{
        ...baseButtonStyle,
        ...styles[variant],
        width: 36,
        height: 36,
        fontSize: 16,
        opacity: loading ? 0.6 : disabled ? 0.4 : 1,
        cursor: loading || disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {children}
    </button>
  );
}

function CompactButton({
  children,
  variant,
  onClick,
  disabled,
  loading,
}: {
  children: ReactNode;
  variant: 'ghost' | 'danger-active';
  onClick: (e: React.MouseEvent) => void;
  disabled?: boolean;
  loading?: boolean;
}) {
  const styles: Record<typeof variant, CSSProperties> = {
    ghost: {
      background: 'transparent',
      color: 'var(--text)',
      border: '1px solid var(--hairline)',
    },
    'danger-active': {
      background: 'var(--red)',
      color: '#F2F2F2',
      border: '1px solid var(--red)',
    },
  };
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled || loading}
      style={{
        ...baseButtonStyle,
        ...styles[variant],
        height: 32,
        padding: '0 12px',
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: '0.12em',
        whiteSpace: 'nowrap',
        opacity: loading ? 0.6 : disabled ? 0.4 : 1,
        cursor: loading || disabled ? 'not-allowed' : 'pointer',
      }}
    >
      {loading ? '…' : children}
    </button>
  );
}

function CompactLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      onClick={(e) => e.stopPropagation()}
      style={{
        ...baseButtonStyle,
        background: 'transparent',
        color: 'var(--ink)',
        border: '1px solid var(--hairline)',
        height: 32,
        padding: '0 12px',
        fontSize: 11,
        textTransform: 'uppercase',
        letterSpacing: '0.12em',
        whiteSpace: 'nowrap',
        textDecoration: 'none',
        display: 'inline-flex',
        alignItems: 'center',
      }}
    >
      {children}
    </Link>
  );
}
