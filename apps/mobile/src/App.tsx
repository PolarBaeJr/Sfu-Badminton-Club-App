import { StatusBar } from 'expo-status-bar';
import { SafeAreaProvider } from 'react-native-safe-area-context';
import { AuthProvider } from './lib/auth/auth-context';
import { supabaseConfig } from './lib/config';
import { createMobileClient } from './lib/supabase/client';
import { RootNavigator } from './navigation/RootNavigator';
import { ConfigErrorScreen } from './screens/ConfigErrorScreen';

export default function App() {
  return (
    <SafeAreaProvider>
      <StatusBar style="auto" />
      {supabaseConfig.ok ? (
        <Configured />
      ) : (
        <ConfigErrorScreen missing={supabaseConfig.missing} />
      )}
    </SafeAreaProvider>
  );
}

// Module level, so a remount (Fast Refresh included) never builds a second
// client with its own refresh timer on the same stored session.
const supabase = supabaseConfig.ok ? createMobileClient(supabaseConfig.url, supabaseConfig.anonKey) : null;

function Configured() {
  if (!supabase) return null;
  return (
    <AuthProvider supabase={supabase}>
      <RootNavigator />
    </AuthProvider>
  );
}
