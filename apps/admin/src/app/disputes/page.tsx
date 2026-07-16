export const dynamic = 'force-dynamic';
import { createAdminClient } from '@/lib/supabase-server';
import { Card, Badge } from '@badminton/ui';
import { formatRelativeTime, unwrap } from '@badminton/shared';
import { DisputeActions } from './actions';
import { AlertTriangle, User, MessageSquare, CheckCircle2, Scale } from 'lucide-react';

export default async function DisputesPage() {
  const supabase = createAdminClient();

  const disputes = unwrap(
    await supabase
      .from('disputes')
      .select('*, opener:players!disputes_opened_by_fkey(full_name), match:matches(score_summary, match_type, format)')
      .order('created_at', { ascending: false })
  );

  const openCount = disputes?.filter((d) => d.status === 'open').length ?? 0;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '1.5rem' }}>
      {/* Page Header */}
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
        <div
          style={{
            width: '2.5rem',
            height: '2.5rem',
            borderRadius: '0.75rem',
            background: 'var(--color-danger, #ef4444)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            flexShrink: 0,
          }}
        >
          <AlertTriangle size={20} color="white" />
        </div>
        <div>
          <h1
            style={{
              fontSize: '1.875rem',
              fontWeight: 700,
              fontFamily: 'var(--font-display, inherit)',
              color: 'var(--color-text-primary, white)',
              lineHeight: 1.2,
              margin: 0,
            }}
          >
            DISPUTES
          </h1>
          <p
            style={{
              fontSize: '0.875rem',
              color: 'var(--color-text-tertiary, #6b7280)',
              margin: 0,
            }}
          >
            {openCount > 0
              ? `${openCount} open dispute${openCount !== 1 ? 's' : ''} requiring attention`
              : 'All disputes resolved'}
          </p>
        </div>
      </div>

      {/* Dispute Cards */}
      <div style={{ display: 'grid', gap: '1rem' }}>
        {disputes?.map((d) => {
          const isOpen = d.status === 'open';
          const isResolved = d.status === 'resolved';

          return (
            <Card key={d.id}>
              <div
                style={{
                  borderLeft: `3px solid ${
                    isOpen
                      ? 'var(--color-danger, #ef4444)'
                      : isResolved
                        ? 'var(--color-success, #22c55e)'
                        : 'var(--color-warning, #f59e0b)'
                  }`,
                  paddingLeft: '1rem',
                }}
              >
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: '1rem' }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.625rem', flex: 1 }}>
                    {/* Status & Category Badges */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
                      <Badge variant={isOpen ? 'danger' : isResolved ? 'success' : 'warning'}>
                        {d.status}
                      </Badge>
                      <Badge variant="neutral">{d.reason_category}</Badge>
                    </div>

                    {/* Opener */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.375rem' }}>
                      <User
                        size={14}
                        style={{ color: 'var(--color-text-tertiary, #9ca3af)', flexShrink: 0 }}
                      />
                      <p
                        style={{
                          color: 'var(--color-text-primary, white)',
                          fontWeight: 500,
                          fontSize: '0.9375rem',
                          margin: 0,
                        }}
                      >
                        Opened by {(d.opener as Record<string, unknown>)?.full_name as string}
                      </p>
                    </div>

                    {/* Description */}
                    <div style={{ display: 'flex', alignItems: 'flex-start', gap: '0.375rem' }}>
                      <MessageSquare
                        size={14}
                        style={{
                          color: 'var(--color-text-tertiary, #9ca3af)',
                          flexShrink: 0,
                          marginTop: '0.125rem',
                        }}
                      />
                      <p
                        style={{
                          fontSize: '0.875rem',
                          color: 'var(--color-text-secondary, #9ca3af)',
                          margin: 0,
                          lineHeight: 1.5,
                        }}
                      >
                        {d.description}
                      </p>
                    </div>

                    {/* Match Info & Timestamp */}
                    <p
                      style={{
                        fontSize: '0.75rem',
                        color: 'var(--color-text-tertiary, #6b7280)',
                        margin: 0,
                      }}
                    >
                      Match: {(d.match as Record<string, unknown>)?.score_summary as string || 'N/A'} &middot; {formatRelativeTime(d.created_at)}
                    </p>

                    {/* Resolution Note */}
                    {d.resolution_note && (
                      <div
                        style={{
                          marginTop: '0.25rem',
                          padding: '0.625rem 0.75rem',
                          borderRadius: '0.5rem',
                          background: 'var(--color-surface-secondary, rgba(34, 197, 94, 0.08))',
                          border: '1px solid var(--color-border-subtle, rgba(34, 197, 94, 0.15))',
                          display: 'flex',
                          alignItems: 'flex-start',
                          gap: '0.5rem',
                        }}
                      >
                        <Scale
                          size={14}
                          style={{
                            color: 'var(--color-success, #22c55e)',
                            flexShrink: 0,
                            marginTop: '0.125rem',
                          }}
                        />
                        <div>
                          <p
                            style={{
                              fontSize: '0.75rem',
                              fontWeight: 600,
                              color: 'var(--color-success, #22c55e)',
                              margin: 0,
                              marginBottom: '0.125rem',
                              textTransform: 'uppercase',
                              letterSpacing: '0.025em',
                            }}
                          >
                            {d.resolution_type}
                          </p>
                          <p
                            style={{
                              fontSize: '0.8125rem',
                              color: 'var(--color-text-secondary, #d1d5db)',
                              margin: 0,
                              lineHeight: 1.5,
                            }}
                          >
                            {d.resolution_note}
                          </p>
                        </div>
                      </div>
                    )}
                  </div>

                  {/* Actions */}
                  {d.status !== 'resolved' && (
                    <DisputeActions disputeId={d.id} matchId={d.match_id} />
                  )}
                </div>
              </div>
            </Card>
          );
        })}

        {/* Empty State */}
        {(!disputes || disputes.length === 0) && (
          <Card>
            <div
              style={{
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                justifyContent: 'center',
                padding: '2.5rem 1rem',
                gap: '0.75rem',
              }}
            >
              <CheckCircle2
                size={40}
                style={{ color: 'var(--color-success, #22c55e)', opacity: 0.6 }}
              />
              <p
                style={{
                  color: 'var(--color-text-tertiary, #6b7280)',
                  fontSize: '0.9375rem',
                  margin: 0,
                  textAlign: 'center',
                }}
              >
                No disputes have been filed
              </p>
              <p
                style={{
                  color: 'var(--color-text-tertiary, #4b5563)',
                  fontSize: '0.8125rem',
                  margin: 0,
                  textAlign: 'center',
                }}
              >
                Disputes will appear here when players contest match results
              </p>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
