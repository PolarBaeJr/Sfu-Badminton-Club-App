import { COMMAND_DEFINITIONS } from './commands.js';

// THE SLASH-COMMAND REGISTRATION ITSELF, shared by both callers: the manual
// CLI (register.ts, whose header carries the global-vs-guild and autocomplete
// reasoning at register.ts:3-26) and the bot's own startup (index.ts, in the
// server.listen callback).
//
// Both go through putCommandSet rather than each building its own request. A
// PUT replaces the WHOLE set, so two callers assembling two payloads is one
// stale copy away from one of them deleting commands the other just added.
//
// ---- WHY THIS RUNS ON BOOT AND NOT IN CI ----
//
// A deploy here is: CI publishes an image, the host pulls it, the container
// restarts. So "on boot" IS "on deploy", and boot is the cheaper of the two
// places to do it: DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID are already in
// the container's environment (docker-compose.yml:143-144,
// docker-compose.staging.yml:147-148), while CI holds no Discord secrets at
// all. A workflow step would mean putting the bot token into GitHub Actions to
// do what the process can already do by itself.
//
// ---- WHY IT IS OFF UNLESS THE OWNER TURNS IT ON ----
//
// REGISTER_COMMANDS_ON_BOOT has to be exactly 'true' or the boot path does
// nothing at all. Registration is GLOBAL (register.ts:3-8), and global means
// "for the application", not "for this container": two stacks pointed at ONE
// Discord application would take turns overwriting each other's command set,
// and a staging deploy landing ahead of prod would publish staging's commands
// to the club's real server. Nothing in this process can tell whether the
// application its token belongs to is shared, so the opt-in is the owner's to
// make: set it on the prod bot once, and every later prod deploy registers
// itself.
//
// The staging stack does describe its DISCORD_APPLICATION_ID as a different
// value from production's rather than a copy
// (docker-compose.staging.yml:131-136), and while that holds, the flag is safe
// to enable there too. It stays the owner's call: this code cannot verify it,
// and the cost of being wrong is the club's live command list.

const BASE = 'https://discord.com/api/v10';

export interface RegistrationTarget {
  token: string;
  applicationId: string;
  /** Set means the set goes to that one guild instead. See register.ts:16-24. */
  devGuildId?: string | undefined;
}

export type PutOutcome =
  | { ok: true; registered: { name: string }[] }
  | { ok: false; status: number; body: string };

export type FetchOutcome = { ok: true; commands: unknown[] } | { ok: false; reason: string };

/** The scope wording, in one place so the CLI's line and the boot line agree. */
export function scopeLabel(devGuildId: string | undefined): string {
  return devGuildId ? `to guild ${devGuildId} (live now)` : 'globally (up to 1h to appear)';
}

function commandsUrl({ applicationId, devGuildId }: RegistrationTarget): string {
  const scope = devGuildId ? `/guilds/${devGuildId}` : '';
  return `${BASE}/applications/${applicationId}${scope}/commands`;
}

/**
 * Replaces the registered set with COMMAND_DEFINITIONS, unconditionally.
 *
 * Lets a network failure THROW instead of folding it into the result: the CLI's
 * exit code is the only signal a human running it gets, and the boot path has
 * its own catch around everything.
 */
export async function putCommandSet(
  target: RegistrationTarget,
  fetchImpl: typeof fetch = fetch
): Promise<PutOutcome> {
  const response = await fetchImpl(commandsUrl(target), {
    method: 'PUT', // PUT replaces the full set, so removals take effect too.
    headers: {
      authorization: `Bot ${target.token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(COMMAND_DEFINITIONS),
  });

  if (!response.ok) {
    return { ok: false, status: response.status, body: await response.text() };
  }

  return { ok: true, registered: (await response.json()) as { name: string }[] };
}

/**
 * What Discord currently has registered.
 *
 * Never throws, and never reports an empty set for a failed read: the caller
 * turns "could not read" into "register anyway", and a read failure that looked
 * like "nothing is registered" would be indistinguishable from the real thing.
 */
export async function fetchRegisteredCommands(
  target: RegistrationTarget,
  fetchImpl: typeof fetch = fetch
): Promise<FetchOutcome> {
  try {
    const response = await fetchImpl(commandsUrl(target), {
      headers: { authorization: `Bot ${target.token}` },
    });
    if (!response.ok) {
      return { ok: false, reason: `HTTP ${response.status}: ${await response.text()}` };
    }
    const body = (await response.json()) as unknown;
    if (!Array.isArray(body)) return { ok: false, reason: 'the response was not a list' };
    return { ok: true, commands: body };
  } catch (error) {
    return { ok: false, reason: String(error) };
  }
}

// ---- THE COMPARISON, AND WHICH WAY IT IS DELIBERATELY WRONG ----
//
// The boot path reads the registered set and writes only when it differs,
// because a PUT of a changed global set costs up to an hour of propagation and
// almost no deploy touches commands.ts: the commits that change it are a small
// minority of the ones that ship.
//
// THE RESPONSE IS NOT THE PAYLOAD. A GET carries fields this repo never sends
// (id, application_id, version, guild_id, default_permission, nsfw, the
// localization maps, per-option extras) and fills in defaults for the ones it
// omits. Deep-comparing the raw bodies answers "different" on every single
// boot, which is WORSE than having no check at all: it pays for the PUT anyway
// while looking like it is saving one. So both sides are projected down to the
// keys this repo actually sends, recursively through options and choices, and
// then compared field by field.
//
// EVERY UNCERTAINTY IS RESOLVED TOWARDS "CHANGED", because the two mistakes are
// not the same size. A false "changed" is one extra PUT of an identical set. A
// false "unchanged" is a command that never appears in Discord, which is the
// exact bug this path exists to kill. Concretely:
//
//   - Options, choices and channel_types are compared IN ORDER. Discord returns
//     them in the order they were registered, but nothing promises that, and
//     order-insensitive matching is the version that can hide a real edit.
//   - dm_permission is compared only when the response actually carries it.
//     Discord marks the field deprecated in favour of `contexts`, and deriving
//     one from the other from memory would be precisely the unverified
//     semantic that produces a silent false "unchanged". A response without it
//     is reported as a difference instead, named in the log, so if that is what
//     Discord does now, the first boot says so out loud rather than never. Same
//     for a guild-scoped registration, where the field is meaningless and comes
//     back null: that pays an extra PUT per boot, and a guild registration is
//     instant and dev-only anyway.
//   - A GET that FAILS registers anyway. "Could not read it" is not "it
//     matches".
//
// The top level is keyed by NAME rather than compared positionally: command
// names are unique per application, all 17 definitions are CHAT_INPUT (none
// sets a command-level `type`, commands.ts:132-677), and Discord does not
// promise the order of the list. Keying by name cannot hide a difference - a
// command added, removed or renamed is still a difference - and it is what
// lets an unchanged set be recognised as one at all.

interface NormalizedOption {
  type: unknown;
  name: unknown;
  description: unknown;
  required: boolean;
  autocomplete: boolean;
  min_value: unknown;
  max_value: unknown;
  channel_types: unknown[];
  choices: { name: unknown; value: unknown }[];
  options: NormalizedOption[];
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * One option, reduced to the keys this repo sends, in a fixed key order so
 * JSON.stringify is a stable fingerprint.
 *
 * `required` and `autocomplete` default to false on BOTH sides: this repo
 * writes `required: false` out in full and Discord leaves the key out of the
 * response when it is false, so without the default every optional option in
 * the file reads as changed forever.
 */
function normalizeOption(raw: unknown): NormalizedOption {
  const option = asRecord(raw);
  return {
    type: option.type ?? null,
    name: option.name ?? null,
    description: option.description ?? null,
    required: option.required === true,
    autocomplete: option.autocomplete === true,
    min_value: option.min_value ?? null,
    max_value: option.max_value ?? null,
    // Absent and empty mean the same thing to Discord, so they normalize alike.
    // This file sends `options: []` on three commands and Discord omits the key
    // in the response.
    channel_types: asArray(option.channel_types),
    choices: asArray(option.choices).map((raw) => {
      const choice = asRecord(raw);
      return { name: choice.name ?? null, value: choice.value ?? null };
    }),
    options: asArray(option.options).map(normalizeOption),
  };
}

/** The first field of a defined command the registered copy does not match. */
function firstDifference(
  defined: Record<string, unknown>,
  registered: Record<string, unknown>
): string | null {
  if ((defined.description ?? null) !== (registered.description ?? null)) return 'description';

  // Both sides say "unrestricted" with an absent key or a null, so those fold
  // together. A real mask is a decimal STRING on both sides ('0', '32').
  if (
    (defined.default_member_permissions ?? null) !== (registered.default_member_permissions ?? null)
  ) {
    return 'default_member_permissions';
  }

  const definedOptions = asArray(defined.options).map(normalizeOption);
  const registeredOptions = asArray(registered.options).map(normalizeOption);
  if (definedOptions.length !== registeredOptions.length) {
    return `options (${definedOptions.length} defined, ${registeredOptions.length} registered)`;
  }
  for (const [index, option] of definedOptions.entries()) {
    if (JSON.stringify(option) !== JSON.stringify(registeredOptions[index])) {
      return `options[${index}] (${String(option.name)})`;
    }
  }

  // LAST, and the order is the point. Omitting dm_permission asks for Discord's
  // default, which is true, so an absent key on OUR side is a known value. An
  // absent key on Discord's side is not: the registered command could have been
  // PUT with `false` by an older image, so it counts as a difference per the
  // header above. If the response turns out never to carry the field, that
  // verdict is true of every command at once - and checking it before the
  // others would then make "dm_permission" the only thing this ever reports,
  // burying the option edit that is the actual reason to look.
  const definedDm = defined.dm_permission === undefined ? true : defined.dm_permission;
  const registeredDm = registered.dm_permission;
  if (registeredDm === undefined || registeredDm === null) {
    return 'dm_permission (the registered copy does not report it)';
  }
  if (definedDm !== registeredDm) return 'dm_permission';

  return null;
}

// Enough to diagnose, short enough to read in `docker logs`. A set that differs
// everywhere - which is what a missing dm_permission in the response would look
// like - would otherwise print a line per command on every single boot.
const MAX_REASONS = 5;

/**
 * Why the registered set is not the defined set, one line per command.
 *
 * Empty means they match and nothing has to be written. Exported for the tests,
 * which is the only place the normalization above is observable.
 */
export function diffCommandSets(
  defined: readonly unknown[],
  registered: readonly unknown[]
): string[] {
  const byName = new Map<string, Record<string, unknown>>();
  for (const command of registered) {
    const record = asRecord(command);
    if (typeof record.name === 'string') byName.set(record.name, record);
  }

  const reasons: string[] = [];
  const definedNames = new Set<string>();
  for (const command of defined) {
    const record = asRecord(command);
    const name = typeof record.name === 'string' ? record.name : '(unnamed)';
    definedNames.add(name);
    const current = byName.get(name);
    if (!current) {
      reasons.push(`/${name} is not registered`);
      continue;
    }
    const field = firstDifference(record, current);
    if (field) reasons.push(`/${name} differs: ${field}`);
  }
  for (const name of byName.keys()) {
    if (!definedNames.has(name)) reasons.push(`/${name} is registered but no longer defined here`);
  }

  return reasons.length > MAX_REASONS
    ? [...reasons.slice(0, MAX_REASONS), `and ${reasons.length - MAX_REASONS} more`]
    : reasons;
}

export interface BootRegistrationOptions {
  /** Injectable for tests; defaults to global fetch, as in discord-api.ts. */
  fetchImpl?: typeof fetch;
  log?: (line: string) => void;
  logError?: (line: string) => void;
}

/**
 * Registers the command set if this deploy is allowed to and the set changed.
 *
 * NEVER THROWS AND NEVER REJECTS. Interactions arrive over HTTP and do not
 * depend on this at all, so every outcome here - flag off, no credentials, a
 * 401, a rate limit, a hung socket - is a log line and nothing more. A bot that
 * refused to serve because it could not talk to Discord's command endpoint
 * would be a strictly worse bot than one serving last week's command list.
 */
export async function registerCommandsOnBoot(
  options: BootRegistrationOptions = {}
): Promise<void> {
  const { fetchImpl = fetch, log = console.log, logError = console.error } = options;
  try {
    // Exactly 'true'. Anything else, including unset, '1' and 'TRUE', leaves
    // the command set alone: see the header on why this fails closed.
    if (process.env.REGISTER_COMMANDS_ON_BOOT !== 'true') return;

    const token = process.env.DISCORD_BOT_TOKEN;
    const applicationId = process.env.DISCORD_APPLICATION_ID;
    if (!token || !applicationId) {
      logError(
        '[register] REGISTER_COMMANDS_ON_BOOT is set but DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID are not both present - not registering'
      );
      return;
    }

    const target: RegistrationTarget = {
      token,
      applicationId,
      devGuildId: process.env.DISCORD_DEV_GUILD_ID,
    };

    const current = await fetchRegisteredCommands(target, fetchImpl);
    if (current.ok) {
      const reasons = diffCommandSets(COMMAND_DEFINITIONS, current.commands);
      if (reasons.length === 0) {
        log(
          `[register] ${COMMAND_DEFINITIONS.length} commands already registered ${scopeLabel(target.devGuildId)}, nothing to write`
        );
        return;
      }
      log(`[register] registering, because: ${reasons.join('; ')}`);
    } else {
      logError(
        `[register] could not read the registered set (${current.reason}) - registering anyway rather than assuming it matches`
      );
    }

    const result = await putCommandSet(target, fetchImpl);
    if (!result.ok) {
      // Status AND body: a 401 means the token, a 403 the application, and a
      // 400 names the field Discord refused. Only the body says which.
      logError(`[register] registration failed: ${result.status}`);
      logError(`[register] ${result.body}`);
      return;
    }
    log(`[register] registered ${result.registered.length} ${scopeLabel(target.devGuildId)}`);
  } catch (error) {
    logError(`[register] registration failed, the bot is serving interactions anyway: ${String(error)}`);
  }
}
