import { createAdminClient } from '@/lib/supabase-server';
import { Card, Badge, Button } from '@badminton/ui';
import { formatDate } from '@badminton/shared';
import { SessionActions, CreateSessionForm } from './actions';
import { CalendarDays, MapPin, Users, Clock } from 'lucide-react';

export default async function SessionsPage() {
  const supabase = createAdminClient();

  const { data: sessions } = await supabase
    .from('sessions')
    .select('*, host:players!sessions_host_player_id_fkey(full_name), session_attendance(count)')
    .order('date', { ascending: false })
    .limit(30);

  return (
    <div className="space-y-6">
      {/* Page Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="flex items-center justify-center w-10 h-10 rounded-lg bg-[var(--color-accent)]/10">
            <CalendarDays className="w-5 h-5 text-[var(--color-accent)]" />
          </div>
          <div>
            <h1 className="text-3xl font-bold font-display text-[var(--text-primary)]">SESSIONS</h1>
            <p className="text-sm text-[var(--text-muted)]">Manage and track club sessions</p>
          </div>
        </div>
        <CreateSessionForm />
      </div>

      {/* Session Cards */}
      <div className="grid gap-4">
        {sessions?.map((s) => {
          const attendanceCount = Array.isArray(s.session_attendance) ? s.session_attendance[0]?.count ?? 0 : 0;
          return (
            <div key={s.id} className="rounded-xl border border-[var(--border)] bg-[var(--bg-card)] p-5 hover:border-[var(--border-hover)] transition-colors">
              <div className="flex items-center justify-between">
                <div className="space-y-3">
                  {/* Title + Status */}
                  <div className="flex items-center gap-3">
                    <h3 className="text-lg text-[var(--text-primary)] font-semibold">{s.name || 'Session'}</h3>
                    <Badge variant={s.status === 'open' ? 'success' : 'neutral'}>{s.status}</Badge>
                  </div>

                  {/* Metadata row */}
                  <div className="flex flex-wrap items-center gap-4 text-sm text-[var(--text-muted)]">
                    <span className="inline-flex items-center gap-1.5">
                      <Clock className="w-3.5 h-3.5" />
                      {formatDate(s.date)}
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <MapPin className="w-3.5 h-3.5" />
                      {s.location}
                    </span>
                    <span className="inline-flex items-center gap-1.5">
                      <Users className="w-3.5 h-3.5" />
                      {attendanceCount} checked in
                    </span>
                    <span className="text-xs opacity-70">
                      Host: {(s.host as Record<string, unknown>)?.full_name as string || 'N/A'}
                    </span>
                  </div>
                </div>

                {s.status === 'open' && <SessionActions sessionId={s.id} />}
              </div>
            </div>
          );
        })}

        {/* Empty State */}
        {(!sessions || sessions.length === 0) && (
          <div className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--bg-card)] p-12 flex flex-col items-center gap-3">
            <div className="w-14 h-14 rounded-full bg-[var(--border-hover)] flex items-center justify-center">
              <CalendarDays className="w-7 h-7 text-[var(--text-muted)]" />
            </div>
            <p className="text-[var(--text-primary)] font-medium">No sessions yet</p>
            <p className="text-sm text-[var(--text-muted)]">Create your first session to get started.</p>
          </div>
        )}
      </div>
    </div>
  );
}
