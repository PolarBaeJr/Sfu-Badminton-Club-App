import type { ReactNode } from 'react';
import { ActivityIndicator, Pressable, StyleSheet, Text, View, type ViewStyle } from 'react-native';
import { usePalette } from './theme';

export function Card({ children, style }: { children: ReactNode; style?: ViewStyle }) {
  const p = usePalette();
  return (
    <View style={[styles.card, { backgroundColor: p.surface, borderColor: p.line }, style]}>{children}</View>
  );
}

export function Label({ children }: { children: ReactNode }) {
  const p = usePalette();
  return <Text style={[styles.label, { color: p.muted }]}>{children}</Text>;
}

export function Body({ children, muted }: { children: ReactNode; muted?: boolean }) {
  const p = usePalette();
  return <Text style={[styles.body, { color: muted ? p.muted : p.text }]}>{children}</Text>;
}

export function Loading() {
  const p = usePalette();
  return (
    <View style={styles.centre}>
      <ActivityIndicator color={p.accent} />
    </View>
  );
}

/**
 * A failed read, said as one. PostgREST refusals resolve rather than throw, and
 * on the web a refused read rendered as an empty list for months; here an error
 * is never drawn as "nothing yet".
 */
export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  const p = usePalette();
  return (
    <View style={styles.centre}>
      <Text style={[styles.body, { color: p.danger, textAlign: 'center' }]}>{message}</Text>
      {onRetry && <Button title="Try again" onPress={onRetry} variant="ghost" />}
    </View>
  );
}

export function EmptyState({ message }: { message: string }) {
  const p = usePalette();
  return (
    <View style={styles.centre}>
      <Text style={[styles.body, { color: p.muted, textAlign: 'center' }]}>{message}</Text>
    </View>
  );
}

export function Button({
  title,
  onPress,
  disabled,
  variant = 'primary',
}: {
  title: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'ghost';
}) {
  const p = usePalette();
  const primary = variant === 'primary';
  return (
    <Pressable
      accessibilityRole="button"
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.button,
        primary ? { backgroundColor: p.accent } : { borderColor: p.line, borderWidth: 1 },
        (pressed || disabled) && { opacity: 0.6 },
      ]}
    >
      <Text style={[styles.buttonText, { color: primary ? '#ffffff' : p.text }]}>{title}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { borderRadius: 16, borderWidth: 1, padding: 16, marginBottom: 12 },
  label: { fontSize: 12, fontWeight: '600', letterSpacing: 0.8, textTransform: 'uppercase', marginBottom: 6 },
  body: { fontSize: 15, lineHeight: 21 },
  centre: { flex: 1, alignItems: 'center', justifyContent: 'center', padding: 24, gap: 12 },
  button: { borderRadius: 8, paddingVertical: 12, paddingHorizontal: 16, alignItems: 'center', marginTop: 8 },
  buttonText: { fontSize: 15, fontWeight: '600' },
});
