import { beforeEach, describe, it, expect, vi } from 'vitest';

const state = vi.hoisted(() => ({
  authorized: true,
  rows: {} as Record<string, unknown>,
}));

vi.mock('@/lib/discord-service-auth', () => ({
  isAuthorizedDiscordService: () => state.authorized,
  discordServiceUnauthorized: () => new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
}));

vi.mock('@/lib/supabase-server', () => ({
  createServiceRoleClient: () => ({
    from: () => {
      let key = '';
      const api = {
        select: () => api,
        eq: (_column: string, value: string) => {
          key = value;
          return api;
        },
        maybeSingle: async () =>
          key in state.rows ? { data: { value: state.rows[key] }, error: null } : { data: null, error: null },
      };
      return api;
    },
  }),
}));

import { GET } from '../route';
import { DEFAULT_INSTAGRAM_URL } from '@badminton/shared';

const call = async () => {
  const res = await GET(new Request('http://app/api/discord/socials'));
  return { status: res.status, body: await res.json() };
};

beforeEach(() => {
  state.authorized = true;
  state.rows = {};
});

describe('GET /api/discord/socials', () => {
  it('refuses a caller without the service secret', async () => {
    state.authorized = false;
    expect((await call()).status).toBe(401);
  });

  it('answers the defaults while nothing is saved', async () => {
    expect((await call()).body).toEqual({ enabled: true, showDiscord: true, instagramUrl: DEFAULT_INSTAGRAM_URL });
  });

  it('honours show_discord and a blank Instagram link', async () => {
    state.rows.club_socials = { instagram_url: '', show_discord: false };
    expect((await call()).body).toEqual({ enabled: true, showDiscord: false, instagramUrl: null });
  });

  it('answers disabled, with no links, when the socials switch is off', async () => {
    state.rows.features = { socials_enabled: false };
    expect((await call()).body).toEqual({ enabled: false, showDiscord: false, instagramUrl: null });
  });

  it('never passes on a link the site would refuse to print', async () => {
    state.rows.club_socials = { instagram_url: 'javascript:alert(1)', show_discord: true };
    expect((await call()).body.instagramUrl).toBeNull();
  });
});
