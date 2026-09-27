import type { ExpoConfig } from 'expo/config';

// No secrets, no OTA updates, no Sentry, no analytics. The Supabase URL and
// anon key arrive as EXPO_PUBLIC_ variables (see .env.example), which are
// public by design, so nothing here needs a secret store.
const config: ExpoConfig = {
  name: 'SFU Badminton',
  slug: 'sfu-badminton',
  version: '0.1.0',
  orientation: 'portrait',
  userInterfaceStyle: 'automatic',
  android: {
    // PLACEHOLDER. The owner decides the real application id. It becomes
    // permanent the moment a build is uploaded to Google Play (Play never lets
    // it change), and the passkey assetlinks.json file will name it.
    package: 'com.example.badminton.placeholder',
  },
  plugins: ['expo-status-bar', 'expo-secure-store'],
};

export default config;
