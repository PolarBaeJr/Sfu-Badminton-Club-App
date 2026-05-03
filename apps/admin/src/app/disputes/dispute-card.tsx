'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { resolveDispute } from '@/lib/actions/dispute-actions';
import { useToast } from '@/components/toast-provider';

interface DisputeCardProps {
  disputeId: string;
  number: string;
  filedDate: string;
  status: 'open' | 'resolved' | 'escalated';
  playersLine: string;
  matchSubLabel: string;
  issueValue: string;
  issueSub: string;
  submissions?: Array<{ name: string; score: string; result?: string }>;
  requestedOutcome?: { value: string; sub?: string };
  resolutionLine?: string;
  outcomeLine?: { value: string; sub?: string };
  primaryActionLabel?: string;
  secondaryActionLabel?: string;
}

export function DisputeCard({
  disputeId,
  number,
  filedDate,
  status,
  playersLine,
  matchSubLabel,
  issueValue,
  issueSub,
  submissions,
  requestedOutcome,
  resolutionLine,
  outcomeLine,
  primaryActionLabel = 'Resolve — Accept Submission',
  secondaryActionLabel,
}: DisputeCardProps) {
  const { toast } = useToast();
  const router = useRouter();
  const [resolved, setResolved] = useState(status === 'resolved');
  const [pending, setPending] = useState<string | null>(null);

  async function run(type: 'accepted' | 'voided' | 'converted_to_casual', note: string) {
    if (resolved) return;
    setPending(type);
    try {
      await resolveDispute({
        dispute_id: disputeId,
        resolution_type: type,
        resolution_note: note,
      });
      setResolved(true);
      toast('Resolution applied', 'success');
      router.refresh();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setPending(null);
  }

  const headerBadge = resolved ? `Resolved · ${formatNow()}` : `Open · Filed ${filedDate}`;
  const headerBadgeClass = resolved ? 'badge resolved' : 'badge open';

  return (
    <article
      className={resolved ? 'dispute resolved-card' : 'dispute'}
      style={{
        borderBottom: '1px solid var(--hairline)',
        background: 'var(--surface1)',
        opacity: resolved && status !== 'open' ? 0.5 : 1,
      }}
    >
      <div
        style={{
          padding: '20px 48px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          borderBottom: '1px solid var(--hairline-soft)',
        }}
      >
        <div
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 700,
            fontSize: 22,
            letterSpacing: '0.02em',
            color: 'var(--ink)',
          }}
        >
          <span style={{ color: 'var(--faint)', marginRight: 4 }}>#</span>Dispute {number}
        </div>
        <span
          className={headerBadgeClass}
          style={{
            display: 'inline-block',
            fontSize: 9,
            letterSpacing: '0.15em',
            textTransform: 'uppercase',
            fontWeight: 600,
            padding: '3px 8px',
            background: resolved
              ? 'rgba(255,255,255,0.05)'
              : 'rgba(204,0,0,0.10)',
            color: resolved ? 'var(--muted)' : 'var(--red)',
            border: `1px solid ${resolved ? 'var(--hairline)' : 'rgba(204,0,0,0.22)'}`,
            lineHeight: 1.2,
          }}
        >
          {headerBadge}
        </span>
      </div>

      <div
        style={{
          padding: '24px 48px',
          display: 'grid',
          gridTemplateColumns: '1fr 1fr 1fr',
          gap: 32,
        }}
      >
        <div>
          <div className="dispute-col-label" style={colLabelStyle}>
            Players
          </div>
          <div style={colValueStyle}>{playersLine}</div>
          <div style={colSubStyle}>{matchSubLabel}</div>
        </div>
        <div>
          <div style={colLabelStyle}>{resolved ? 'Resolution' : 'Issue'}</div>
          <div style={colValueStyle}>{resolved ? resolutionLine ?? issueValue : issueValue}</div>
          <div style={colSubStyle}>{issueSub}</div>
        </div>
        <div>
          <div style={colLabelStyle}>
            {resolved ? 'Outcome' : submissions ? 'Submissions' : 'Requested Outcome'}
          </div>
          {resolved && outcomeLine ? (
            <>
              <div style={colValueStyle}>{outcomeLine.value}</div>
              {outcomeLine.sub && <div style={colSubStyle}>{outcomeLine.sub}</div>}
            </>
          ) : submissions && submissions.length > 0 ? (
            submissions.map((s, i) => (
              <div key={i} style={{ marginBottom: 12 }}>
                <div
                  style={{
                    fontSize: 11,
                    letterSpacing: '0.14em',
                    textTransform: 'uppercase',
                    color: 'var(--muted)',
                    fontWeight: 600,
                  }}
                >
                  {s.name}
                </div>
                <div
                  style={{
                    fontFamily: 'var(--font-display)',
                    fontWeight: 600,
                    fontSize: 16,
                    color: 'var(--ink)',
                    marginTop: 2,
                    fontVariantNumeric: 'tabular-nums',
                  }}
                >
                  {s.score}
                </div>
                {s.result && (
                  <div
                    style={{
                      fontSize: 10,
                      letterSpacing: '0.16em',
                      textTransform: 'uppercase',
                      color: 'var(--faint)',
                      marginTop: 2,
                    }}
                  >
                    {s.result}
                  </div>
                )}
              </div>
            ))
          ) : requestedOutcome ? (
            <>
              <div style={colValueStyle}>{requestedOutcome.value}</div>
              {requestedOutcome.sub && <div style={colSubStyle}>{requestedOutcome.sub}</div>}
            </>
          ) : null}
        </div>
      </div>

      {!resolved && (
        <div
          style={{
            padding: '20px 48px',
            display: 'flex',
            gap: 12,
            flexWrap: 'wrap',
            borderTop: '1px solid var(--hairline-soft)',
          }}
        >
          <button
            type="button"
            disabled={pending !== null}
            onClick={() =>
              run('accepted', primaryActionLabel.replace(/^Resolve — /, ''))
            }
            style={btnRedStyle(pending !== null)}
          >
            {pending === 'accepted' ? 'Resolving…' : primaryActionLabel}
          </button>
          {secondaryActionLabel && (
            <button
              type="button"
              disabled={pending !== null}
              onClick={() => run('accepted', secondaryActionLabel)}
              style={btnDarkStyle(pending !== null)}
            >
              {secondaryActionLabel}
            </button>
          )}
          <button
            type="button"
            disabled={pending !== null}
            onClick={() => run('voided', 'Escalated for committee review')}
            style={btnGhostStyle(pending !== null)}
          >
            {pending === 'voided' ? 'Escalating…' : 'Escalate'}
          </button>
        </div>
      )}

      {resolved && status !== 'resolved' && (
        <div
          style={{
            padding: '20px 48px',
            background: 'rgba(34,197,94,0.06)',
            borderTop: '1px solid rgba(34,197,94,0.2)',
          }}
        >
          <div
            style={{
              fontSize: 11,
              letterSpacing: '0.14em',
              textTransform: 'uppercase',
              color: 'var(--green)',
              fontWeight: 600,
            }}
          >
            ✓ Resolution applied. ELO recalculated · audit entry recorded.
          </div>
        </div>
      )}
    </article>
  );
}

const colLabelStyle = {
  fontSize: 9,
  letterSpacing: '0.2em',
  textTransform: 'uppercase' as const,
  color: 'var(--faint)',
  fontWeight: 600,
  marginBottom: 8,
};

const colValueStyle = {
  fontSize: 14,
  color: 'var(--ink)',
};

const colSubStyle = {
  color: 'var(--muted)',
  fontSize: 12,
  marginTop: 6,
};

function btnRedStyle(disabled: boolean): React.CSSProperties {
  return {
    fontFamily: 'var(--font-body)',
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.16em',
    textTransform: 'uppercase',
    padding: '10px 16px',
    background: 'var(--red)',
    color: '#F2F2F2',
    border: 0,
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    lineHeight: 1,
  };
}

function btnDarkStyle(disabled: boolean): React.CSSProperties {
  return {
    fontFamily: 'var(--font-body)',
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.16em',
    textTransform: 'uppercase',
    padding: '10px 16px',
    background: 'var(--surface2)',
    color: 'var(--ink)',
    border: '1px solid var(--hairline)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    lineHeight: 1,
  };
}

function btnGhostStyle(disabled: boolean): React.CSSProperties {
  return {
    fontFamily: 'var(--font-body)',
    fontSize: 11,
    fontWeight: 700,
    letterSpacing: '0.16em',
    textTransform: 'uppercase',
    padding: '10px 16px',
    background: 'transparent',
    color: 'var(--text)',
    border: '1px solid var(--hairline)',
    cursor: disabled ? 'not-allowed' : 'pointer',
    opacity: disabled ? 0.6 : 1,
    lineHeight: 1,
  };
}

function formatNow(): string {
  try {
    return new Date().toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  } catch {
    return 'Just now';
  }
}

