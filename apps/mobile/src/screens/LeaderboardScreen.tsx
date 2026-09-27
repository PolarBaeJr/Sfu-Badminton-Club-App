import { useCallback, useMemo, useState } from 'react';
import { FlatList, Pressable, RefreshControl, StyleSheet, Text, View } from 'react-native';
import { EmptyState, ErrorState, Loading } from '../components/ui';
import { usePalette } from '../components/theme';
import { useLoad } from '../hooks/useLoad';
import { useAuth } from '../lib/auth/auth-context';
import { LEADERBOARD_TABS, rankLadder, type LadderRow, type LeaderboardTab } from '../lib/leaderboard';
import { useViewer } from '../lib/viewer-context';

export function LeaderboardScreen() {
  const { supabase } = useAuth();
  const viewer = useViewer();
  const p = usePalette();
  const [tab, setTab] = useState<LeaderboardTab>('open_singles');

  // get_leaderboard() is the database's own filtered ladder: it leaves out
  // hidden, pending and suspended members. Nothing else here reads another
  // member's rating.
  const load = useCallback(async (): Promise<LadderRow[]> => {
    const { data, error } = await supabase.rpc('get_leaderboard');
    if (error) throw new Error(`Could not read the ladder: ${error.message}`);
    return (data ?? []).map((r) => ({
      id: r.id,
      name: r.name,
      handle: r.handle,
      status: r.status,
      singles_elo: r.singles_elo,
      doubles_elo: r.doubles_elo,
    }));
  }, [supabase]);
  const { state, refreshing, reload } = useLoad(load);

  const ranked = useMemo(() => (state.status === 'ready' ? rankLadder(state.data, tab) : []), [state, tab]);

  return (
    <View style={[styles.fill, { backgroundColor: p.background }]}>
      <View style={[styles.tabs, { borderColor: p.line }]}>
        {LEADERBOARD_TABS.map((t) => (
          <Pressable
            key={t.id}
            accessibilityRole="tab"
            accessibilityState={{ selected: tab === t.id }}
            onPress={() => setTab(t.id)}
            style={[styles.tab, tab === t.id && { backgroundColor: p.accent }]}
          >
            <Text style={[styles.tabText, { color: tab === t.id ? '#ffffff' : p.text }]}>{t.label}</Text>
          </Pressable>
        ))}
      </View>
      {state.status === 'loading' ? (
        <Loading />
      ) : state.status === 'error' ? (
        <ErrorState message={state.error} onRetry={reload} />
      ) : (
        <FlatList
          data={ranked}
          keyExtractor={(item) => item.row.id}
          refreshControl={<RefreshControl refreshing={refreshing} onRefresh={reload} />}
          ListEmptyComponent={<EmptyState message="No ranked players yet." />}
          renderItem={({ item }) => {
            const me = item.row.id === viewer.id;
            return (
              <View
                style={[
                  styles.row,
                  { borderColor: p.line, backgroundColor: me ? p.highlight : p.surface },
                ]}
              >
                <Text style={[styles.rank, { color: p.muted }]}>{item.rank}</Text>
                <View style={styles.name}>
                  <Text style={[styles.nameText, { color: p.text }]} numberOfLines={1}>
                    {item.row.name}
                    {me ? '  (you)' : ''}
                  </Text>
                  {item.row.handle ? (
                    <Text style={[styles.handle, { color: p.muted }]} numberOfLines={1}>
                      @{item.row.handle}
                    </Text>
                  ) : null}
                </View>
                <Text style={[styles.elo, { color: p.text }]}>{Math.round(item.elo)}</Text>
              </View>
            );
          }}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  tabs: { flexDirection: 'row', padding: 8, gap: 6, borderBottomWidth: 1 },
  tab: { flex: 1, borderRadius: 8, paddingVertical: 8, alignItems: 'center' },
  tabText: { fontSize: 13, fontWeight: '600' },
  row: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 12, borderBottomWidth: 1 },
  rank: { width: 36, fontSize: 15, fontVariant: ['tabular-nums'] },
  name: { flex: 1 },
  nameText: { fontSize: 15, fontWeight: '500' },
  handle: { fontSize: 13 },
  elo: { fontSize: 15, fontWeight: '600', fontVariant: ['tabular-nums'] },
});
