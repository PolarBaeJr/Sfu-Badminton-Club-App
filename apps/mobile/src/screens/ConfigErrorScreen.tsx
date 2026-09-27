import { StyleSheet, Text, View } from 'react-native';
import { usePalette } from '../components/theme';

/** Shown instead of the app when the build has no Supabase URL or key. */
export function ConfigErrorScreen({ missing }: { missing: string[] }) {
  const p = usePalette();
  return (
    <View style={[styles.fill, { backgroundColor: p.background }]}>
      <Text style={[styles.title, { color: p.text }]}>This build is not configured</Text>
      <Text style={{ color: p.muted, fontSize: 15, lineHeight: 21 }}>
        Missing or invalid: {missing.join(', ')}. Copy .env.example to .env.local, fill in an https URL and the anon
        key, and restart the bundler.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, justifyContent: 'center', padding: 24 },
  title: { fontSize: 20, fontWeight: '700', marginBottom: 12 },
});
