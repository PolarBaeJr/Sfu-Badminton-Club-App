import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEFAULT_FEATURE_FLAGS, ALL_FEATURES_ENABLED } from '@badminton/shared';

/**
 * signGuestWaiver is the one action a visitor with no account can call. These
 * pin what it sends to the database and what it refuses, at its seams: the
 * switch, the viewer, the request headers and the RPC.
 */

const rpc = vi.fn();
const getViewer = vi.fn();
const getFeatureFlags = vi.fn();
let requestHeaders = new Headers();

vi.mock('../supabase-server', () => ({
  createServiceRoleClient: () => ({ rpc: (...args: unknown[]) => rpc(...args) }),
  getViewer: () => getViewer(),
  getCurrentPlayer: vi.fn(),
}));
vi.mock('../feature-gate', () => ({ getFeatureFlags: () => getFeatureFlags() }));
vi.mock('next/headers', () => ({ headers: async () => requestHeaders }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), setUser: vi.fn() }));
vi.mock('posthog-node', () => ({ PostHog: class {} }));
vi.mock('@badminton/shared/src/push/send', () => ({ sendPushToPlayers: vi.fn() }));
vi.mock('../reactivate', () => ({ reactivateLapsedMember: vi.fn() }));

const { signGuestWaiver } = await import('../actions/guest-waiver');

const input = {
  full_name: '  Alex Guest ',
  email: ' Alex@Example.com ',
  age_attestation: true,
  documents_accepted: true,
};

const row = {
  token: 'a'.repeat(48),
  full_name: 'Alex Guest',
  accepted_at: '2026-09-25T20:00:00Z',
  waiver_version: '2026-07-19',
  privacy_version: '2026-07-19',
  reused: false,
};

const admin = { role: 'admin', is_exec: false, status: 'active', is_banned: false, active_flag: true };

function rpcArgs(): Record<string, unknown> {
  expect(rpc).toHaveBeenCalledTimes(1);
  expect(rpc.mock.calls[0]![0]).toBe('sign_guest_waiver');
  return rpc.mock.calls[0]![1] as Record<string, unknown>;
}

beforeEach(() => {
  rpc.mockReset();
  rpc.mockResolvedValue({ data: [row], error: null });
  getViewer.mockReset();
  getViewer.mockResolvedValue({ user: null, player: null });
  getFeatureFlags.mockReset();
  getFeatureFlags.mockResolvedValue({ ...ALL_FEATURES_ENABLED });
  requestHeaders = new Headers({ 'user-agent': 'test-agent', 'x-forwarded-for': '203.0.113.7, 10.0.0.1' });
  vi.stubEnv('GUEST_WAIVER_IP_SALT', 'test-salt');
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('signGuestWaiver: the switch', () => {
  it('refuses while the switch is off, and never calls the database', async () => {
    getFeatureFlags.mockResolvedValue({ ...DEFAULT_FEATURE_FLAGS });
    const res = await signGuestWaiver(input);
    expect(res).toEqual({ ok: false, error: 'The club has switched guest waivers off for now.' });
    expect(rpc).not.toHaveBeenCalled();
  });

  it('lets a holder of the key through while it is off', async () => {
    getFeatureFlags.mockResolvedValue({ ...DEFAULT_FEATURE_FLAGS });
    getViewer.mockResolvedValue({ user: { id: 'u1' }, player: admin });
    const res = await signGuestWaiver(input);
    expect(res.ok).toBe(true);
    expect(rpc).toHaveBeenCalledTimes(1);
  });

  it('treats a viewer read that throws as a guest', async () => {
    getViewer.mockRejectedValue(new Error('no session'));
    expect((await signGuestWaiver(input)).ok).toBe(true);
  });
});

describe('signGuestWaiver: what reaches the database', () => {
  it('sends the normalised name and email, a fresh token and no version', async () => {
    const res = await signGuestWaiver({ ...input, waiver_version: '1999-01-01' });
    expect(res).toEqual({ ok: true, data: row });
    const args = rpcArgs();
    expect(args.p_full_name).toBe('Alex Guest');
    expect(args.p_email).toBe('alex@example.com');
    expect(args.p_age_attestation).toBe(true);
    expect(args.p_user_agent).toBe('test-agent');
    expect(args.p_token).toMatch(/^[0-9a-f]{48}$/);
    expect(Object.keys(args).sort()).toEqual([
      'p_age_attestation',
      'p_email',
      'p_full_name',
      'p_ip_hash',
      'p_token',
      'p_user_agent',
    ]);
  });

  it('refuses invalid input before the database', async () => {
    const res = await signGuestWaiver({ ...input, age_attestation: false });
    expect(res.ok).toBe(false);
    expect(rpc).not.toHaveBeenCalled();
  });

  it('sends a salted hash of the IP, never the IP', async () => {
    await signGuestWaiver(input);
    const hash = rpcArgs().p_ip_hash as string;
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hash).not.toContain('203.0.113.7');
  });

  it('uses the first x-forwarded-for entry', async () => {
    await signGuestWaiver(input);
    const first = rpcArgs().p_ip_hash;
    rpc.mockClear();
    requestHeaders = new Headers({ 'x-forwarded-for': '203.0.113.7' });
    await signGuestWaiver(input);
    expect(rpcArgs().p_ip_hash).toBe(first);
  });

  it('prefers cf-connecting-ip over x-forwarded-for', async () => {
    requestHeaders = new Headers({ 'x-forwarded-for': '203.0.113.7' });
    await signGuestWaiver(input);
    const forwarded = rpcArgs().p_ip_hash;
    rpc.mockClear();
    requestHeaders = new Headers({ 'cf-connecting-ip': '198.51.100.2', 'x-forwarded-for': '203.0.113.7' });
    await signGuestWaiver(input);
    const cf = rpcArgs().p_ip_hash;
    rpc.mockClear();
    requestHeaders = new Headers({ 'x-forwarded-for': '198.51.100.2' });
    await signGuestWaiver(input);
    expect(cf).not.toBe(forwarded);
    expect(cf).toBe(rpcArgs().p_ip_hash);
  });

  it('sends no hash at all without the salt', async () => {
    vi.stubEnv('GUEST_WAIVER_IP_SALT', '');
    await signGuestWaiver(input);
    expect(rpcArgs().p_ip_hash).toBeNull();
  });
});

describe('signGuestWaiver: refusals and faults', () => {
  it.each([
    ['guest_waiver_email_limit', 'Too many signings from this email today. Please speak to a club executive.'],
    ['guest_waiver_no_document', 'The waiver is not available right now. Please try again later.'],
  ])('turns %s into plain words, with no ref', async (hint, message) => {
    rpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: 'raised', hint } });
    expect(await signGuestWaiver(input)).toEqual({ ok: false, error: message });
  });

  it('maps the IP throttle too', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: 'raised', hint: 'guest_waiver_ip_limit' } });
    const res = await signGuestWaiver(input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/^Too many signings from this network/);
  });

  it('gives an unknown database error a code and a ref', async () => {
    rpc.mockResolvedValue({ data: null, error: { code: 'XX000', message: 'boom', hint: null } });
    const res = await signGuestWaiver(input);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toMatch(/^[A-Z]{2,4}-\d{3}$/);
      expect(res.ref).toBeTruthy();
    }
  });

  it('treats an empty result as a fault, not a success', async () => {
    rpc.mockResolvedValue({ data: [], error: null });
    const res = await signGuestWaiver(input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.ref).toBeTruthy();
  });
});
