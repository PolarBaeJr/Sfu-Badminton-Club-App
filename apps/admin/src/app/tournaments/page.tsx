import { createServerSupabaseClient } from '@/lib/supabase-server';
import { Card, Badge } from '@badminton/ui';
import { formatDate } from '@badminton/shared';
import { CreateTournamentForm } from './actions';
import Link from 'next/link';
import { Trophy, Users, Calendar, Zap } from 'lucide-react';

export default async function TournamentsPage() {
  const supabase = await createServerSupabaseClient();

  // Try new schema first (tournament_events), fall back to old schema
  let tournaments: any[] | null = null;
  const { data: tournamentsWithEvents } = await supabase
    .from('tournaments')
    .select('*, tournament_events(count)')
    .order('start_date', { ascending: false });

  if (tournamentsWithEvents) {
    tournaments = tournamentsWithEvents;
  } else {
    // Fallback: migration not yet run, query without join
    const { data: fallback } = await supabase
      .from('tournaments')
      .select('*')
      .order('start_date', { ascending: false });
    tournaments = fallback;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
      {/* Page Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
          <div style={{
            width: '2.5rem',
            height: '2.5rem',
            borderRadius: '0.75rem',
            background: 'var(--color-accent)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
          }}>
            <Trophy size={20} style={{ color: 'white' }} />
          </div>
          <div>
            <h1 style={{
              fontSize: '1.875rem',
              fontWeight: 700,
              color: 'var(--text-primary)',
              lineHeight: 1.2,
            }}>
              TOURNAMENTS
            </h1>
            <p style={{
              fontSize: '0.875rem',
              color: 'var(--text-muted)',
              marginTop: '0.125rem',
            }}>
              Manage brackets, participants, and results
            </p>
          </div>
        </div>
        <CreateTournamentForm />
      </div>

      {/* Tournament List */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {tournaments?.map((t) => {
          const eventCount = Array.isArray(t.tournament_events) ? t.tournament_events[0]?.count ?? 0 : (t.tournament_events as any)?.count ?? 0;
          return (
            <Link key={t.id} href={`/tournaments/${t.id}`} style={{ textDecoration: 'none' }}>
              <Card>
                <div style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'space-between',
                  gap: '1rem',
                }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', flex: 1 }}>
                    {/* Title row with status badge */}
                    <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      <h3 style={{
                        color: 'var(--text-primary)',
                        fontWeight: 600,
                        fontSize: '1.05rem',
                      }}>
                        {t.name}
                      </h3>
                      <Badge variant={t.status === 'active' ? 'success' : t.status === 'completed' ? 'neutral' : 'warning'}>
                        {t.status}
                      </Badge>
                    </div>

                    {/* Metadata row */}
                    <div style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: '1rem',
                      flexWrap: 'wrap',
                    }}>
                      <span style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.35rem',
                        fontSize: '0.8125rem',
                        color: 'var(--text-muted)',
                      }}>
                        <Calendar size={14} style={{ opacity: 0.7 }} />
                        {formatDate(t.start_date)}
                      </span>

                      <span style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.35rem',
                        fontSize: '0.8125rem',
                        color: 'var(--text-muted)',
                      }}>
                        <Users size={14} style={{ opacity: 0.7 }} />
                        {eventCount} events
                      </span>

                      <span style={{
                        display: 'inline-flex',
                        alignItems: 'center',
                        gap: '0.35rem',
                        fontSize: '0.8125rem',
                        color: 'var(--text-muted)',
                      }}>
                        <Zap size={14} style={{ opacity: 0.7 }} />
                        {t.event_multiplier}x multiplier
                      </span>

                      <span style={{
                        fontSize: '0.8125rem',
                        color: 'var(--text-muted)',
                        padding: '0.125rem 0.5rem',
                        borderRadius: '9999px',
                        border: '1px solid var(--border)',
                        background: 'var(--bg-card)',
                      }}>
                        {t.format}
                      </span>

                      <span style={{
                        fontSize: '0.8125rem',
                        color: 'var(--text-muted)',
                        padding: '0.125rem 0.5rem',
                        borderRadius: '9999px',
                        border: '1px solid var(--border)',
                        background: 'var(--bg-card)',
                      }}>
                        {t.scope}
                      </span>

                      <span style={{
                        fontSize: '0.8125rem',
                        color: 'var(--text-muted)',
                        padding: '0.125rem 0.5rem',
                        borderRadius: '9999px',
                        border: '1px solid var(--border)',
                        background: 'var(--bg-card)',
                      }}>
                        Bracket: {t.bracket_size}
                      </span>
                    </div>
                  </div>
                </div>
              </Card>
            </Link>
          );
        })}

        {/* Empty State */}
        {(!tournaments || tournaments.length === 0) && (
          <Card>
            <div style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              padding: '2rem 1rem',
              gap: '0.75rem',
            }}>
              <Trophy size={32} style={{ color: 'var(--text-muted)', opacity: 0.5 }} />
              <p style={{
                color: 'var(--text-muted)',
                textAlign: 'center',
                fontSize: '0.9375rem',
              }}>
                No tournaments yet. Create one to get started.
              </p>
            </div>
          </Card>
        )}
      </div>
    </div>
  );
}
