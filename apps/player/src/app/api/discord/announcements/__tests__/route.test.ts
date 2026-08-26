import { describe, it, expect, vi, beforeEach } from "vitest";

// THE TEST THAT MATTERS IN THIS FILE is the audience gate, and it is a
// SECURITY test rather than a behaviour one.
//
// announcement-visibility.ts decides who may read an announcement, and its
// audience rule is a per-VIEWER predicate: 'competitive' is matched against the
// reader's own players.status, 'eligible_only' against their eligibility_flag.
// A Discord channel is not a viewer. Relaying anything but target_audience =
// 'all' would publish club business to an approximation of its audience — and
// the approximation is known to drift, which is why the role reconcile sweep
// exists at all.
//
// The second thing here is the change detector. A relay that cannot tell "I
// already posted this" from "this is new" posts a duplicate club announcement
// into a channel members read, every five minutes.

let settings: { key: string; value: string }[] = [];
let mapped: Record<string, unknown>[] = [];
let announcements: Record<string, unknown>[] = [];
let readError: Record<string, { message: string } | null> = {};
const upserted = vi.fn();
const deleted = vi.fn();

// APPLIES .eq() FOR REAL. The retract path depends on the route issuing TWO
// reads and merging them: the relayable set is status = 'published', and an
// announcement pulled back to draft is only in the second read, the one by
// mapped id. A stub that ignored .eq() would hand the draft row to BOTH
// queries, and the retract tests would pass against a route that never made
// the second read.
function thenable(rows: Record<string, unknown>[], error: unknown = null) {
  const filters: [string, unknown][] = [];
  const builder: Record<string, unknown> = {};
  let cap: number | null = null;
  for (const m of ["select", "is", "not", "gte", "lte", "in", "or", "order"]) {
    builder[m] = () => builder;
  }
  // APPLIED FOR REAL, unlike the rest. The mapping read's .limit() is a safety
  // bound rather than a tidy-up — it is what keeps the second read below
  // PGRST_DB_MAX_ROWS, and therefore what stops a truncated read looking like
  // "every announcement was deleted". A stub that ignored it could not tell a
  // route that had dropped the cap from one that still had it.
  builder.limit = (n: number) => {
    cap = n;
    return builder;
  };
  builder.eq = (column: string, value: unknown) => {
    filters.push([column, value]);
    return builder;
  };
  builder.then = (resolve: (v: unknown) => unknown) => {
    const matched = rows.filter((r) => filters.every(([c, v]) => r[c] === v || c === "guild_id"));
    const data = error ? null : cap === null ? matched : matched.slice(0, cap);
    return Promise.resolve({ data, error }).then(resolve);
  };
  return builder;
}

vi.mock("@/lib/supabase-server", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      if (table === "discord_settings") return thenable(settings, readError.settings ?? null);
      if (table === "announcements") return thenable(announcements, readError.announcements ?? null);
      if (table === "discord_announcement_posts") {
        return {
          ...thenable(mapped, readError.mapped ?? null),
          upsert: (row: unknown) => {
            upserted(row);
            return Promise.resolve({ error: null });
          },
          delete: () => {
            const chain: Record<string, unknown> = {
              eq: () => chain,
              then: (resolve: (v: unknown) => unknown) => {
                deleted();
                return Promise.resolve({ error: null }).then(resolve);
              },
            };
            return chain;
          },
        };
      }
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

// Per-test IP: the limiter is module-level and is not reset between tests.
let bucket = 0;
function req(path = "/api/discord/announcements?guildId=g1", init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      authorization: "Bearer test-secret",
      "x-forwarded-for": `10.9.0.${(bucket += 1)}`,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

interface Action {
  kind: string;
  announcementId: string;
  channelId: string;
  discordMessageId: string | null;
  title: string;
  body: string;
  type: string;
  url: string | null;
}

async function run(): Promise<{
  actions: Action[];
  skipped: { announcementId: string; reason: string }[];
}> {
  const { GET } = await import("../route");
  const res = await GET(req());
  return (await res.json()) as {
    actions: Action[];
    skipped: { announcementId: string; reason: string }[];
  };
}

function only(actions: Action[]): Action {
  expect(actions).toHaveLength(1);
  return actions[0] as Action;
}

function announcement(overrides: Record<string, unknown> = {}) {
  return {
    id: "a1",
    title: "Courts closed Friday",
    body: "Gym maintenance. No session.",
    type: "warning",
    status: "published",
    target_audience: "all",
    expires_at: null,
    ...overrides,
  };
}

function mapping(overrides: Record<string, unknown> = {}) {
  return {
    announcement_id: "a1",
    channel_id: "c1",
    discord_message_id: "m1",
    synced_title: "Courts closed Friday",
    synced_body: "Gym maintenance. No session.",
    synced_type: "warning",
    ...overrides,
  };
}

beforeEach(() => {
  process.env.DISCORD_SERVICE_SECRET = "test-secret";
  readError = {};
  mapped = [];
  upserted.mockReset();
  deleted.mockReset();
  settings = [{ key: "announcement_channel_id", value: "c1" }];
  announcements = [announcement()];
});

describe("GET /api/discord/announcements — the audience gate", () => {
  it("refuses without the service secret", async () => {
    const { GET } = await import("../route");
    const bad = new Request("http://localhost/api/discord/announcements?guildId=g1", {
      headers: { authorization: "Bearer wrong" },
    });
    expect((await GET(bad)).status).toBe(401);
  });

  it("relays one addressed to everyone", async () => {
    const action = only((await run()).actions);

    expect(action.kind).toBe("post");
    expect(action.channelId).toBe("c1");
    expect(action.title).toBe("Courts closed Friday");
    expect(action.type).toBe("warning");
  });

  it.each(["competitive", "recreational", "eligible_only"])(
    "NEVER relays a '%s' announcement, and says why",
    async (audience) => {
      // The security test. Each of these is matched against a value that lives
      // on the READER — players.status, or eligibility_flag — and no Discord
      // channel carries either. Posting it anywhere would be publishing club
      // business to an approximation of its audience.
      announcements = [announcement({ target_audience: audience })];
      const { actions, skipped } = await run();

      expect(actions).toEqual([]);
      expect(skipped).toEqual([{ announcementId: "a1", reason: "narrow_audience" }]);
    },
  );

  it("RETRACTS a relayed message when the audience is narrowed after the fact", async () => {
    // The most dangerous edit an exec can make, and the one a relay that only
    // filtered on the way in would get wrong: the message stays up, publishing
    // exactly what the audience change was meant to stop.
    announcements = [announcement({ target_audience: "competitive" })];
    mapped = [mapping()];

    const action = only((await run()).actions);
    expect(action.kind).toBe("retract");
    expect(action.discordMessageId).toBe("m1");
  });

  it("RETRACTS a message whose announcement was DELETED outright", async () => {
    // The one retraction nothing else in the route can see. deleteAnnouncement
    // is a hard DELETE that demands a typed reason and audits it — the club
    // taking back what it said — and it leaves no row to iterate. Without this
    // sweep the most emphatic retraction the console offers would be the ONLY
    // one that left the Discord copy standing, while unpublishing, expiry and
    // narrowing the audience all took it down.
    //
    // Reachable at all only because 00170 leaves announcement_id un-referenced:
    // an ON DELETE CASCADE would take the mapping with the announcement, and the
    // message id would be gone with it.
    announcements = [];
    mapped = [mapping()];

    const action = only((await run()).actions);
    expect(action.kind).toBe("retract");
    expect(action.announcementId).toBe("a1");
    expect(action.discordMessageId).toBe("m1");
    expect(action.channelId).toBe("c1");
  });

  it("does not retract an announcement that is merely unchanged", async () => {
    // The other side of the sweep above. "Not in the fresh window" must not be
    // read as "deleted" — an announcement published last month is still up.
    mapped = [mapping()];

    expect((await run()).actions).toEqual([]);
  });

  it("CAPS the mapping read, and says when the cap bites", async () => {
    // The cap is what makes the orphan sweep safe. Production runs
    // PGRST_DB_MAX_ROWS=1000; if the mapping read could return more ids than
    // the read that resolves them, every id past the ceiling would come back
    // missing and be retracted — the whole channel emptied in one tick. Keeping
    // the mapping read well under the ceiling makes that arithmetically
    // impossible, so the cap is a security property and not a paging detail.
    mapped = Array.from({ length: 600 }, (_, i) =>
      mapping({ announcement_id: `a${i}`, discord_message_id: `m${i}` }),
    );
    announcements = [];

    const { actions, skipped } = await run();

    // 500, not 600: the read was capped before the ids were resolved.
    expect(actions).toHaveLength(500);
    expect(skipped).toContainEqual({ announcementId: "*", reason: "mapping_cap_reached" });
  });

  it("never relays a DRAFT", async () => {
    announcements = [announcement({ status: "draft" })];
    expect((await run()).actions).toEqual([]);
  });

  it("retracts when an announcement is pulled back to draft", async () => {
    // The in-memory half of the same rule, and the half the query cannot do: an
    // unpublished announcement reaches this route through the by-id read.
    announcements = [announcement({ status: "draft" })];
    mapped = [mapping()];

    expect(only((await run()).actions).kind).toBe("retract");
  });

  it("retracts an expired announcement and skips a fresh one that has expired", async () => {
    const past = new Date(Date.now() - 60_000).toISOString();
    announcements = [announcement({ expires_at: past })];

    expect((await run()).skipped).toEqual([{ announcementId: "a1", reason: "expired" }]);

    mapped = [mapping()];
    expect(only((await run()).actions).kind).toBe("retract");
  });
});

describe("GET /api/discord/announcements — the change detector", () => {
  it("offers nothing when the message already matches", async () => {
    mapped = [mapping()];
    expect((await run()).actions).toEqual([]);
  });

  it("edits after the title changes", async () => {
    announcements = [announcement({ title: "Courts closed Saturday" })];
    mapped = [mapping()];

    const action = only((await run()).actions);
    expect(action.kind).toBe("edit");
    expect(action.discordMessageId).toBe("m1");
    expect(action.title).toBe("Courts closed Saturday");
  });

  it("edits after the TYPE changes, so an escalated notice changes colour", async () => {
    announcements = [announcement({ type: "urgent" })];
    mapped = [mapping()];

    expect(only((await run()).actions).type).toBe("urgent");
  });

  it("edits in the channel the message IS in, not the newly configured one", async () => {
    // Repointing the setting does not move messages already posted, and editing
    // them at the new address would simply fail.
    settings = [{ key: "announcement_channel_id", value: "c2" }];
    announcements = [announcement({ title: "Moved" })];
    mapped = [mapping()];

    expect(only((await run()).actions).channelId).toBe("c1");
  });

  it("FAILS CLOSED when the mapping read errors", async () => {
    // Treating it as "nothing relayed yet" would post a second copy of every
    // announcement that already has one, into a channel members read.
    readError.mapped = { message: "relation does not exist" };
    const { GET } = await import("../route");
    expect((await GET(req())).status).toBe(503);
  });
});

describe("GET /api/discord/announcements — the channel setting", () => {
  it("relays nothing when no channel is configured", async () => {
    settings = [];
    expect((await run()).actions).toEqual([]);
  });

  it("can still RETRACT after the channel setting is cleared", async () => {
    // Otherwise a club that clears the setting to stop the relay leaves every
    // message it already posted stranded, with no way to take them down.
    settings = [];
    announcements = [announcement({ status: "draft" })];
    mapped = [mapping()];

    expect(only((await run()).actions).kind).toBe("retract");
  });
});

describe("POST /api/discord/announcements", () => {
  it("records the message the bot confirmed", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      req("/api/discord/announcements", {
        method: "POST",
        body: JSON.stringify({
          announcementId: "a1",
          guildId: "g1",
          channelId: "c1",
          discordMessageId: "m1",
          title: "Courts closed Friday",
          body: "Gym maintenance. No session.",
          type: "warning",
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(upserted).toHaveBeenCalledWith(
      expect.objectContaining({ announcement_id: "a1", discord_message_id: "m1" }),
    );
  });

  it("accepts an EMPTY body, because a title with no body is a real announcement", async () => {
    // body DEFAULT '' in 00001. Rejecting it would leave the message unrecorded
    // and reposted on every tick.
    const { POST } = await import("../route");
    const res = await POST(
      req("/api/discord/announcements", {
        method: "POST",
        body: JSON.stringify({
          announcementId: "a1",
          guildId: "g1",
          channelId: "c1",
          discordMessageId: "m1",
          title: "Season starts Monday",
          body: "",
          type: "info",
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(upserted).toHaveBeenCalled();
  });

  it("rejects a half-filled mapping instead of storing one", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      req("/api/discord/announcements", {
        method: "POST",
        body: JSON.stringify({ announcementId: "a1", guildId: "g1" }),
      }),
    );

    expect(res.status).toBe(400);
    expect(upserted).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/discord/announcements", () => {
  it("clears one mapping", async () => {
    const { DELETE } = await import("../route");
    const res = await DELETE(
      req("/api/discord/announcements?announcementId=a1&guildId=g1", { method: "DELETE" }),
    );

    expect(res.status).toBe(200);
    expect(deleted).toHaveBeenCalled();
  });

  it("refuses an unscoped delete", async () => {
    const { DELETE } = await import("../route");
    const res = await DELETE(
      req("/api/discord/announcements?announcementId=a1", { method: "DELETE" }),
    );

    expect(res.status).toBe(400);
    expect(deleted).not.toHaveBeenCalled();
  });
});
