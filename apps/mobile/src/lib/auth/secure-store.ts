import * as SecureStore from 'expo-secure-store';
import { createChunkedStorage } from './chunked-storage';

// Keystore-backed on Android, Keychain on iOS. Never AsyncStorage: a refresh
// token is a long-lived credential and AsyncStorage is plain files on disk.
export const secureSessionStorage = createChunkedStorage({
  getItemAsync: (key) => SecureStore.getItemAsync(key),
  setItemAsync: (key, value) => SecureStore.setItemAsync(key, value),
  deleteItemAsync: (key) => SecureStore.deleteItemAsync(key),
});
