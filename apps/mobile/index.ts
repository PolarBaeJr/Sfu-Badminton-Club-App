// URL and URLSearchParams in React Native are incomplete, and supabase-js
// builds every request with them. Must run before anything imports the client.
import 'react-native-url-polyfill/auto';
import { registerRootComponent } from 'expo';
import App from './src/App';

registerRootComponent(App);
