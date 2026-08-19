// rateLimitShared is the cross-replica limiter added when prod went to two
// player containers (see 00158). The two properties that matter here are the
// ones a single-process test suite would otherwise let through:
//
//   1. the limit is INCLUSIVE of the request being counted, because the SQL
//      returns the post-increment hit count;
//   2. it fails OPEN, degrading to the in-process limiter rather than
//      rejecting, so a database hiccup cannot lock members out of login.
//
// What is NOT provable here: that the SQL is race-free across replicas. That
// property lives entirely in the single INSERT ... ON CONFLICT statement in
// the migration -- a read-then-write version would pass every test below.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

type Answer = { data: unknown; error: { message: string } | null };
let answer: Answer = { data: [{ hits: 1, resets_at: new Date().toISOString() }], error: null };
const rpc = vi.fn(async () => answer);

vi.mock('@supabase/supabase-js', () => ({
  createClient: () => ({ rpc }),
}));

async function load() {
  // Fresh module each time: the service-role client is memoised in module scope.
  vi.resetModules();
  return import('../utils/rate-limit-shared');
}

const future = () => new Date(Date.now() + 60_000).toISOString();

describe('rateLimitShared', () => {
  beforeEach(() => {
    rpc.mockClear();
    answer = { data: [{ hits: 1, resets_at: future() }], error: null };
    vi.stubEnv('NEXT_PUBLIC_SUPABASE_URL', 'https://supabase.test');
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', 'service-role-test-key');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('allows a request under the limit and reports what is left', async () => {
    const { rateLimitShared } = await load();
    answer = { data: [{ hits: 3, resets_at: future() }], error: null };

    const r = await rateLimitShared('k:allow', 10, 60_000);

    expect(r.success).toBe(true);
    expect(r.remaining).toBe(7);
  });

  it('treats the limit as inclusive: the Nth request still succeeds', async () => {
    const { rateLimitShared } = await load();
    answer = { data: [{ hits: 10, resets_at: future() }], error: null };

    const r = await rateLimitShared('k:boundary', 10, 60_000);

    // hits counts the request just made, so hit #10 against a limit of 10 is
    // the last allowed one. An exclusive comparison here would silently cost
    // every route one request of its budget.
    expect(r.success).toBe(true);
    expect(r.remaining).toBe(0);
  });

  it('rejects once the count passes the limit', async () => {
    const { rateLimitShared } = await load();
    answer = { data: [{ hits: 11, resets_at: future() }], error: null };

    const r = await rateLimitShared('k:reject', 10, 60_000);

    expect(r.success).toBe(false);
    expect(r.remaining).toBe(0);
  });

  it('sends the key and window to the atomic SQL function', async () => {
    const { rateLimitShared } = await load();

    await rateLimitShared('auth-cb:1.2.3.4', 10, 60_000);

    expect(rpc).toHaveBeenCalledWith('consume_rate_limit', {
      p_key: 'auth-cb:1.2.3.4',
      p_window_ms: 60_000,
    });
  });

  it('accepts a bare object as well as a single-row array', async () => {
    const { rateLimitShared } = await load();
    answer = { data: { hits: 2, resets_at: future() }, error: null };

    const r = await rateLimitShared('k:bare', 10, 60_000);

    expect(r.success).toBe(true);
    expect(r.remaining).toBe(8);
  });

  it('fails OPEN on a database error and reports it', async () => {
    const { rateLimitShared } = await load();
    answer = { data: null, error: { message: 'relation does not exist' } };
    const onError = vi.fn();

    const r = await rateLimitShared('k:dberror', 10, 60_000);
    const r2 = await rateLimitShared('k:dberror2', 10, 60_000, onError);

    // Falls back to the in-process limiter, which allows a first request.
    expect(r.success).toBe(true);
    expect(r2.success).toBe(true);
    expect(onError).toHaveBeenCalledOnce();
  });

  it('still limits while failing open, rather than letting everything through', async () => {
    const { rateLimitShared } = await load();
    answer = { data: null, error: { message: 'down' } };

    const first = await rateLimitShared('k:degraded', 1, 60_000);
    const second = await rateLimitShared('k:degraded', 1, 60_000);

    // Fail-open means per-replica limiting, not no limiting.
    expect(first.success).toBe(true);
    expect(second.success).toBe(false);
  });

  it('rejects an unparseable row rather than trusting it', async () => {
    const { rateLimitShared } = await load();
    answer = { data: [{ hits: 'not-a-number', resets_at: 'nonsense' }], error: null };
    const onError = vi.fn();

    const r = await rateLimitShared('k:garbage', 10, 60_000, onError);

    expect(onError).toHaveBeenCalledOnce();
    expect(r.success).toBe(true); // fell back to in-process
  });

  it('does not call the database at all when service-role env is missing', async () => {
    vi.stubEnv('SUPABASE_SERVICE_ROLE_KEY', '');
    const { rateLimitShared } = await load();

    const r = await rateLimitShared('k:noenv', 10, 60_000);

    expect(rpc).not.toHaveBeenCalled();
    expect(r.success).toBe(true);
  });
});
