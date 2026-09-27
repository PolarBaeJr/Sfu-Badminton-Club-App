// Session storage for supabase-js on top of the platform keystore.
//
// A Supabase session (access token, refresh token, user object) is several
// kilobytes of JSON, and expo-secure-store warns above 2048 bytes per value and
// can refuse larger ones on some Android devices. So the value is split into
// numbered chunks under one key, with a count beside them.
//
// Pure over the three SecureStore calls so it can be tested without a device;
// secure-store.ts binds the real module.

export interface KeyValueStore {
  getItemAsync(key: string): Promise<string | null>;
  setItemAsync(key: string, value: string): Promise<void>;
  deleteItemAsync(key: string): Promise<void>;
}

/** The shape supabase-js accepts as `auth.storage`. */
export interface SessionStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

/** UTF-16 code units per chunk, well under SecureStore's 2048 byte warning. */
export const CHUNK_SIZE = 1000;

/** SecureStore keys may only hold letters, digits, ".", "-" and "_". */
export function sanitiseKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, '_');
}

/**
 * Splits without ever separating a surrogate pair: a lone surrogate is not
 * valid UTF-8, and the native store would write a replacement character in
 * its place, corrupting the JSON on the way back.
 */
export function splitIntoChunks(value: string, size: number = CHUNK_SIZE): string[] {
  const chunks: string[] = [];
  let i = 0;
  while (i < value.length) {
    let end = Math.min(i + size, value.length);
    const last = value.charCodeAt(end - 1);
    if (end < value.length && end - i > 1 && last >= 0xd800 && last <= 0xdbff) end -= 1;
    chunks.push(value.slice(i, end));
    i = end;
  }
  return chunks;
}

const countKey = (base: string) => `${base}.count`;
const chunkKey = (base: string, i: number) => `${base}.${i}`;

async function readCount(store: KeyValueStore, base: string): Promise<number | null> {
  const raw = await store.getItemAsync(countKey(base));
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

export function createChunkedStorage(store: KeyValueStore, size: number = CHUNK_SIZE): SessionStorage {
  return {
    async getItem(key) {
      const base = sanitiseKey(key);
      const count = await readCount(store, base);
      if (count === null) return null;
      const parts: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const part = await store.getItemAsync(chunkKey(base, i));
        // A missing chunk means a half-written or half-deleted session. No
        // session is the honest answer: the member signs in again, where a
        // spliced value would be a parse error inside supabase-js.
        if (part === null) return null;
        parts.push(part);
      }
      return parts.join('');
    },

    async setItem(key, value) {
      const base = sanitiseKey(key);
      const previous = (await readCount(store, base)) ?? 0;
      const chunks = splitIntoChunks(value, size);
      // Chunks first, then the count that makes them readable, then whatever
      // the previous, longer value left behind. Deleting before writing would
      // leave nothing to read if the app died in between.
      for (let i = 0; i < chunks.length; i += 1) {
        await store.setItemAsync(chunkKey(base, i), chunks[i] as string);
      }
      await store.setItemAsync(countKey(base), String(chunks.length));
      for (let i = chunks.length; i < previous; i += 1) {
        await store.deleteItemAsync(chunkKey(base, i));
      }
    },

    async removeItem(key) {
      const base = sanitiseKey(key);
      const count = (await readCount(store, base)) ?? 0;
      // The count goes first, so an interrupted removal reads as no session
      // rather than as a session with holes in it.
      await store.deleteItemAsync(countKey(base));
      for (let i = 0; i < count; i += 1) {
        await store.deleteItemAsync(chunkKey(base, i));
      }
    },
  };
}
