import { useCallback } from 'react';
import { FlatList, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { EmptyState, ErrorState, Loading } from '../components/ui';
import { usePalette } from '../components/theme';
import { useLoad } from '../hooks/useLoad';
import { useAuth } from '../lib/auth/auth-context';
import { loadUpcomingSessions } from '../lib/sessions';
import { useViewer } from '../lib/viewer-context';

export function SessionsScreen() {
  const { supabase } = useAuth();
  const viewer = useViewer();
  const p = usePalette();
  const load = useCallback(() => loadUpcomingSessions(supabase, viewer.status), [supabase, viewer.status]);
  const { state, refreshing, reload } = useLoad(load);

  if (state.status === 'loading') return <Loading />;
  if (state.status === 'error') return <ErrorState message={state.error} onRetry={reload} />;

  return (
    <FlatList
      style={{ backgroundColor: p.background }}
      data={state.data}
      keyExtractor={(s) => s.id}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} />}
      ListEmptyComponent={<EmptyState message="No sessions are scheduled yet." />}
      renderItem={({ item }) => (
        <View style={[styles.row, { borderColor: p.line, backgroundColor: p.surface }]}>
          <Text style={[styles.date, { color: p.text }]}>{formatSessionDate(item.date)}</Text>
          <Text style={{ color: p.text, fontSize: 15 }}>{item.name ?? 'Club session'}</Text>
          <Text style={{ color: p.muted, fontSize: 13 }}>
            {[timeRange(item.start_time, item.end_time), item.location].filter(Boolean).join(' · ')}
          </Text>
        </View>
      )}
    />
  );
}

/**
 * "Sat 4 Oct" from a Postgres DATE, formatted in UTC: the column has no time,
 * and reading '2026-10-04' in the phone's own zone can show the 3rd.
 */
function formatSessionDate(date: string): string {
  const d = new Date(`${date.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return date;
  return d.toLocaleDateString('en-CA', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function timeRange(start: string | null, end: string | null): string {
  const s = start?.slice(0, 5);
  const e = end?.slice(0, 5);
  if (s && e) return `${s} to ${e}`;
  return s ?? '';
}

const styles = StyleSheet.create({
  row: { paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1, gap: 2 },
  date: { fontSize: 13, fontWeight: '700', textTransform: 'uppercase' },
});
