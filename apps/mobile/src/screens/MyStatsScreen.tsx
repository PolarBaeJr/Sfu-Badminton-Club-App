import { useCallback } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { summarizeSeason, settledOutcome, type SeasonRecord } from '@badminton/shared/src/utils/season-record';
import { Body, Button, Card, ErrorState, Label, Loading } from '../components/ui';
import { usePalette } from '../components/theme';
import { useLoad } from '../hooks/useLoad';
import { useAuth } from '../lib/auth/auth-context';
import { ladderPosition } from '../lib/leaderboard';
import {
  HISTORY_ROWS,
  MATCH_WINDOW,
  MY_MATCHES_SELECT,
  ownParticipant,
  seasonRecordRows,
  type MyMatchRow,
} from '../lib/my-stats';
import { useViewer } from '../lib/viewer-context';

interface MyStats {
  singlesElo: number | null;
  doublesElo: number | null;
  position: number | null;
  seasonName: string | null;
  record: SeasonRecord | null;
  recent: { id: string; playedAt: string | null; type: string | null; outcome: boolean | null; delta: number | null; score: string | null }[];
}

export function MyStatsScreen() {
  const { supabase, signOut } = useAuth();
  const viewer = useViewer();
  const p = usePalette();

  const load = useCallback(async (): Promise<MyStats> => {
    const [ratingsRes, ladderRes, seasonRes, matchesRes] = await Promise.all([
      // Explicit columns, and never the *_wins / *_losses counters: those are
      // lifetime figures that survive every season rollover.
      supabase.from('ratings').select('singles_elo, doubles_elo').eq('player_id', viewer.id).maybeSingle(),
      supabase.rpc('get_leaderboard'),
      supabase.rpc('get_active_season'),
      supabase
        .from('matches')
        .select(MY_MATCHES_SELECT)
        .eq('participants.player_id', viewer.id)
        .not('played_at', 'is', null)
        .order('played_at', { ascending: false })
        .limit(MATCH_WINDOW),
    ]);
    if (ratingsRes.error) throw new Error(`Could not read your rating: ${ratingsRes.error.message}`);
    if (ladderRes.error) throw new Error(`Could not read the ladder: ${ladderRes.error.message}`);
    if (seasonRes.error) throw new Error(`Could not read the season: ${seasonRes.error.message}`);
    if (matchesRes.error) throw new Error(`Could not read your matches: ${matchesRes.error.message}`);

    const singlesElo = ratingsRes.data?.singles_elo ?? null;
    const season = seasonRes.data?.[0] ?? null;
    const matches = (matchesRes.data ?? []) as unknown as MyMatchRow[];

    return {
      singlesElo,
      doublesElo: ratingsRes.data?.doubles_elo ?? null,
      position: ladderPosition(ladderRes.data ?? [], viewer.id, singlesElo),
      seasonName: season?.name ?? null,
      record: season ? summarizeSeason(seasonRecordRows(matches, season.id, viewer.id)) : null,
      recent: matches.slice(0, HISTORY_ROWS).map((m) => {
        const own = ownParticipant(m, viewer.id);
        return {
          id: m.id,
          playedAt: m.played_at,
          type: m.match_type,
          outcome: settledOutcome({
            match_type: m.match_type,
            result_status: m.result_status,
            win_flag: own?.win_flag ?? null,
            points_scored: own?.points_scored ?? null,
            points_allowed: own?.points_allowed ?? null,
            played_at: m.played_at,
          }),
          delta: own?.rating_delta ?? null,
          score: m.score_summary,
        };
      }),
    };
  }, [supabase, viewer.id]);
  const { state, refreshing, reload } = useLoad(load);

  return (
    <ScrollView
      style={{ backgroundColor: p.background }}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} />}
    >
      <Card>
        <Text style={[styles.name, { color: p.text }]}>{viewer.full_name ?? 'Member'}</Text>
        {viewer.handle ? <Body muted>@{viewer.handle}</Body> : null}
        {viewer.member_code ? <Body muted>Member {viewer.member_code}</Body> : null}
      </Card>

      {state.status === 'loading' ? (
        <Loading />
      ) : state.status === 'error' ? (
        <ErrorState message={state.error} onRetry={reload} />
      ) : (
        <>
          <Card>
            <Label>Rating</Label>
            <View style={styles.readouts}>
              <Readout label="Singles" value={fmtElo(state.data.singlesElo)} />
              <Readout label="Doubles" value={fmtElo(state.data.doublesElo)} />
              <Readout
                label="Ladder"
                value={state.data.position === null ? 'Not on the ladder' : `#${state.data.position}`}
              />
            </View>
          </Card>

          <Card>
            <Label>{state.data.seasonName ?? 'This season'}</Label>
            {state.data.record === null ? (
              <Body muted>No season is running.</Body>
            ) : state.data.record.played === 0 ? (
              <Body muted>No settled matches this season yet.</Body>
            ) : (
              <View style={styles.readouts}>
                <Readout label="Record" value={`${state.data.record.wins}-${state.data.record.losses}`} />
                <Readout
                  label="Singles"
                  value={`${state.data.record.singles.wins}-${state.data.record.singles.losses}`}
                />
                <Readout
                  label="Doubles"
                  value={`${state.data.record.doubles.wins}-${state.data.record.doubles.losses}`}
                />
              </View>
            )}
          </Card>

          <Card>
            <Label>Recent matches</Label>
            {state.data.recent.length === 0 ? (
              <Body muted>No matches yet.</Body>
            ) : (
              state.data.recent.map((m) => (
                <View key={m.id} style={[styles.match, { borderColor: p.line }]}>
                  <Text
                    style={[styles.outcome, { color: m.outcome === true ? p.accent : p.muted }]}
                  >
                    {m.outcome === true ? 'W' : m.outcome === false ? 'L' : '-'}
                  </Text>
                  <View style={styles.matchBody}>
                    <Text style={{ color: p.text }}>
                      {m.type === 'singles' ? 'Singles' : 'Doubles'}
                      {m.score ? `  ${m.score}` : ''}
                    </Text>
                    <Text style={{ color: p.muted, fontSize: 13 }}>{m.playedAt ? m.playedAt.slice(0, 10) : ''}</Text>
                  </View>
                  <Text style={[styles.delta, { color: p.text }]}>{fmtDelta(m.delta)}</Text>
                </View>
              ))
            )}
          </Card>
        </>
      )}

      <Button title="Sign out" onPress={() => void signOut()} variant="ghost" />
    </ScrollView>
  );
}

function Readout({ label, value }: { label: string; value: string }) {
  const p = usePalette();
  return (
    <View style={styles.readout}>
      <Text style={[styles.readoutValue, { color: p.text }]}>{value}</Text>
      <Text style={{ color: p.muted, fontSize: 13 }}>{label}</Text>
    </View>
  );
}

function fmtElo(elo: number | null): string {
  return elo === null ? '-' : String(Math.round(elo));
}

function fmtDelta(delta: number | null): string {
  if (delta === null) return '';
  const rounded = Math.round(delta);
  return rounded > 0 ? `+${rounded}` : String(rounded);
}

const styles = StyleSheet.create({
  content: { padding: 16 },
  name: { fontSize: 20, fontWeight: '700', marginBottom: 4 },
  readouts: { flexDirection: 'row', gap: 12 },
  readout: { flex: 1 },
  readoutValue: { fontSize: 18, fontWeight: '700' },
  match: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderTopWidth: 1 },
  outcome: { width: 24, fontSize: 16, fontWeight: '700' },
  matchBody: { flex: 1 },
  delta: { fontSize: 15, fontVariant: ['tabular-nums'] },
});
