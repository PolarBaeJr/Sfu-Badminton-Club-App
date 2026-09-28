import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { VIEWER_MAX_AGE_MS, readViewer, signViewer } from '../verified-viewer';

const ID = '11111111-2222-4333-8444-555555555555';
const OTHER = '9a1b2c3d-0000-4000-8000-000000000000';
const T = 1_790_000_000_000;

describe('verified viewer header', () => {
  beforeEach(() => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'test-signing-secret');
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('round-trips the id it was minted for', async () => {
    const v = await signViewer(ID, T);
    expect(await readViewer(v, T + 50)).toBe(ID);
  });

  it('refuses a value with the id swapped for another member', async () => {
    const v = (await signViewer(ID, T))!;
    const forged = v.replace(ID, OTHER);
    expect(await readViewer(forged, T)).toBeNull();
  });

  it('refuses a value signed with a different secret', async () => {
    const v = await signViewer(ID, T);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'another-secret');
    expect(await readViewer(v, T)).toBeNull();
  });

  it('refuses a value older than the window, and one from the future', async () => {
    const v = await signViewer(ID, T);
    expect(await readViewer(v, T + VIEWER_MAX_AGE_MS)).toBe(ID);
    expect(await readViewer(v, T + VIEWER_MAX_AGE_MS + 1)).toBeNull();
    expect(await readViewer(v, T - 60_000)).toBeNull();
  });

  it('refuses a caller-invented value: a bare id, junk, or nothing', async () => {
    expect(await readViewer(ID, T)).toBeNull();
    expect(await readViewer(`${ID}.${T}.not-a-signature`, T)).toBeNull();
    expect(await readViewer(`${ID}.${T}.%%%`, T)).toBeNull();
    expect(await readViewer('', T)).toBeNull();
    expect(await readViewer(null, T)).toBeNull();
  });

  it('mints nothing and trusts nothing when no secret is configured', async () => {
    const v = await signViewer(ID, T);
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    expect(await signViewer(ID, T)).toBeNull();
    expect(await readViewer(v, T)).toBeNull();
  });
});
