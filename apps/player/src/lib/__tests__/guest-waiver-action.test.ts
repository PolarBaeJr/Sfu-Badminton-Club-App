import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { DEFAULT_FEATURE_FLAGS, ALL_FEATURES_ENABLED } from '@badminton/shared';

/**
 * signGuestWaiver is the one action a visitor with no account can call. These
 * pin what it sends to the database and what it refuses, at its seams: the
 * switch, the viewer, the request headers and the RPC.
 */

// Dispatches on the function name: a signing is sign_guest_waiver followed by
// set_guest_media_consent (00255).
const signRpc = vi.fn();
const consentRpc = vi.fn();
const rpc = vi.fn((fn: string, args: unknown) =>
  fn === 'set_guest_media_consent' ? consentRpc(fn, args) : signRpc(fn, args),
);
const getViewer = vi.fn();
const getFeatureFlags = vi.fn();
let requestHeaders = new Headers();

vi.mock('../supabase-server', () => ({
  createServiceRoleClient: () => ({ rpc: (fn: string, args: unknown) => rpc(fn, args) }),
  getViewer: () => getViewer(),
  getCurrentPlayer: vi.fn(),
}));
vi.mock('../feature-gate', () => ({ getFeatureFlags: () => getFeatureFlags() }));
vi.mock('next/headers', () => ({ headers: async () => requestHeaders }));
vi.mock('@sentry/nextjs', () => ({ captureException: vi.fn(), setUser: vi.fn() }));
vi.mock('posthog-node', () => ({ PostHog: class {} }));
vi.mock('@badminton/shared/src/push/send', () => ({ sendPushToPlayers: vi.fn() }));
vi.mock('../reactivate', () => ({ reactivateLapsedMember: vi.fn() }));

const { signGuestWaiver, setGuestMediaConsent } = await import('../actions/guest-waiver');

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

const signed = { ...row, media_consent: false, media_consent_saved: true };

const admin = { role: 'admin', is_exec: false, status: 'active', is_banned: false, active_flag: true };

function rpcArgs(): Record<string, unknown> {
  expect(signRpc).toHaveBeenCalledTimes(1);
  expect(signRpc.mock.calls[0]![0]).toBe('sign_guest_waiver');
  return signRpc.mock.calls[0]![1] as Record<string, unknown>;
}

function consentArgs(): Record<string, unknown> {
  expect(consentRpc).toHaveBeenCalledTimes(1);
  return consentRpc.mock.calls[0]![1] as Record<string, unknown>;
}

beforeEach(() => {
  rpc.mockClear();
  signRpc.mockReset();
  signRpc.mockResolvedValue({ data: [row], error: null });
  consentRpc.mockReset();
  consentRpc.mockImplementation(async (_fn: string, args: { p_consent: boolean }) => ({
    data: [{ media_consent: args.p_consent, media_consent_changed_at: args.p_consent ? '2026-09-25T20:00:00Z' : null }],
    error: null,
  }));
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
    expect(signRpc).toHaveBeenCalledTimes(1);
  });

  it('treats a viewer read that throws as a guest', async () => {
    getViewer.mockRejectedValue(new Error('no session'));
    expect((await signGuestWaiver(input)).ok).toBe(true);
  });
});

describe('signGuestWaiver: what reaches the database', () => {
  it('sends the normalised name and email, a fresh token and no version', async () => {
    const res = await signGuestWaiver({ ...input, waiver_version: '1999-01-01' });
    expect(res).toEqual({ ok: true, data: signed });
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
    signRpc.mockClear();
    requestHeaders = new Headers({ 'x-forwarded-for': '203.0.113.7' });
    await signGuestWaiver(input);
    expect(rpcArgs().p_ip_hash).toBe(first);
  });

  it('prefers cf-connecting-ip over x-forwarded-for', async () => {
    requestHeaders = new Headers({ 'x-forwarded-for': '203.0.113.7' });
    await signGuestWaiver(input);
    const forwarded = rpcArgs().p_ip_hash;
    signRpc.mockClear();
    requestHeaders = new Headers({ 'cf-connecting-ip': '198.51.100.2', 'x-forwarded-for': '203.0.113.7' });
    await signGuestWaiver(input);
    const cf = rpcArgs().p_ip_hash;
    signRpc.mockClear();
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
    signRpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: 'raised', hint } });
    expect(await signGuestWaiver(input)).toEqual({ ok: false, error: message });
  });

  it('maps the IP throttle too', async () => {
    signRpc.mockResolvedValue({ data: null, error: { code: 'P0001', message: 'raised', hint: 'guest_waiver_ip_limit' } });
    const res = await signGuestWaiver(input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/^Too many signings from this network/);
  });

  it('gives an unknown database error a code and a ref', async () => {
    signRpc.mockResolvedValue({ data: null, error: { code: 'XX000', message: 'boom', hint: null } });
    const res = await signGuestWaiver(input);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toMatch(/^[A-Z]{2,4}-\d{3}$/);
      expect(res.ref).toBeTruthy();
    }
  });

  it('treats an empty result as a fault, not a success', async () => {
    signRpc.mockResolvedValue({ data: [], error: null });
    const res = await signGuestWaiver(input);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.ref).toBeTruthy();
  });
});

describe('signGuestWaiver: photo and video consent (00255)', () => {
  // Always called, not only when ticked: a repeat signing within ten minutes
  // returns the existing row, and an untick on the repeat must turn it off.
  it('sets consent off when the box is unticked', async () => {
    const res = await signGuestWaiver(input);
    expect(consentArgs()).toEqual({ p_token: row.token, p_consent: false });
    expect(res).toEqual({ ok: true, data: { ...row, media_consent: false, media_consent_saved: true } });
  });

  it('sets consent on when the box is ticked', async () => {
    const res = await signGuestWaiver({ ...input, media_consent: true });
    expect(consentArgs()).toEqual({ p_token: row.token, p_consent: true });
    expect(res).toEqual({ ok: true, data: { ...row, media_consent: true, media_consent_saved: true } });
  });

  it('never calls it when the signing fails', async () => {
    signRpc.mockResolvedValue({ data: null, error: { code: 'XX000', message: 'boom', hint: null } });
    await signGuestWaiver({ ...input, media_consent: true });
    expect(consentRpc).not.toHaveBeenCalled();
  });

  it('keeps the signing when the consent call fails, and says it was not saved', async () => {
    consentRpc.mockResolvedValue({ data: null, error: { code: 'XX000', message: 'boom', hint: null } });
    const res = await signGuestWaiver({ ...input, media_consent: true });
    expect(res).toEqual({ ok: true, data: { ...row, media_consent: false, media_consent_saved: false } });
  });
});

describe('setGuestMediaConsent', () => {
  const token = 'b'.repeat(48);

  it('sends the token and the choice', async () => {
    const res = await setGuestMediaConsent({ token, media_consent: true });
    expect(consentArgs()).toEqual({ p_token: token, p_consent: true });
    expect(res).toEqual({ ok: true, data: { consent: true, changedAt: '2026-09-25T20:00:00Z' } });
  });

  it('works while the switch is off', async () => {
    getFeatureFlags.mockResolvedValue({ ...DEFAULT_FEATURE_FLAGS });
    expect((await setGuestMediaConsent({ token, media_consent: false })).ok).toBe(true);
  });

  it('refuses a malformed token before any rpc', async () => {
    for (const bad of ['B'.repeat(48), 'b'.repeat(47), '', 'not-a-token']) {
      expect((await setGuestMediaConsent({ token: bad, media_consent: true })).ok).toBe(false);
    }
    expect(rpc).not.toHaveBeenCalled();
  });

  it('turns an unknown token into plain words, with no ref', async () => {
    consentRpc.mockResolvedValue({
      data: null,
      error: { code: 'P0001', message: 'Not a guest waiver link', hint: 'guest_media_consent_not_found' },
    });
    expect(await setGuestMediaConsent({ token, media_consent: false })).toEqual({
      ok: false,
      error: 'This proof link is not valid.',
    });
  });

  it('gives any other database error a code and a ref', async () => {
    consentRpc.mockResolvedValue({ data: null, error: { code: 'XX000', message: 'boom', hint: null } });
    const res = await setGuestMediaConsent({ token, media_consent: false });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.ref).toBeTruthy();
  });
});
