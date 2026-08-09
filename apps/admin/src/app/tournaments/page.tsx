export const dynamic = 'force-dynamic';
import { scopeToActiveSeason } from '@badminton/shared';
import { createAdminClient } from '@/lib/supabase-server';
import { Card, Badge } from '@badminton/ui';
import { formatDate, pickOne } from '@badminton/shared';
import { CreateTournamentForm, TournamentMenu, type WaiverTemplateContext } from './actions';
import type { TournamentWithEventCount } from '@/lib/tournament-types';
import Link from 'next/link';
import { Trophy, Users, Calendar, Zap, Archive } from 'lucide-react';
import { SeasonScopeChips, PastSeasonNotice, resolveSeasonScope } from '@/components/season-scope';

export default async function TournamentsPage({
  searchParams,
}: {
  searchParams: Promise<{ season?: string }>;
}) {
  const { season: seasonParam } = await searchParams;
  const supabase = createAdminClient();

  // This season's tournaments only — see scopeToActiveSeason for why an
  // unassigned tournament is kept and why no active season means no filter.
  const { data: allSeasons } = await supabase
    .from('seasons')
    .select('id, name, start_date, end_date, active_flag')
    .order('start_date', { ascending: false });
  const { seasons: seasonList, selected: scopedSeason, isPast } =
    resolveSeasonScope(allSeasons, seasonParam);

  let tournaments: TournamentWithEventCount[] | null = null;
  const { data: tournamentsWithEvents } = await scopeToActiveSeason(
    supabase.from('tournaments').select('*, tournament_events(count)'),
    scopedSeason?.id,
  ).order('start_date', { ascending: false });

  if (tournamentsWithEvents) {
    tournaments = tournamentsWithEvents;
  } else {
    const { data: fallback } = await scopeToActiveSeason(
      supabase.from('tournaments').select('*'),
      scopedSeason?.id,
    ).order('start_date', { ascending: false });
    tournaments = fallback;
  }

  const activeTournaments = tournaments?.filter((t) => t.status !== 'archived') || [];
  const archivedTournaments = tournaments?.filter((t) => t.status === 'archived') || [];

  // Per-season event-waiver templates (00074), so "Use season template" in the
  // create/edit dialog can fill the waiver box without a round trip. The active
  // season is what createTournament stamps on a new tournament, so it is the
  // season a not-yet-created tournament draws from.
  // The ACTIVE season, deliberately not the browsed one. Creating a tournament
  // always files it under the season the club is currently playing
  // (requireActiveSeasonId), so the waiver template offered in that dialog must
  // be the active season's — browsing a past term must not change what a new
  // tournament would get.
  const { data: waiverTemplates } = await supabase
    .from('event_waiver_templates').select('season_id, content');
  const waiverTemplateContext: WaiverTemplateContext = {
    templates: waiverTemplates ?? [],
    activeSeasonId: seasonList.find((s) => s.active_flag)?.id ?? null,
  };

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
            <h1 style={{ fontSize: '1.875rem', fontWeight: 700, color: 'var(--text-primary)', lineHeight: 1.2 }}>TOURNAMENTS</h1>
            <p style={{ fontSize: '0.875rem', color: 'var(--text-muted)', marginTop: '0.125rem' }}>Manage brackets, participants, and results</p>
          </div>
        </div>
        <CreateTournamentForm waiverTemplates={waiverTemplateContext} />
      </div>

      <div className="space-y-2">
        <SeasonScopeChips seasons={seasonList} selected={scopedSeason} basePath="/tournaments" />
        {isPast && scopedSeason && <PastSeasonNotice season={scopedSeason} />}
      </div>

      {/* Active Tournaments */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
        {activeTournaments.map((t) => (
          <TournamentCard key={t.id} t={t} waiverTemplates={waiverTemplateContext} />
        ))}
        {activeTournaments.length === 0 && (
          <Card>
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '2rem 1rem', gap: '0.75rem' }}>
              <Trophy size={32} style={{ color: 'var(--text-muted)', opacity: 0.5 }} />
              <p style={{ color: 'var(--text-muted)', textAlign: 'center', fontSize: '0.9375rem' }}>No tournaments yet. Create one to get started.</p>
            </div>
          </Card>
        )}
      </div>

      {/* Archived Tournaments */}
      {archivedTournaments.length > 0 && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '0.75rem' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
            <Archive size={16} style={{ color: 'var(--text-muted)' }} />
            <h2 style={{ fontSize: '0.8125rem', fontWeight: 600, color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.05em' }}>
              Archived ({archivedTournaments.length})
            </h2>
          </div>
          {archivedTournaments.map((t) => (
            <TournamentCard key={t.id} t={t} waiverTemplates={waiverTemplateContext} />
          ))}
        </div>
      )}
    </div>
  );
}

function TournamentCard({
  t,
  waiverTemplates,
}: {
  t: TournamentWithEventCount;
  waiverTemplates: WaiverTemplateContext;
}) {
  const eventCount = pickOne(t.tournament_events)?.count ?? 0;

  return (
    <Link href={`/tournaments/${t.id}`} style={{ textDecoration: 'none' }}>
      <Card>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '1rem' }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <h3 style={{ color: 'var(--text-primary)', fontWeight: 600, fontSize: '1.05rem' }}>{t.name}</h3>
              <Badge variant={
                t.status === 'active' ? 'success' :
                t.status === 'archived' ? 'neutral' :
                t.status === 'completed' ? 'neutral' :
                'warning'
              }>
                <span className="sr-only">Status: </span>{t.status}
              </Badge>
              {t.suspended_at && (
                <Badge variant="danger">
                  <span className="sr-only">Status: </span>suspended
                </Badge>
              )}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem', flexWrap: 'wrap' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                <Calendar size={14} style={{ opacity: 0.7 }} />{formatDate(t.start_date)}
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                <Users size={14} style={{ opacity: 0.7 }} />{eventCount} events
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: '0.35rem', fontSize: '0.8125rem', color: 'var(--text-muted)' }}>
                <Zap size={14} style={{ opacity: 0.7 }} />{t.event_multiplier}x multiplier
              </span>
              <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', padding: '0.125rem 0.5rem', borderRadius: '9999px', border: '1px solid var(--border)', background: 'var(--bg-card)' }}>{t.format}</span>
              <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', padding: '0.125rem 0.5rem', borderRadius: '9999px', border: '1px solid var(--border)', background: 'var(--bg-card)' }}>{t.scope}</span>
              <span style={{ fontSize: '0.8125rem', color: 'var(--text-muted)', padding: '0.125rem 0.5rem', borderRadius: '9999px', border: '1px solid var(--border)', background: 'var(--bg-card)' }}>Bracket: {t.bracket_size}</span>
            </div>
          </div>
          <div style={{ flexShrink: 0 }}>
            <TournamentMenu tournament={t} waiverTemplates={waiverTemplates} />
          </div>
        </div>
      </Card>
    </Link>
  );
}
