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

// The second source of ping roles. discord_self_roles is empty on production
// because the club hands its ping role out through Discord's Onboarding screen,
// which writes nothing to this database, so the pings had never fired. These
// keys are set in SQL instead of binding the role into the picker.
const COMP_ROLE = "111111111111111111";
const REC_ROLE = "222222222222222222";
const ALL_ROLE = "333333333333333333";
const ONE_ROLE = "444444444444444444";
const CHANNEL = { key: "session_ping_channel_id", value: "default-channel" };

describe("GET /api/discord/session-pings, ping roles from discord_settings", () => {
  it("pings the roles named by the settings keys when no self-role is bound", async () => {
    // The production shape: nothing in discord_self_roles at all.
    selfRoles = [];
    settings = [
      CHANNEL,
      { key: "session_ping_competitive_role_id", value: COMP_ROLE },
      { key: "session_ping_recreational_role_id", value: REC_ROLE },
      { key: "session_ping_all_role_id", value: ALL_ROLE },
    ];

    const ping = only(await due());

    expect(ping.roleIds).toEqual([COMP_ROLE, REC_ROLE, ALL_ROLE]);
    // There is no per-key channel, so everything lands in the default one.
    expect(ping.channelId).toBe("default-channel");
  });

  it("lets the settings keys win outright when both sources are populated", async () => {
    // Not merged. A club that wrote the keys has said where its ping roles come
    // from, and folding in leftover picker rows would ping a role nobody asked
    // for with no way to switch it off.
    settings = [
      CHANNEL,
      { key: "session_ping_competitive_role_id", value: COMP_ROLE },
      { key: "session_ping_recreational_role_id", value: REC_ROLE },
      { key: "session_ping_all_role_id", value: ALL_ROLE },
    ];

    const ping = only(await due());

    expect(ping.roleIds).toEqual([COMP_ROLE, REC_ROLE, ALL_ROLE]);
    expect(ping.roleIds).not.toContain("900");
    expect(ping.roleIds).not.toContain("901");
  });

  it("falls back to discord_self_roles when no ping-role key is set", async () => {
    // Asserted by name rather than by count, because the fallback has to be
    // chosen on the ABSENCE of the role keys, not on the settings being empty.
    expect(settings.map((s) => s.key)).toEqual(["session_ping_channel_id"]);

    expect(only(await due()).roleIds).toEqual(["900", "901"]);
  });

  it("names BOTH paths when neither is configured", async () => {
    // Both can be empty at once, which is how the feature actually shipped, and
    // the log line is the only trace: the cron records a clean success having
    // pinged nobody, indistinguishable from a quiet week.
    selfRoles = [];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(await due()).toEqual([]);

    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("session_ping_*_role_id");
    expect(logged).toContain("discord_self_roles");
    warn.mockRestore();
  });

  it("pings a role sitting under all three keys ONCE on a club-wide night", async () => {
    // THE DEDUP. A club with a single ping role sets all three keys to the same
    // id, an 'all' session matches every one of them, and the id would reach
    // roleIds three times: three identical mentions in one message, and three
    // identical (session_id, role_id) rows in ONE upsert, which Postgres
    // rejects with 21000. The ping posts, fails to record, and repeats every
    // five minutes until the lateness window closes.
    selfRoles = [];
    settings = [
      CHANNEL,
      { key: "session_ping_competitive_role_id", value: ONE_ROLE },
      { key: "session_ping_recreational_role_id", value: ONE_ROLE },
      { key: "session_ping_all_role_id", value: ONE_ROLE },
    ];

    expect(only(await due()).roleIds).toEqual([ONE_ROLE]);
  });

  it("pings a role sitting under both its track key and the 'all' key ONCE", async () => {
    // session_ping_all_role_id is the club-wide-night role, NOT a wildcard, so
    // a competitive session matches the competitive key only. The single entry
    // has to survive whichever way the filter and the dedup interact.
    selfRoles = [];
    sessions = [session(SOON, "competitive")];
    settings = [
      CHANNEL,
      { key: "session_ping_competitive_role_id", value: ONE_ROLE },
      { key: "session_ping_all_role_id", value: ONE_ROLE },
    ];

    expect(only(await due()).roleIds).toEqual([ONE_ROLE]);
  });

  it("skips a key holding something that is not a role id and pings the rest", async () => {
    // These keys are absent from the settings route's WRITABLE map, so they are
    // set by hand in SQL and nothing validated them on the way in. One typo
    // must not take the other two down with it.
    selfRoles = [];
    settings = [
      CHANNEL,
      { key: "session_ping_competitive_role_id", value: "@session ping" },
      { key: "session_ping_recreational_role_id", value: REC_ROLE },
      { key: "session_ping_all_role_id", value: ALL_ROLE },
    ];
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    expect(only(await due()).roleIds).toEqual([REC_ROLE, ALL_ROLE]);

    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("session_ping_competitive_role_id");
    expect(logged).toContain("@session ping");
    warn.mockRestore();
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

  it("records ONE row for a role that sits under all three settings keys", async () => {
    // The end of the dedup story, and the half that actually breaks Postgres:
    // three identical (session_id, role_id) rows in one upsert statement fail
    // with 21000 "ON CONFLICT DO UPDATE command cannot affect row a second
    // time", so the ping posts, records nothing, and fires again next tick.
    // Driven off the real GET output rather than a hand-written body, because
    // the bot posts exactly what it was handed.
    selfRoles = [];
    settings = [
      CHANNEL,
      { key: "session_ping_competitive_role_id", value: ONE_ROLE },
      { key: "session_ping_recreational_role_id", value: ONE_ROLE },
      { key: "session_ping_all_role_id", value: ONE_ROLE },
    ];
    const ping = only(await due());

    const { POST } = await import("../route");
    const res = await POST(
      req("/api/discord/session-pings", {
        method: "POST",
        body: JSON.stringify({
          sessionId: ping.sessionId,
          roleIds: ping.roleIds,
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(upserted).toHaveBeenCalledWith([
      { session_id: "s1", role_id: ONE_ROLE },
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
