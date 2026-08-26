// The thin slice of Discord's REST API this bot actually uses.
//
// Role changes go one at a time (PUT/DELETE .../roles/{id}) rather than as one
// PATCH carrying the member's whole role array. The single PATCH is fewer
// requests, and it is the wrong trade here for two reasons:
//
//  - It is all-or-nothing. A bot cannot modify a member whose top role outranks
//    its own, so every exec and admin returns 403 — and with a PATCH that 403
//    would take their @Internal and @Competitive Team down with it. Per-role
//    calls let the parts that CAN sync sync.
//  - It requires sending back every role the member holds, including ones this
//    bot does not manage. Any role added by hand between the read and the write
//    is silently erased.

export type RoleCallResult = 'ok' | 'forbidden' | 'not_found' | 'failed';

export interface DiscordApiOptions {
  token: string;
  /** Injectable for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  /** Injectable for tests so a 429 does not actually sleep. */
  sleep?: (ms: number) => Promise<void>;
}

import type { DiscordRole } from './setup.js';

const BASE = 'https://discord.com/api/v10';

// Discord answers a rate limit with retry_after in SECONDS (a float). Two
// retries is the ceiling on purpose: the reconciliation sweep is not
// latency-sensitive and would rather leave a member for the next pass than
// stall behind one bucket.
const MAX_RATE_LIMIT_RETRIES = 2;

export class DiscordApi {
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Resolved once per process; a bot's own id never changes. */
  private ownUserId: string | null = null;

  constructor(options: DiscordApiOptions) {
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    let attempt = 0;
    for (;;) {
      const response = await this.fetchImpl(`${BASE}${path}`, {
        method,
        headers: {
          authorization: `Bot ${this.token}`,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });

      if (response.status !== 429 || attempt >= MAX_RATE_LIMIT_RETRIES) return response;

      // A malformed or missing retry_after must not become NaN and sleep
      // forever; fall back to a second.
      let waitMs = 1000;
      try {
        const body = (await response.clone().json()) as { retry_after?: unknown };
        if (typeof body.retry_after === 'number' && Number.isFinite(body.retry_after)) {
          waitMs = Math.min(Math.max(body.retry_after, 0) * 1000, 10_000);
        }
      } catch {
        // Keep the fallback.
      }
      attempt += 1;
      await this.sleep(waitMs);
    }
  }

  /**
   * The member's current roles, or null if they are not in this guild.
   *
   * Not-in-guild is the ordinary case, not an error: the link is global and a
   * member may only be in one of the club's servers.
   */
  async getMemberRoles(guildId: string, userId: string): Promise<string[] | null> {
    const response = await this.request('GET', `/guilds/${guildId}/members/${userId}`);
    if (response.status === 404) return null;
    if (!response.ok) throw new Error(`GET member -> ${response.status}`);
    const body = (await response.json()) as { roles?: unknown };
    return Array.isArray(body.roles) ? (body.roles as string[]) : [];
  }

  /**
   * Every role in the guild, including @everyone and Discord-managed ones.
   *
   * Filtering happens in setup.ts rather than here: what counts as usable
   * depends on the bot's own position, which this method has no business
   * knowing about.
   */
  async listGuildRoles(guildId: string): Promise<DiscordRole[]> {
    const response = await this.request('GET', `/guilds/${guildId}/roles`);
    if (!response.ok) throw new Error(`GET roles -> ${response.status}`);
    return (await response.json()) as DiscordRole[];
  }

  /**
   * The bot's own user id, resolved from the token and then cached.
   */
  private async getOwnUserId(): Promise<string> {
    if (this.ownUserId) return this.ownUserId;
    const response = await this.request('GET', '/users/@me');
    if (!response.ok) throw new Error(`GET /users/@me -> ${response.status}`);
    const { id } = (await response.json()) as { id?: string };
    if (!id) throw new Error('GET /users/@me returned no id');
    this.ownUserId = id;
    return id;
  }

  /**
   * The bot's own highest role position in a guild.
   *
   * Needed because Discord refuses to let a bot create or assign a role at or
   * above its own, and a wired-up role above the bot fails on every single
   * sweep while looking perfectly configured.
   *
   * The user id has to be spelled out here. `@me` is only a valid stand-in on
   * `/users/@me`; on `/guilds/{id}/members/{user_id}` Discord parses the final
   * segment as a number and answers 400 NUMBER_TYPE_COERCE. That 400 used to
   * surface to the user as "I need Manage Roles", which sent people to fix a
   * permission that was never the problem.
   */
  async getOwnRolePosition(guildId: string): Promise<number> {
    const userId = await this.getOwnUserId();
    const member = await this.request('GET', `/guilds/${guildId}/members/${userId}`);
    if (!member.ok) throw new Error(`GET member -> ${member.status}`);
    const { roles } = (await member.json()) as { roles?: string[] };
    const all = await this.listGuildRoles(guildId);
    const mine = new Set(roles ?? []);
    // A bot with no roles beyond @everyone has position 0 and can assign
    // nothing, which the caller reports rather than treating as "unlimited".
    return all
      .filter((r) => mine.has(r.id))
      .reduce((highest, r) => Math.max(highest, r.position), 0);
  }

  /**
   * Create a role, with NO permissions.
   *
   * `permissions: '0'` is not a tidy default, it is the whole safety property.
   * Discord copies @everyone's permissions onto a new role when the field is
   * omitted, so on a server where @everyone can, say, manage messages, running
   * /setup would silently mint nine roles carrying that power. Sending "0"
   * explicitly makes a created role purely a label until a human grants it
   * something.
   */
  async createGuildRole(guildId: string, name: string): Promise<DiscordRole> {
    const response = await this.request('POST', `/guilds/${guildId}/roles`, {
      name,
      permissions: '0',
      mentionable: false,
      hoist: false,
    });
    if (!response.ok) throw new Error(`POST role "${name}" -> ${response.status}`);
    return (await response.json()) as DiscordRole;
  }

  /**
   * Post a message to a channel. Used only by the audit log.
   *
   * Returns a boolean instead of throwing, and the reason is the same one that
   * governs roleCall: the audit log is a RECORD of work, never a gate on it. A
   * missing channel, a revoked permission or a 429 must not turn a completed
   * unlink into a failed one, so the caller gets a value it is free to ignore.
   */
  async createMessage(channelId: string, payload: unknown): Promise<boolean> {
    try {
      const response = await this.request('POST', `/channels/${channelId}/messages`, payload);
      return response.ok;
    } catch {
      return false;
    }
  }

  addRole(guildId: string, userId: string, roleId: string): Promise<RoleCallResult> {
    return this.roleCall('PUT', guildId, userId, roleId);
  }

  removeRole(guildId: string, userId: string, roleId: string): Promise<RoleCallResult> {
    return this.roleCall('DELETE', guildId, userId, roleId);
  }

  private async roleCall(
    method: 'PUT' | 'DELETE',
    guildId: string,
    userId: string,
    roleId: string
  ): Promise<RoleCallResult> {
    let response: Response;
    try {
      response = await this.request(method, `/guilds/${guildId}/members/${userId}/roles/${roleId}`);
    } catch {
      return 'failed';
    }
    if (response.ok || response.status === 204) return 'ok';
    // THE IMPORTANT ONE. 403 is the expected answer for every exec and admin,
    // because a bot cannot touch a member who outranks it. Returning a value
    // rather than throwing is what stops one predictable 403 aborting a sweep
    // and leaving everybody else's drift unrepaired.
    if (response.status === 403) return 'forbidden';
    if (response.status === 404) return 'not_found';
    return 'failed';
  }
}

/**
 * Replace the deferred "thinking..." message with the real one.
 *
 * A standalone function, not a DiscordApi method, because it authenticates with
 * the INTERACTION token rather than the bot token — the webhook route carries
 * its own credential. Passing a bot token here would be rejected.
 *
 * Never throws: it runs after the work is already done and committed, and an
 * unhandled rejection in a fire-and-forget path takes the process down with it.
 * A lost message is bad; a bot that exits because it could not describe what it
 * just did is worse.
 */
export async function editDeferredReply(
  applicationId: string,
  interactionToken: string,
  payload: unknown,
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  try {
    const response = await fetchImpl(
      `${BASE}/webhooks/${applicationId}/${interactionToken}/messages/@original`,
      {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      }
    );
    return response.ok;
  } catch {
    return false;
  }
}
