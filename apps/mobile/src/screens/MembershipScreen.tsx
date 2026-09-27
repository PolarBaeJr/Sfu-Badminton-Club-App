import { useCallback } from 'react';
import type { SupabaseClient } from '@supabase/supabase-js';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { money, summariseFees, type FeeLine, type OutstandingSummary } from '@badminton/shared/src/utils/fee-statement';
import { Body, Card, ErrorState, Label, Loading } from '../components/ui';
import { usePalette } from '../components/theme';
import { useLoad } from '../hooks/useLoad';
import { useAuth } from '../lib/auth/auth-context';
import {
  OWN_FEE_COLUMNS,
  buildStatementLines,
  isExempt,
  statementHeadline,
  type OwnFeeRow,
  type StatementSeason,
} from '../lib/statement';
import { isApproved } from '../lib/viewer';
import { useViewer } from '../lib/viewer-context';

export function MembershipScreen() {
  const viewer = useViewer();
  const p = usePalette();
  if (!isApproved(viewer)) {
    return (
      <View style={[styles.fill, { backgroundColor: p.background }]}>
        <View style={styles.content}>
          <Card>
            <Body muted>Your statement appears here once your membership is approved.</Body>
          </Card>
        </View>
      </View>
    );
  }
  return <Statement />;
}

function Statement() {
  const { supabase } = useAuth();
  const viewer = useViewer();
  const p = usePalette();

  const load = useCallback(async (): Promise<{ season: StatementSeason | null; summary: OutstandingSummary }> => {
    // RLS says "yours only" on club_fees as well as the explicit filter.
    const [feesRes, activeRes] = await Promise.all([
      supabase
        .from('club_fees')
        .select(OWN_FEE_COLUMNS)
        .eq('player_id', viewer.id)
        .order('created_at', { ascending: false }),
      supabase.rpc('get_active_season'),
    ]);
    if (feesRes.error) throw new Error(`Could not read your fees: ${feesRes.error.message}`);
    if (activeRes.error) throw new Error(`Could not read the season: ${activeRes.error.message}`);
    const feeRows = (feesRes.data ?? []) as unknown as OwnFeeRow[];

    // get_active_season() has no end_date, which the statement's season needs.
    const activeId = activeRes.data?.[0]?.id ?? null;
    let season: StatementSeason | null = null;
    if (activeId) {
      const { data, error } = await supabase
        .from('seasons')
        .select('id, name, end_date, competitive_fee_cents, recreational_fee_cents')
        .eq('id', activeId)
        .maybeSingle();
      if (error) throw new Error(`Could not read the season: ${error.message}`);
      season = data;
    }

    const tournamentIds = [...new Set(feeRows.flatMap((f) => (f.fee_type === 'tournament' && f.tournament_id ? [f.tournament_id] : [])))];
    const eventIds = [...new Set(feeRows.flatMap((f) => (f.fee_type === 'event' && f.club_event_id ? [f.club_event_id] : [])))];
    const [tournamentsRes, eventsRes] = await Promise.all([
      tournamentIds.length > 0
        ? supabase.from('tournaments').select('id, name').in('id', tournamentIds)
        : Promise.resolve({ data: [] as { id: string; name: string }[], error: null }),
      // club_events (00248) is newer than the generated types, so this one read
      // goes through an untyped view of the same client.
      eventIds.length > 0
        ? (supabase as unknown as SupabaseClient)
            .from('club_events')
            .select('id, title')
            .in('id', eventIds)
            .then((r) => ({ data: r.data as { id: string; title: string }[] | null, error: r.error }))
        : Promise.resolve({ data: [] as { id: string; title: string }[], error: null }),
    ]);
    if (tournamentsRes.error) throw new Error(`Could not read tournament names: ${tournamentsRes.error.message}`);
    if (eventsRes.error) throw new Error(`Could not read event names: ${eventsRes.error.message}`);

    const { lines } = buildStatementLines({
      player: viewer,
      season,
      feeRows,
      tournamentNames: new Map((tournamentsRes.data ?? []).map((t) => [t.id, t.name])),
      eventNames: new Map((eventsRes.data ?? []).map((e) => [e.id, e.title])),
    });
    return { season, summary: summariseFees(lines, { exempt: isExempt(viewer) }) };
  }, [supabase, viewer]);
  const { state, refreshing, reload } = useLoad(load);

  if (state.status === 'loading') return <Loading />;
  if (state.status === 'error') return <ErrorState message={state.error} onRetry={reload} />;

  const { summary, season } = state.data;
  const headline = statementHeadline(summary);

  return (
    <ScrollView
      style={{ backgroundColor: p.background }}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} />}
    >
      <Card>
        <Label>Outstanding</Label>
        <View style={styles.headline}>
          <Text style={[styles.figure, { color: p.text }]}>{headline.amount}</Text>
          <Text style={[styles.badge, { color: summary.status === 'owing' ? p.danger : p.muted }]}>{headline.label}</Text>
        </View>
        {summary.unknownCount > 0 && (
          <Body muted>
            Plus {summary.unknownCount} {summary.unknownCount === 1 ? 'entry' : 'entries'} with no price recorded yet.
          </Body>
        )}
        {season ? <Body muted>{season.name}</Body> : null}
      </Card>

      {summary.outstanding.length > 0 && (
        <Card>
          <Label>To pay</Label>
          {summary.outstanding.map((line) => (
            <LineRow key={line.key} line={line} amount={money(line.owedCents)} />
          ))}
          <View style={styles.note}>
            <Body muted>Send a payment receipt from the Membership page on the club website.</Body>
          </View>
        </Card>
      )}

      <Card>
        <Label>Receipts</Label>
        {summary.receipts.length === 0 ? (
          <Body muted>No payments recorded yet.</Body>
        ) : (
          summary.receipts.map((line) => (
            <LineRow
              key={line.key}
              line={line}
              amount={line.waived ? 'Waived' : money(line.recordedCents)}
              detail={line.paidAt ? line.paidAt.slice(0, 10) : null}
            />
          ))
        )}
      </Card>
    </ScrollView>
  );
}

function LineRow({ line, amount, detail }: { line: FeeLine; amount: string; detail?: string | null }) {
  const p = usePalette();
  return (
    <View style={[styles.line, { borderColor: p.line }]}>
      <View style={styles.fill}>
        <Text style={{ color: p.text, fontSize: 15 }}>{line.name}</Text>
        {detail ? <Text style={{ color: p.muted, fontSize: 13 }}>{detail}</Text> : null}
      </View>
      <Text style={{ color: p.text, fontSize: 15, fontWeight: '600' }}>{amount}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  content: { padding: 16 },
  headline: { flexDirection: 'row', alignItems: 'baseline', gap: 12, marginBottom: 6 },
  figure: { fontSize: 36, fontWeight: '700' },
  badge: { fontSize: 13, fontWeight: '700', letterSpacing: 0.8 },
  line: { flexDirection: 'row', alignItems: 'center', paddingVertical: 10, borderTopWidth: 1, gap: 12 },
  note: { marginTop: 8 },
});
