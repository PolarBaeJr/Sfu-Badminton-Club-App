import { describe, expect, it } from 'vitest';
import { createChunkedStorage, sanitiseKey, splitIntoChunks, type KeyValueStore } from '../lib/auth/chunked-storage';

function memoryStore(): KeyValueStore & { map: Map<string, string>; log: string[] } {
  const map = new Map<string, string>();
  const log: string[] = [];
  return {
    map,
    log,
    async getItemAsync(key) {
      return map.has(key) ? (map.get(key) as string) : null;
    },
    async setItemAsync(key, value) {
      log.push(`set ${key}`);
      map.set(key, value);
    },
    async deleteItemAsync(key) {
      log.push(`delete ${key}`);
      map.delete(key);
    },
  };
}

describe('chunked session storage', () => {
  it('round-trips a value longer than one chunk', async () => {
    const store = memoryStore();
    const storage = createChunkedStorage(store, 10);
    const value = 'x'.repeat(25);
    await storage.setItem('k', value);
    expect(await storage.getItem('k')).toBe(value);
    expect(store.map.get('k.count')).toBe('3');
  });

  it('keeps every chunk within the size', () => {
    const chunks = splitIntoChunks('a'.repeat(2500));
    expect(chunks).toHaveLength(3);
    expect(chunks.every((c) => c.length <= 1000)).toBe(true);
  });

  it('never splits a surrogate pair across two chunks', () => {
    const value = `abc${'\u{1D11E}'}def`; // outside the BMP: two UTF-16 units
    const chunks = splitIntoChunks(value, 4);
    expect(chunks.join('')).toBe(value);
    for (const c of chunks) {
      const last = c.charCodeAt(c.length - 1);
      expect(last >= 0xd800 && last <= 0xdbff).toBe(false);
    }
  });

  it('writes chunks, then the count, then deletes what a longer value left behind', async () => {
    const store = memoryStore();
    const storage = createChunkedStorage(store, 5);
    await storage.setItem('k', 'x'.repeat(15));
    store.log.length = 0;
    await storage.setItem('k', 'y'.repeat(6));
    expect(store.log).toEqual(['set k.0', 'set k.1', 'set k.count', 'delete k.2']);
    expect(await storage.getItem('k')).toBe('y'.repeat(6));
    expect(store.map.has('k.2')).toBe(false);
  });

  it('returns null rather than a spliced value when a chunk is missing', async () => {
    const store = memoryStore();
    const storage = createChunkedStorage(store, 5);
    await storage.setItem('k', 'x'.repeat(12));
    store.map.delete('k.1');
    expect(await storage.getItem('k')).toBeNull();
  });

  it('returns null for a key never written', async () => {
    expect(await createChunkedStorage(memoryStore()).getItem('nope')).toBeNull();
  });

  it('removes the count first, then every chunk', async () => {
    const store = memoryStore();
    const storage = createChunkedStorage(store, 5);
    await storage.setItem('k', 'x'.repeat(8));
    store.log.length = 0;
    await storage.removeItem('k');
    expect(store.log).toEqual(['delete k.count', 'delete k.0', 'delete k.1']);
    expect(store.map.size).toBe(0);
    expect(await storage.getItem('k')).toBeNull();
  });

  it('sanitises keys to what SecureStore accepts', async () => {
    expect(sanitiseKey('sb-abc-auth-token')).toBe('sb-abc-auth-token');
    expect(sanitiseKey('a b/c:d@e')).toBe('a_b_c_d_e');
    const store = memoryStore();
    await createChunkedStorage(store).setItem('a b', 'v');
    expect([...store.map.keys()].every((k) => /^[A-Za-z0-9._-]+$/.test(k))).toBe(true);
  });
});
