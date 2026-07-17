import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import webpush from 'web-push';
import type { SupabaseClient } from '@supabase/supabase-js';
import { sendPushToPlayer, sendPushToPlayers } from '../push/send';

vi.mock('web-push', () => ({
  default: {
    setVapidDetails: vi.fn(),
    sendNotification: vi.fn().mockResolvedValue(undefined),
  },
}));

const SUB_A = { id: 'sub-a', endpoint: 'https://push.example/a', p256dh_key: 'p256-a', auth_key: 'auth-a' };
const SUB_B = { id: 'sub-b', endpoint: 'https://push.example/b', p256dh_key: 'p256-b', auth_key: 'auth-b' };

function makeSupabaseMock(subscriptions: Array<typeof SUB_A>, error: { message: string } | null = null) {
  const eqAfterUpdate = vi.fn().mockResolvedValue({ data: null, error: null });
  const update = vi.fn().mockReturnValue({ eq: eqAfterUpdate });
  const eqAfterIn = vi.fn().mockResolvedValue({ data: subscriptions, error });
  const inFn = vi.fn().mockReturnValue({ eq: eqAfterIn });
  const select = vi.fn().mockReturnValue({ in: inFn });
  const from = vi.fn().mockReturnValue({ select, update });
  return { client: { from } as unknown as SupabaseClient, from, select, inFn, eqAfterIn, update, eqAfterUpdate };
}

describe('sendPushToPlayers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(webpush.sendNotification).mockReset().mockResolvedValue(undefined as never);
    vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'test-public-key');
    vi.stubEnv('VAPID_PRIVATE_KEY', 'test-private-key');
    vi.stubEnv('VAPID_EMAIL', 'push@example.com');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('no-ops when VAPID env is missing', async () => {
    vi.stubEnv('VAPID_PRIVATE_KEY', '');
    const mock = makeSupabaseMock([SUB_A]);

    await sendPushToPlayers(mock.client, ['player-1'], { title: 'T', body: 'B' });

    expect(mock.from).not.toHaveBeenCalled();
    expect(webpush.setVapidDetails).not.toHaveBeenCalled();
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it('no-ops when playerIds is empty', async () => {
    const mock = makeSupabaseMock([SUB_A]);

    await sendPushToPlayers(mock.client, [], { title: 'T', body: 'B' });

    expect(mock.from).not.toHaveBeenCalled();
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it('sets VAPID details from env with a mailto: subject', async () => {
    const mock = makeSupabaseMock([SUB_A]);

    await sendPushToPlayers(mock.client, ['player-1'], { title: 'T', body: 'B' });

    expect(webpush.setVapidDetails).toHaveBeenCalledWith(
      'mailto:push@example.com',
      'test-public-key',
      'test-private-key'
    );
  });

  it('queries active subscriptions for the given players', async () => {
    const mock = makeSupabaseMock([SUB_A]);

    await sendPushToPlayers(mock.client, ['player-1', 'player-2'], { title: 'T', body: 'B' });

    expect(mock.from).toHaveBeenCalledWith('push_subscriptions');
    expect(mock.select).toHaveBeenCalledWith('id, endpoint, p256dh_key, auth_key');
    expect(mock.inFn).toHaveBeenCalledWith('player_id', ['player-1', 'player-2']);
    expect(mock.eqAfterIn).toHaveBeenCalledWith('active', true);
  });

  it('sends each subscription the payload shape sw.js expects (title/body/url JSON)', async () => {
    const mock = makeSupabaseMock([SUB_A, SUB_B]);
    const payload = { title: 'New Challenge', body: 'You got challenged!', url: '/challenges/c1' };

    await sendPushToPlayers(mock.client, ['player-1'], payload);

    expect(webpush.sendNotification).toHaveBeenCalledTimes(2);
    expect(webpush.sendNotification).toHaveBeenCalledWith(
      { endpoint: SUB_A.endpoint, keys: { p256dh: SUB_A.p256dh_key, auth: SUB_A.auth_key } },
      JSON.stringify(payload)
    );
    expect(webpush.sendNotification).toHaveBeenCalledWith(
      { endpoint: SUB_B.endpoint, keys: { p256dh: SUB_B.p256dh_key, auth: SUB_B.auth_key } },
      JSON.stringify(payload)
    );
    // sw.js parses event.data.json() and reads title/body/url — verify the wire format
    const wire = JSON.parse(vi.mocked(webpush.sendNotification).mock.calls[0]?.[1] as string);
    expect(wire).toEqual({ title: 'New Challenge', body: 'You got challenged!', url: '/challenges/c1' });
  });

  it('marks a subscription inactive on 410 Gone', async () => {
    const mock = makeSupabaseMock([SUB_A, SUB_B]);
    vi.mocked(webpush.sendNotification).mockImplementation(async (sub) => {
      if ((sub as { endpoint: string }).endpoint === SUB_A.endpoint) {
        throw Object.assign(new Error('Gone'), { statusCode: 410 });
      }
      return undefined as never;
    });

    await sendPushToPlayers(mock.client, ['player-1'], { title: 'T', body: 'B' });

    expect(mock.update).toHaveBeenCalledWith({ active: false });
    expect(mock.eqAfterUpdate).toHaveBeenCalledWith('id', SUB_A.id);
    expect(mock.eqAfterUpdate).toHaveBeenCalledTimes(1);
  });

  it('marks a subscription inactive on 404', async () => {
    const mock = makeSupabaseMock([SUB_A]);
    vi.mocked(webpush.sendNotification).mockRejectedValue(
      Object.assign(new Error('Not Found'), { statusCode: 404 })
    );

    await sendPushToPlayers(mock.client, ['player-1'], { title: 'T', body: 'B' });

    expect(mock.update).toHaveBeenCalledWith({ active: false });
    expect(mock.eqAfterUpdate).toHaveBeenCalledWith('id', SUB_A.id);
  });

  it('rethrows non-expiry send errors', async () => {
    const mock = makeSupabaseMock([SUB_A]);
    vi.mocked(webpush.sendNotification).mockRejectedValue(
      Object.assign(new Error('Payload too large'), { statusCode: 413 })
    );

    await expect(
      sendPushToPlayers(mock.client, ['player-1'], { title: 'T', body: 'B' })
    ).rejects.toThrow('Payload too large');
    expect(mock.update).not.toHaveBeenCalled();
  });

  it('throws when the subscription query fails', async () => {
    const mock = makeSupabaseMock([], { message: 'boom' });

    await expect(
      sendPushToPlayers(mock.client, ['player-1'], { title: 'T', body: 'B' })
    ).rejects.toThrow('Failed to load push subscriptions: boom');
    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });

  it('does nothing when the player has no active subscriptions', async () => {
    const mock = makeSupabaseMock([]);

    await sendPushToPlayers(mock.client, ['player-1'], { title: 'T', body: 'B' });

    expect(webpush.sendNotification).not.toHaveBeenCalled();
  });
});

describe('sendPushToPlayer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(webpush.sendNotification).mockReset().mockResolvedValue(undefined as never);
    vi.stubEnv('NEXT_PUBLIC_VAPID_PUBLIC_KEY', 'test-public-key');
    vi.stubEnv('VAPID_PRIVATE_KEY', 'test-private-key');
    vi.stubEnv('VAPID_EMAIL', 'push@example.com');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('delegates to sendPushToPlayers with a single-element array', async () => {
    const mock = makeSupabaseMock([SUB_A]);

    await sendPushToPlayer(mock.client, 'player-9', { title: 'T', body: 'B' });

    expect(mock.inFn).toHaveBeenCalledWith('player_id', ['player-9']);
    expect(webpush.sendNotification).toHaveBeenCalledTimes(1);
  });
});
