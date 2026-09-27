import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { socialsReply } from '../socials.js';
import { COMMAND_DEFINITIONS, DEFERRED_COMMANDS, dispatch } from '../commands.js';

// /socials prints the club's links as the app says they stand. The formatter is
// pure and carries the decisions; one dispatch-level test pins the fallback,
// because the whole point of catching the fetch in the handler is that an
// unreachable app still gets the member the invite.

const INVITE = 'https://discord.sfubadminton.com';
const PAGE = 'https://sfubadminton.com/socials';
const IG = 'https://www.instagram.com/sfu_badmintonclub/';

type Reply = {
  type: number;
  data: {
    flags?: number;
    content?: string;
    allowed_mentions?: { parse: string[] };
    embeds?: { description?: string; footer?: { text?: string } }[];
  };
};

const description = (reply: Reply) => reply.data.embeds?.[0]?.description ?? '';

describe('socialsReply', () => {
  it('lists Discord, Instagram and the website page, only to the caller, pinging nobody', () => {
    const reply = socialsReply({
      payload: { enabled: true, showDiscord: true, instagramUrl: IG },
      inviteUrl: INVITE,
      pageUrl: PAGE,
    }) as Reply;
    expect(reply.type).toBe(4);
    expect(reply.data.flags).toBe(64);
    expect(reply.data.allowed_mentions).toEqual({ parse: [] });
    expect(description(reply)).toContain(INVITE);
    expect(description(reply)).toContain(IG);
    expect(description(reply)).toContain(PAGE);
  });

  it('leaves Discord out when show_discord is off, and Instagram out when unset', () => {
    const reply = socialsReply({
      payload: { enabled: true, showDiscord: false, instagramUrl: null },
      inviteUrl: INVITE,
      pageUrl: PAGE,
    }) as Reply;
    expect(description(reply)).not.toContain(INVITE);
    expect(description(reply)).not.toContain('Instagram');
    expect(description(reply)).toContain(PAGE);
  });

  it('says the links are off, and prints none, when the socials switch is off', () => {
    const reply = socialsReply({
      payload: { enabled: false, showDiscord: true, instagramUrl: IG },
      inviteUrl: INVITE,
      pageUrl: PAGE,
    }) as Reply;
    expect(reply.data.content).toMatch(/switched off/);
    expect(JSON.stringify(reply)).not.toContain(INVITE);
    expect(JSON.stringify(reply)).not.toContain(IG);
    expect(reply.data.flags).toBe(64);
  });

  it('says there is nothing when every link is hidden and there is no website base', () => {
    const reply = socialsReply({
      payload: { enabled: true, showDiscord: false, instagramUrl: null },
      inviteUrl: INVITE,
      pageUrl: null,
    }) as Reply;
    expect(reply.data.content).toMatch(/no social links/);
  });

  it('falls back to the invite and the website page when the app is unreachable, and says so', () => {
    const reply = socialsReply({ payload: null, inviteUrl: INVITE, pageUrl: PAGE }) as Reply;
    expect(description(reply)).toContain(INVITE);
    expect(description(reply)).toContain(PAGE);
    expect(reply.data.embeds?.[0]?.footer?.text).toMatch(/Couldn't reach the club app/);
  });

  it('never prints a discord.gg code', () => {
    const reply = socialsReply({ payload: null, inviteUrl: INVITE, pageUrl: PAGE });
    expect(JSON.stringify(reply)).not.toContain('discord.gg');
  });
});

describe('/socials', () => {
  beforeEach(() => {
    process.env.APP_PUBLIC_URL = 'https://sfubadminton.com';
  });

  afterEach(() => {
    delete process.env.APP_PUBLIC_URL;
    delete process.env.APP_API_URL;
    delete process.env.DISCORD_SERVICE_SECRET;
    vi.unstubAllGlobals();
  });

  it('is registered for everybody and answered without deferring', () => {
    const def = COMMAND_DEFINITIONS.find((c) => c.name === 'socials') as Record<string, unknown> | undefined;
    expect(def).toBeDefined();
    expect(def).not.toHaveProperty('default_member_permissions');
    expect(DEFERRED_COMMANDS.has('socials')).toBe(false);
  });

  it('prints what the app answers', async () => {
    process.env.APP_API_URL = 'http://app.internal';
    process.env.DISCORD_SERVICE_SECRET = 's3cret';
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ enabled: true, showDiscord: true, instagramUrl: IG }), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const reply = (await dispatch('socials', [], { discordUserId: '42', guildId: 'g1' })) as unknown as Reply;
    expect(String((fetchMock.mock.calls[0] as unknown[])[0])).toBe('http://app.internal/api/discord/socials');
    expect(description(reply)).toContain(IG);
    expect(description(reply)).toContain(PAGE);
  });

  it('still gives the invite and the website page when the app answers badly', async () => {
    process.env.APP_API_URL = 'http://app.internal';
    process.env.DISCORD_SERVICE_SECRET = 's3cret';
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad gateway', { status: 502 })));
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const reply = (await dispatch('socials', [], { discordUserId: '42', guildId: 'g1' })) as unknown as Reply;
    expect(description(reply)).toContain(INVITE);
    expect(description(reply)).toContain(PAGE);
    expect(reply.data.content).toBeUndefined();
  });
});
