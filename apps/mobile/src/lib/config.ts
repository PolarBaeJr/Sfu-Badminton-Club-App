// The two public values the app needs to reach Supabase, read once at start.
//
// A missing value renders a configuration screen instead of a client pointed at
// "undefined". Pure over an env object so the rule is testable; the call site at
// the bottom spells each variable out literally because Metro only inlines
// `process.env.EXPO_PUBLIC_*` when it is written exactly that way.

export type SupabaseConfig =
  | { ok: true; url: string; anonKey: string }
  | { ok: false; missing: string[] };

export function readSupabaseConfig(env: {
  EXPO_PUBLIC_SUPABASE_URL?: string | undefined;
  EXPO_PUBLIC_SUPABASE_ANON_KEY?: string | undefined;
}): SupabaseConfig {
  const url = env.EXPO_PUBLIC_SUPABASE_URL?.trim() ?? '';
  const anonKey = env.EXPO_PUBLIC_SUPABASE_ANON_KEY?.trim() ?? '';
  const missing: string[] = [];
  // https only: the session tokens travel on every request, and a phone on a
  // club's public Wi-Fi is exactly where plain http would be read.
  if (!/^https:\/\/[^\s/]+/i.test(url)) missing.push('EXPO_PUBLIC_SUPABASE_URL');
  if (!anonKey) missing.push('EXPO_PUBLIC_SUPABASE_ANON_KEY');
  if (missing.length > 0) return { ok: false, missing };
  return { ok: true, url: url.replace(/\/+$/, ''), anonKey };
}

export const supabaseConfig = readSupabaseConfig({
  EXPO_PUBLIC_SUPABASE_URL: process.env.EXPO_PUBLIC_SUPABASE_URL,
  EXPO_PUBLIC_SUPABASE_ANON_KEY: process.env.EXPO_PUBLIC_SUPABASE_ANON_KEY,
});
