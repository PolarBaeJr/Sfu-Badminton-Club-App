import { describe, it, expect, vi, beforeEach } from "vitest";

// What this file is really about: a club-wide session matches EVERY configured
// ping role, and two roles pointed at the same channel would post the same
// announcement twice. The (session_id, role_id) idempotency key cannot catch
// that — both rows are genuinely distinct — so grouping by channel here is the
// only thing standing between a club night and a double ping.

let selfRoles: {
  role_id: string;
  label: string;
  track: string;
  channel_id: string | null;
}[] = [];
let settings: { key: string; value: string }[] = [];
let sessions: {
  id: string;
  name: string | null;
  date: string;
  start_time: string | null;
  location: string | null;
  track: string;
}[] = [];
let alreadyPinged: { session_id: string; role_id: string }[] = [];
let readError: Record<string, { code: string; message: string } | null> = {};
const upserted = vi.fn();

function thenable(data: unknown, error: unknown = null) {
  const builder: Record<string, unknown> = {};
  for (const method of ["select", "eq", "not", "gte", "lte", "in", "order"]) {
    builder[method] = () => builder;
  }
  builder.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data, error }).then(resolve);
  return builder;
}

vi.mock("@/lib/supabase-server", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "discord_self_roles")
        return thenable(selfRoles, readError.roles ?? null);
      if (table === "discord_settings")
        return thenable(settings, readError.settings ?? null);
      if (table === "sessions")
        return thenable(sessions, readError.sessions ?? null);
      if (table === "discord_session_pings") {
        return {
          ...thenable(alreadyPinged, readError.pinged ?? null),
          upsert: (rows: unknown) => {
            upserted(rows);
            return Promise.resolve({ error: null });
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

vi.mock("@sentry/nextjs", () => ({ captureException: vi.fn() }));

// Per-test IP: the limiter is module-level and is not reset between tests.
let bucket = 0;
function req(
  path = "/api/discord/session-pings?guildId=g1",
  init: RequestInit = {},
) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      authorization: "Bearer test-secret",
      "x-forwarded-for": `10.9.0.${(bucket += 1)}`,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

interface Ping {
  sessionId: string;
  channelId: string;
  roleIds: string[];
  name: string | null;
}

async function due(): Promise<Ping[]> {
  const { GET } = await import("../route");
  const res = await GET(req());
  const body = (await res.json()) as { pings?: Ping[] };
  return body.pings ?? [];
}

// Inside the default 120-minute lead. Expressed as club wall clock, because
// that is what the route reads off the row.
const SOON = new Date(Date.now() + 90 * 60_000);
function session(at: Date, track = "all") {
  return {
    id: "s1",
    name: "Club night",
    date: at.toLocaleDateString("en-CA", { timeZone: "America/Vancouver" }),
    start_time: at.toLocaleTimeString("en-GB", {
      timeZone: "America/Vancouver",
      hour: "2-digit",
      minute: "2-digit",
    }),
    location: "West Gym",
    track,
  };
}

// Indexing is checked under strict mode, and a missing ping should read as a
// failed assertion rather than a TypeError three lines later.
function only(pings: Ping[]): Ping {
  expect(pings).toHaveLength(1);
  return pings[0] as Ping;
}

beforeEach(() => {
  process.env.DISCORD_SERVICE_SECRET = "test-secret";
  readError = {};
  alreadyPinged = [];
  upserted.mockReset();
  settings = [{ key: "session_ping_channel_id", value: "default-channel" }];
  sessions = [session(SOON)];
  selfRoles = [
    {
      role_id: "900",
      label: "Competitive",
      track: "competitive",
      channel_id: null,
    },
    {
      role_id: "901",
      label: "Recreational",
      track: "recreational",
      channel_id: null,
    },
  ];
});

describe("GET /api/discord/session-pings", () => {
  it("refuses without the service secret", async () => {
    const { GET } = await import("../route");
    const bad = new Request(
      "http://localhost/api/discord/session-pings?guildId=g1",
      {
        headers: { authorization: "Bearer wrong" },
      },
    );
    expect((await GET(bad)).status).toBe(401);
  });

  it("posts a club-wide night ONCE when both ping roles share a channel", async () => {
    // The bug: 'all' fans out to every role, and both roles fall back to the
    // default channel, so the naive shape is two identical messages.
    const ping = only(await due());

    expect(ping.channelId).toBe("default-channel");
    expect(ping.roleIds).toEqual(["900", "901"]);
  });

  it("still posts separately when the roles have separate channels", async () => {
    // Which is the whole point of per-role channels: a club that does not want
    // competitive nights announced server-wide points that role elsewhere.
    selfRoles = [
      {
        ...(selfRoles[0] as (typeof selfRoles)[0]),
        channel_id: "comp-channel",
      },
      selfRoles[1] as (typeof selfRoles)[0],
    ];
    const pings = await due();

    expect(pings).toHaveLength(2);
    expect(pings.map((p) => p.channelId).sort()).toEqual([
      "comp-channel",
      "default-channel",
    ]);
    expect(pings.find((p) => p.channelId === "comp-channel")?.roleIds).toEqual([
      "900",
    ]);
  });

  it("pings only the matching role for a single-track session", async () => {
    sessions = [session(SOON, "competitive")];

    expect(only(await due()).roleIds).toEqual(["900"]);
  });

  it("drops a role that has already been pinged, keeping the rest of the group", async () => {
    alreadyPinged = [{ session_id: "s1", role_id: "900" }];

    expect(only(await due()).roleIds).toEqual(["901"]);
  });

  it("offers nothing once every role in the group has been pinged", async () => {
    alreadyPinged = [
      { session_id: "s1", role_id: "900" },
      { session_id: "s1", role_id: "901" },
    ];
    expect(await due()).toEqual([]);
  });

  it("skips a session further out than the lead time", async () => {
    sessions = [session(new Date(Date.now() + 10 * 60 * 60_000))];
    expect(await due()).toEqual([]);
  });

  it("drops a ping that is hours late rather than firing it stale", async () => {
    // Arriving after the session started, telling people to come to something
    // they have already missed, is worse than not pinging at all.
    sessions = [session(new Date(Date.now() - 3 * 60 * 60_000))];
    expect(await due()).toEqual([]);
  });

  it("skips a role with no channel anywhere instead of failing the run", async () => {
    settings = [];
    selfRoles = [
      {
        ...(selfRoles[0] as (typeof selfRoles)[0]),
        channel_id: "comp-channel",
      },
      selfRoles[1] as (typeof selfRoles)[0],
    ];

    expect(only(await due()).channelId).toBe("comp-channel");
  });

  it("FAILS CLOSED on a ping-history read error", async () => {
    // Treating this as "nothing pinged yet" would re-ping every session in the
    // window on every tick until the read recovered.
    readError.pinged = { code: "42P01", message: "relation does not exist" };
    const { GET } = await import("../route");
    expect((await GET(req())).status).toBe(503);
  });

  it("names a config read failure rather than reporting nothing due", async () => {
    readError.roles = { code: "42P01", message: "relation does not exist" };
    const { GET } = await import("../route");
    expect((await GET(req())).status).toBe(503);
  });
});

describe("POST /api/discord/session-pings", () => {
  it("records every role from one message in a single statement", async () => {
    // Half-recording a multi-role post would re-ping the missing subset on the
    // next tick, in the same channel, for the same session.
    const { POST } = await import("../route");
    const res = await POST(
      req("/api/discord/session-pings", {
        method: "POST",
        body: JSON.stringify({ sessionId: "s1", roleIds: ["900", "901"] }),
      }),
    );

    expect(res.status).toBe(200);
    expect(upserted).toHaveBeenCalledWith([
      { session_id: "s1", role_id: "900" },
      { session_id: "s1", role_id: "901" },
    ]);
  });

  it("rejects a body with no roles rather than recording nothing quietly", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      req("/api/discord/session-pings", {
        method: "POST",
        body: JSON.stringify({ sessionId: "s1", roleIds: [] }),
      }),
    );

    expect(res.status).toBe(400);
    expect(upserted).not.toHaveBeenCalled();
  });
});
