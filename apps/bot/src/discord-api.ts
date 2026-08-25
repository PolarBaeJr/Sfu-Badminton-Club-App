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

  constructor(options: DiscordApiOptions) {
    this.token = options.token;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  private async request(method: string, path: string): Promise<Response> {
    let attempt = 0;
    for (;;) {
      const response = await this.fetchImpl(`${BASE}${path}`, {
        method,
        headers: {
          authorization: `Bot ${this.token}`,
          'content-type': 'application/json',
        },
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
