import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../api.js', () => ({ fetchBotConfig: vi.fn() }));
import { fetchBotConfig } from '../api.js';
import { invalidateConfigCache, loadConfig } from '../config.js';

const mockFetch = vi.mocked(fetchBotConfig);

const PAYLOAD = {
  guilds: [{ guildId: 'g1', roles: { linked: '111', internal: '222' } }],
  auditChannelId: 'chan1',
};

beforeEach(() => {
  invalidateConfigCache();
  mockFetch.mockReset();
  delete process.env.DISCORD_GUILDS;
  delete process.env.DISCORD_AUDIT_CHANNEL_ID;
});
afterEach(() => {
  delete process.env.DISCORD_GUILDS;
  delete process.env.DISCORD_AUDIT_CHANNEL_ID;
});

describe('loadConfig', () => {
  it('turns the payload into a registry', async () => {
    mockFetch.mockResolvedValue(PAYLOAD);
    const cfg = await loadConfig();
    expect(cfg.registry.get('g1')).toEqual({ linked: '111', internal: '222' });
    expect(cfg.auditChannelId).toBe('chan1');
  });

  it('serves the cache inside the TTL and refetches outside it', async () => {
    mockFetch.mockResolvedValue(PAYLOAD);
    let clock = 1_000_000;
    const now = () => clock;
    await loadConfig({}, () => {}, now);
    await loadConfig({}, () => {}, now);
    expect(mockFetch).toHaveBeenCalledTimes(1);
    clock += 61_000;
    await loadConfig({}, () => {}, now);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('force skips a warm cache', async () => {
    mockFetch.mockResolvedValue(PAYLOAD);
    await loadConfig();
    await loadConfig({ force: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  // THE IMPORTANT ONE. An empty registry is not inert: the sweep would walk
  // every linked member, change nothing, and report success.
  it('falls back to the last good copy rather than an empty registry', async () => {
    mockFetch.mockResolvedValueOnce(PAYLOAD);
    await loadConfig();
    mockFetch.mockRejectedValue(new Error('app down'));
    const log = vi.fn();
    const cfg = await loadConfig({ force: true }, log);
    expect(cfg.registry.get('g1')).toEqual({ linked: '111', internal: '222' });
    expect(log).toHaveBeenCalledWith(expect.stringContaining('last good copy'));
  });

  it('falls back to env when nothing has ever been fetched', async () => {
    mockFetch.mockRejectedValue(new Error('app down'));
    process.env.DISCORD_GUILDS = JSON.stringify({ g9: { linked: '999' } });
    process.env.DISCORD_AUDIT_CHANNEL_ID = 'envchan';
    const log = vi.fn();
    const cfg = await loadConfig({}, log);
    expect(cfg.registry.get('g9')).toEqual({ linked: '999' });
    expect(cfg.auditChannelId).toBe('envchan');
    expect(log).toHaveBeenCalledWith(expect.stringContaining('falling back to env'));
  });

  it('throws rather than returning an empty registry when it has nothing', async () => {
    mockFetch.mockRejectedValue(new Error('app down'));
    await expect(loadConfig({}, () => {})).rejects.toThrow(/no DISCORD_GUILDS fallback/);
  });

  // The app is a separate deployment and could be newer than this bot.
  it('rejects a role name the bot does not manage', async () => {
    mockFetch.mockResolvedValue({
      guilds: [{ guildId: 'g1', roles: { linked: '1', overlord: '2' } }],
      auditChannelId: null,
    });
    await expect(loadConfig({}, () => {})).rejects.toThrow(/unmanaged role "overlord"/);
  });

  // A guild registered with no roles would mean "manage this server, apply
  // nothing" — which strips every managed role from everybody in it.
  it('skips a guild with no roles instead of registering it empty', async () => {
    mockFetch.mockResolvedValue({
      guilds: [{ guildId: 'g1', roles: {} }, { guildId: 'g2', roles: { linked: '1' } }],
      auditChannelId: null,
    });
    const cfg = await loadConfig();
    expect(cfg.registry.has('g1')).toBe(false);
    expect(cfg.registry.has('g2')).toBe(true);
  });

  it('reports a missing audit channel as undefined, not the string "null"', async () => {
    mockFetch.mockResolvedValue({ guilds: [{ guildId: 'g1', roles: { linked: '1' } }], auditChannelId: null });
    expect((await loadConfig()).auditChannelId).toBeUndefined();
  });
});
