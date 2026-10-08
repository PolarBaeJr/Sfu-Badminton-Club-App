import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { COMMAND_DEFINITIONS } from '../commands.js';
import {
  diffCommandSets,
  putCommandSet,
  registerCommandsOnBoot,
  scopeLabel,
} from '../register-commands.js';

// The boot path writes to the club's LIVE command list, so the two things this
// suite exists to pin are the two that cannot be observed anywhere else:
//
//   1. THE FLAG. Unless REGISTER_COMMANDS_ON_BOOT is exactly 'true', nothing
//      leaves the process. Registration is global, so a bot that registered by
//      default would publish whichever stack restarted last.
//   2. THE COMPARISON. An unchanged set must be recognised as unchanged. A
//      comparison that answers "changed" every boot still registers, so it
//      LOOKS like it works while doing exactly what it was added to avoid -
//      which means the only test that proves anything is one where the
//      registered side is shaped the way Discord shapes it, not the way this
//      repo sends it.
//
// THE FIXTURE IS BUILT BY HAND, DOWNWARDS FROM COMMAND_DEFINITIONS, and
// deliberately does NOT go through the module's own normalizer: feeding the
// normalizer its own output back would pass even if it compared nothing. The
// transform below instead does what Discord does to a payload - adds the
// fields we never send, drops the defaults we send in full, reverses the list -
// so a normalizer that misses any one of those fails here.

type Json = Record<string, unknown>;

/** One option, as it comes back out of Discord rather than as we sent it. */
function asDiscordReturnsOption(raw: Json): Json {
  const wire: Json = {
    type: raw.type,
    name: raw.name,
    description: raw.description,
    // Discord reports these only when they are true; we write `required: false`
    // out in full on 24 options.
    ...(raw.required === true ? { required: true } : {}),
    ...(raw.autocomplete === true ? { autocomplete: true } : {}),
    ...(raw.min_value === undefined ? {} : { min_value: raw.min_value }),
    ...(raw.max_value === undefined ? {} : { max_value: raw.max_value }),
    ...(raw.channel_types === undefined ? {} : { channel_types: raw.channel_types }),
  };
  if (Array.isArray(raw.choices)) {
    // A localization map per choice, which is the per-option extra most likely
    // to break a naive deep compare.
    wire.choices = (raw.choices as Json[]).map((choice) => ({
      name: choice.name,
      value: choice.value,
      name_localizations: null,
    }));
  }
  // An empty list comes back as no key at all, at every depth.
  if (Array.isArray(raw.options) && raw.options.length > 0) {
    wire.options = (raw.options as Json[]).map(asDiscordReturnsOption);
  }
  return wire;
}

/** The whole set, as a GET of the registered commands answers. */
function asDiscordReturnsIt(defined: readonly unknown[]): Json[] {
  const wire = defined.map((raw, index) => {
    const command = raw as Json;
    const registered: Json = {
      id: `10000000000000000${index}`,
      application_id: '999999999999999999',
      version: `20000000000000000${index}`,
      type: 1, // CHAT_INPUT, which this repo never sends.
      default_permission: null,
      nsfw: false,
      name_localizations: null,
      description_localizations: null,
      integration_types: [0],
      contexts: null,
      name: command.name,
      description: command.description,
      // null where we omit the mask, and the documented default where we omit
      // dm_permission.
      default_member_permissions: command.default_member_permissions ?? null,
      dm_permission: command.dm_permission ?? true,
    };
    if (Array.isArray(command.options) && command.options.length > 0) {
      registered.options = (command.options as Json[]).map(asDiscordReturnsOption);
    }
    return registered;
  });
  // Nothing promises the order of this list, so the fixture hands it back in a
  // different one than the file defines.
  return wire.reverse();
}

function registeredSet(): Json[] {
  return asDiscordReturnsIt(COMMAND_DEFINITIONS);
}

function find(set: Json[], name: string): Json {
  const command = set.find((entry) => entry.name === name);
  if (!command) throw new Error(`fixture has no /${name}`);
  return command;
}

interface Call {
  url: string;
  method: string;
  body: string | undefined;
  headers: Record<string, string>;
}

/** A fetch that records what went out and answers from `handler`. */
function harness(handler: (call: Call) => Response) {
  const calls: Call[] = [];
  const fetchImpl = vi.fn((url: string, init?: RequestInit) => {
    const call: Call = {
      url,
      method: init?.method ?? 'GET',
      body: init?.body as string | undefined,
      headers: (init?.headers ?? {}) as Record<string, string>,
    };
    calls.push(call);
    return Promise.resolve(handler(call));
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

/** Answers the GET with `registered` and the PUT with `registered` back. */
function serving(registered: unknown, putWith: () => Response = () => json(200, [])) {
  return harness((call) =>
    call.method === 'PUT' ? putWith() : json(200, registered as unknown[])
  );
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

async function boot(fetchImpl: typeof fetch) {
  const logs: string[] = [];
  const errors: string[] = [];
  await registerCommandsOnBoot({
    fetchImpl,
    log: (line) => logs.push(line),
    logError: (line) => errors.push(line),
  });
  return { logs, errors };
}

beforeEach(() => {
  process.env.DISCORD_BOT_TOKEN = 'tok';
  process.env.DISCORD_APPLICATION_ID = 'app1';
  delete process.env.DISCORD_DEV_GUILD_ID;
  delete process.env.REGISTER_COMMANDS_ON_BOOT;
});

afterEach(() => {
  delete process.env.DISCORD_BOT_TOKEN;
  delete process.env.DISCORD_APPLICATION_ID;
  delete process.env.DISCORD_DEV_GUILD_ID;
  delete process.env.REGISTER_COMMANDS_ON_BOOT;
});

describe('the gate', () => {
  it('makes no request at all with the flag unset', async () => {
    const { calls, fetchImpl } = serving(registeredSet());
    const { logs, errors } = await boot(fetchImpl);
    expect(calls).toEqual([]);
    // Silent as well as inert: this is the state every dev machine and every
    // staging container is in, and a line per boot would train people to
    // ignore the ones that matter.
    expect(logs).toEqual([]);
    expect(errors).toEqual([]);
  });

  it('accepts only the exact string true', async () => {
    for (const value of ['', 'false', 'FALSE', 'TRUE', 'True', '1', 'yes', 'on']) {
      process.env.REGISTER_COMMANDS_ON_BOOT = value;
      const { calls, fetchImpl } = serving(registeredSet());
      await boot(fetchImpl);
      expect(calls, `"${value}" must not opt in`).toEqual([]);
    }
  });

  it('says so and stops when the flag is on but the credentials are not there', async () => {
    process.env.REGISTER_COMMANDS_ON_BOOT = 'true';
    delete process.env.DISCORD_BOT_TOKEN;
    const { calls, fetchImpl } = serving(registeredSet());
    const { errors } = await boot(fetchImpl);
    expect(calls).toEqual([]);
    expect(errors.join('\n')).toContain('DISCORD_BOT_TOKEN');
  });
});

describe('the comparison', () => {
  it('reads the registered set as Discord shapes it and writes nothing', async () => {
    // THE TEST THIS WHOLE FEATURE TURNS ON. The fixture carries id,
    // application_id, version, type, default_permission, nsfw, both
    // localization maps, integration_types and contexts, omits `options` where
    // we send [], omits `required` where we send false, and arrives reversed.
    // A single unnormalized field here means a PUT on every boot.
    process.env.REGISTER_COMMANDS_ON_BOOT = 'true';
    const { calls, fetchImpl } = serving(registeredSet());
    const { logs, errors } = await boot(fetchImpl);
    expect(calls.map((call) => call.method)).toEqual(['GET']);
    expect(calls[0]?.url).toBe('https://discord.com/api/v10/applications/app1/commands');
    expect(calls[0]?.headers.authorization).toBe('Bot tok');
    expect(logs.join('\n')).toContain('nothing to write');
    expect(errors).toEqual([]);
  });

  it('writes when a command is missing from the registered set', async () => {
    process.env.REGISTER_COMMANDS_ON_BOOT = 'true';
    const { calls, fetchImpl } = serving(
      registeredSet().filter((command) => command.name !== 'discord')
    );
    const { logs } = await boot(fetchImpl);
    expect(calls.map((call) => call.method)).toEqual(['GET', 'PUT']);
    expect(calls[1]?.body).toBe(JSON.stringify(COMMAND_DEFINITIONS));
    expect(logs.join('\n')).toContain('/discord is not registered');
  });

  it('writes when a description was edited', async () => {
    process.env.REGISTER_COMMANDS_ON_BOOT = 'true';
    const set = registeredSet();
    find(set, 'sessions').description = 'Upcoming club sessions (old wording)';
    const { calls, fetchImpl } = serving(set);
    const { logs } = await boot(fetchImpl);
    expect(calls.map((call) => call.method)).toEqual(['GET', 'PUT']);
    expect(logs.join('\n')).toContain('/sessions differs: description');
  });

  it('writes when an option gained autocomplete', async () => {
    // The case register.ts's header calls out by name: `autocomplete: true` is
    // part of the STORED definition, so shipping the handler alone leaves
    // /profile's handle picker inert. A comparison that missed this flag would
    // make the picker permanently dead with every gate green.
    process.env.REGISTER_COMMANDS_ON_BOOT = 'true';
    const set = registeredSet();
    const options = find(set, 'profile').options as Json[];
    delete (options[1] as Json).autocomplete;
    const { calls, fetchImpl } = serving(set);
    const { logs } = await boot(fetchImpl);
    expect(calls.map((call) => call.method)).toEqual(['GET', 'PUT']);
    expect(logs.join('\n')).toContain('/profile differs: options[1] (handle)');
  });

  it('writes when a command is registered that nothing defines any more', async () => {
    process.env.REGISTER_COMMANDS_ON_BOOT = 'true';
    const set = registeredSet();
    set.push({ ...find(set, 'sessions'), name: 'retired', id: '7' });
    const { calls, fetchImpl } = serving(set);
    const { logs } = await boot(fetchImpl);
    expect(calls.map((call) => call.method)).toEqual(['GET', 'PUT']);
    expect(logs.join('\n')).toContain('/retired is registered but no longer defined here');
  });

  it('treats a dm_permission the response does not report as a difference', async () => {
    // The direction the comparison errs, asserted so nobody "fixes" it into a
    // silent match: the field is deprecated in favour of `contexts`, and a
    // registered command with no dm_permission in it could have been PUT with
    // false by an older image. An extra PUT is the cheap wrong answer.
    const set = registeredSet();
    delete find(set, 'sessions').dm_permission;
    expect(diffCommandSets(COMMAND_DEFINITIONS, set)).toEqual([
      '/sessions differs: dm_permission (the registered copy does not report it)',
    ]);
  });

  it('reports the option edit rather than dm_permission when both are unresolved', async () => {
    // The ordering inside firstDifference, pinned. If the response never
    // carries dm_permission then EVERY command is "different" on that field,
    // and checking it first would make it the only thing the log ever says -
    // which hides the one line anybody reading that log is looking for.
    const set = registeredSet();
    for (const command of set) delete command.dm_permission;
    const options = find(set, 'profile').options as Json[];
    delete (options[1] as Json).autocomplete;
    const reasons = diffCommandSets(COMMAND_DEFINITIONS, set);
    expect(reasons.find((reason) => reason.startsWith('/profile'))).toBe(
      '/profile differs: options[1] (handle)'
    );
  });

  it('compares options in the order they came back', async () => {
    // Order-insensitive matching is the version that can hide an edit, so a
    // reordered option list is reported rather than accepted.
    const set = registeredSet();
    const profile = find(set, 'profile');
    profile.options = (profile.options as Json[]).slice().reverse();
    expect(diffCommandSets(COMMAND_DEFINITIONS, set).join('\n')).toContain('/profile differs');
  });

  it('caps the reasons rather than printing one per command', async () => {
    const reasons = diffCommandSets(COMMAND_DEFINITIONS, []);
    expect(reasons).toHaveLength(6);
    expect(reasons[5]).toBe(`and ${COMMAND_DEFINITIONS.length - 5} more`);
  });
});

describe('failure', () => {
  it('registers anyway when the registered set cannot be read', async () => {
    // "Could not read it" is not "it matches": assuming unchanged here is the
    // false negative that leaves a command missing for good.
    process.env.REGISTER_COMMANDS_ON_BOOT = 'true';
    const { calls, fetchImpl } = harness((call) =>
      call.method === 'PUT' ? json(200, []) : new Response('unauthorized', { status: 401 })
    );
    const { errors } = await boot(fetchImpl);
    expect(calls.map((call) => call.method)).toEqual(['GET', 'PUT']);
    expect(errors.join('\n')).toContain('401');
  });

  it('registers anyway when the read throws', async () => {
    process.env.REGISTER_COMMANDS_ON_BOOT = 'true';
    const { calls, fetchImpl } = harness((call) => {
      if (call.method === 'PUT') return json(200, []);
      throw new Error('ECONNRESET');
    });
    const { errors } = await boot(fetchImpl);
    expect(calls.map((call) => call.method)).toEqual(['GET', 'PUT']);
    expect(errors.join('\n')).toContain('ECONNRESET');
  });

  it('registers anyway when the read is not a list', async () => {
    process.env.REGISTER_COMMANDS_ON_BOOT = 'true';
    const { calls, fetchImpl } = harness((call) =>
      call.method === 'PUT' ? json(200, []) : json(200, { message: '429: rate limited' })
    );
    await boot(fetchImpl);
    expect(calls.map((call) => call.method)).toEqual(['GET', 'PUT']);
  });

  it('does not reject when the write is refused, and logs the status and the body', async () => {
    process.env.REGISTER_COMMANDS_ON_BOOT = 'true';
    const { fetchImpl } = serving(
      registeredSet().filter((command) => command.name !== 'discord'),
      () => new Response('{"message":"You are being rate limited.","retry_after":41.9}', { status: 429 })
    );
    const { errors } = await boot(fetchImpl);
    expect(errors.join('\n')).toContain('429');
    expect(errors.join('\n')).toContain('retry_after');
  });

  it('does not reject when the write throws', async () => {
    // The whole reason this is fire-and-forget in index.ts: an unhandled
    // rejection out of here would take the process down, and interactions do
    // not depend on registration at all.
    process.env.REGISTER_COMMANDS_ON_BOOT = 'true';
    const { fetchImpl } = harness((call) => {
      if (call.method === 'PUT') throw new Error('socket hang up');
      return json(200, []);
    });
    const { errors } = await boot(fetchImpl);
    expect(errors.join('\n')).toContain('socket hang up');
    expect(errors.join('\n')).toContain('serving interactions anyway');
  });
});

describe('the shared request', () => {
  it('PUTs the definitions globally, which is what the CLI does', async () => {
    const { calls, fetchImpl } = harness(() => json(200, [{ name: 'leaderboard' }]));
    const result = await putCommandSet({ token: 'tok', applicationId: 'app1' }, fetchImpl);
    expect(calls[0]?.url).toBe('https://discord.com/api/v10/applications/app1/commands');
    expect(calls[0]?.method).toBe('PUT');
    expect(calls[0]?.body).toBe(JSON.stringify(COMMAND_DEFINITIONS));
    expect(result).toEqual({ ok: true, registered: [{ name: 'leaderboard' }] });
  });

  it('scopes to the dev guild when one is set, on both requests', async () => {
    process.env.REGISTER_COMMANDS_ON_BOOT = 'true';
    process.env.DISCORD_DEV_GUILD_ID = 'g9';
    const { calls, fetchImpl } = serving(
      registeredSet().filter((command) => command.name !== 'discord')
    );
    await boot(fetchImpl);
    for (const call of calls) {
      expect(call.url).toBe('https://discord.com/api/v10/applications/app1/guilds/g9/commands');
    }
  });

  it('hands back the status and the body of a refusal, which is the CLI exit path', async () => {
    const { fetchImpl } = harness(() => new Response('{"message":"401: Unauthorized"}', { status: 401 }));
    expect(await putCommandSet({ token: 'bad', applicationId: 'app1' }, fetchImpl)).toEqual({
      ok: false,
      status: 401,
      body: '{"message":"401: Unauthorized"}',
    });
  });

  it('keeps the two scope wordings the CLI has always printed', () => {
    expect(scopeLabel(undefined)).toBe('globally (up to 1h to appear)');
    expect(scopeLabel('g9')).toBe('to guild g9 (live now)');
  });
});
