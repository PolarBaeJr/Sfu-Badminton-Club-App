import { describe, it, expect, vi, beforeEach } from "vitest";

// What this file guards: the app decides, and the two decisions that are easy
// to get subtly wrong are (a) never announce something that is not public, and
// (b) never let the change detector chase its own tail.
//
// (b) is the one worth reading twice. Discord refuses a start time in the past,
// which is the ROUTINE case — drafts sit around and get activated on the
// morning of day one — so the send value is clamped forward. If the clamped
// value were also what got recorded, the next tick would compare the
// tournament's real start against a moving target and PATCH forever.

let settings: { key: string; value: string }[] = [];
let mapped: Record<string, unknown>[] = [];
let tournaments: Record<string, unknown>[] = [];
let readError: Record<string, { code: string; message: string } | null> = {};
const upserted = vi.fn();
const deleted = vi.fn();

// APPLIES .eq() FOR REAL, which matters more here than it looks.
//
// The cancel path depends on the route issuing TWO reads and merging them: the
// announceable set is status = 'active', and an archived tournament is only in
// the second read, the one by mapped id. A stub that ignored .eq() would hand
// the archived row back to BOTH queries, and the cancel tests would pass
// against a route that never made the second read at all.
function thenable(rows: Record<string, unknown>[], error: unknown = null) {
  const filters: [string, unknown][] = [];
  const builder: Record<string, unknown> = {};
  let cap: number | null = null;
  for (const method of ["select", "is", "not", "gte", "lte", "in", "or", "order"]) {
    builder[method] = () => builder;
  }
  // APPLIED FOR REAL. The mapping read's .limit() is a safety bound, not a
  // paging detail: it is what keeps the id list below PGRST_DB_MAX_ROWS, and
  // therefore what stops a truncated read from looking like "every tournament
  // was deleted" to the orphan sweep.
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
      if (table === "discord_settings")
        return thenable(settings, readError.settings ?? null);
      if (table === "tournaments")
        return thenable(tournaments, readError.tournaments ?? null);
      if (table === "discord_tournament_events") {
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
function req(path = "/api/discord/tournament-events?guildId=g1", init: RequestInit = {}) {
  return new Request(`http://localhost${path}`, {
    ...init,
    headers: {
      authorization: "Bearer test-secret",
      "x-forwarded-for": `10.7.0.${(bucket += 1)}`,
      ...(init.headers as Record<string, string> | undefined),
    },
  });
}

interface Action {
  kind: string;
  tournamentId: string;
  discordEventId: string | null;
  name: string;
  startsAt: string;
  endsAt: string;
  syncedStartsAt: string;
  syncedEndsAt: string;
  patchTimes: boolean;
  location: string | null;
  description: string;
}

async function run(): Promise<{
  actions: Action[];
  skipped: { tournamentId: string; reason: string }[];
}> {
  const { GET } = await import("../route");
  const res = await GET(req());
  return (await res.json()) as {
    actions: Action[];
    skipped: { tournamentId: string; reason: string }[];
  };
}

function only(actions: Action[]): Action {
  expect(actions).toHaveLength(1);
  return actions[0] as Action;
}

function clubDay(offsetDays: number): string {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return d.toLocaleDateString("en-CA", { timeZone: "America/Vancouver" });
}

function tournament(overrides: Record<string, unknown> = {}) {
  return {
    id: "t1",
    name: "Fall Open",
    start_date: clubDay(7),
    end_date: clubDay(8),
    status: "active",
    suspended_at: null,
    tournament_events: [{ event_type: "mens_singles" }, { event_type: "womens_doubles" }],
    ...overrides,
  };
}

beforeEach(() => {
  process.env.DISCORD_SERVICE_SECRET = "test-secret";
  readError = {};
  mapped = [];
  upserted.mockReset();
  deleted.mockReset();
  settings = [
    { key: "tournament_event_start_time", value: "09:00" },
    { key: "tournament_event_end_time", value: "18:00" },
    { key: "tournament_event_location", value: "SFU Burnaby" },
  ];
  tournaments = [tournament()];
});

describe("GET /api/discord/tournament-events", () => {
  it("refuses without the service secret", async () => {
    const { GET } = await import("../route");
    const bad = new Request("http://localhost/api/discord/tournament-events?guildId=g1", {
      headers: { authorization: "Bearer wrong" },
    });
    expect((await GET(bad)).status).toBe(401);
  });

  it("offers a create for an active tournament with no Discord event yet", async () => {
    const action = only((await run()).actions);

    expect(action.kind).toBe("create");
    expect(action.name).toBe("Fall Open");
    expect(action.location).toBe("SFU Burnaby");
    // The individual draws are named in the description rather than becoming
    // separate Discord events — tournament_events carries no times of its own.
    expect(action.description).toContain("Men");
    expect(action.description).toContain("Doubles");
  });

  it("never announces a DRAFT", async () => {
    // Draft is where an exec assembles one. RLS lets a member read it; that is
    // not the same as the bot pushing it into everyone's Events tab. What
    // enforces it is the query narrowing to status = 'active' — which is why
    // the stub above applies .eq() rather than ignoring it.
    tournaments = [tournament({ status: "draft" })];
    expect((await run()).actions).toEqual([]);
  });

  it("pulls the Discord event when a tournament is reverted to draft", async () => {
    // The in-memory half of the same rule, and the half the query cannot do:
    // an unpublished tournament reaches this route through the by-id read, and
    // has to lose the event it already has.
    tournaments = [tournament({ status: "draft" })];
    mapped = [
      {
        tournament_id: "t1",
        discord_event_id: "evt-1",
        synced_name: "Fall Open",
        synced_starts_at: new Date().toISOString(),
        synced_ends_at: new Date().toISOString(),
      },
    ];

    expect(only((await run()).actions).kind).toBe("cancel");
  });

  it("clamps a start already gone but records the tournament's own time", async () => {
    // The whole reason the two values are separate.
    tournaments = [tournament({ start_date: clubDay(-1), end_date: clubDay(2) })];
    const action = only((await run()).actions);

    expect(Date.parse(action.startsAt)).toBeGreaterThan(Date.now());
    expect(Date.parse(action.syncedStartsAt)).toBeLessThan(Date.now());
  });

  it("skips a tournament that has already finished, and says why", async () => {
    tournaments = [tournament({ start_date: clubDay(-9), end_date: clubDay(-8) })];
    const { actions, skipped } = await run();

    expect(actions).toEqual([]);
    expect(skipped).toEqual([{ tournamentId: "t1", reason: "already_ended" }]);
  });

  it("offers nothing when the Discord event already matches", async () => {
    const first = only((await run()).actions);
    mapped = [
      {
        tournament_id: "t1",
        discord_event_id: "evt-1",
        synced_name: "Fall Open",
        synced_starts_at: first.syncedStartsAt,
        synced_ends_at: first.syncedEndsAt,
      },
    ];

    expect((await run()).actions).toEqual([]);
  });

  it("offers an update after a rename", async () => {
    const first = only((await run()).actions);
    mapped = [
      {
        tournament_id: "t1",
        discord_event_id: "evt-1",
        synced_name: "Autumn Open",
        synced_starts_at: first.syncedStartsAt,
        synced_ends_at: first.syncedEndsAt,
      },
    ];

    const action = only((await run()).actions);
    expect(action.kind).toBe("update");
    expect(action.discordEventId).toBe("evt-1");
    expect(action.name).toBe("Fall Open");
    // Not started, so the schedule goes with it.
    expect(action.patchTimes).toBe(true);
  });

  it("does NOT retime an event Discord has already started", async () => {
    // The loop this prevents needs nothing to go wrong: a tournament is
    // mid-run, an exec edits tournament_event_start_time — which moves the
    // computed start for EVERY mapped tournament at once — Discord refuses to
    // retime an event in progress, nothing is recorded, and the next tick
    // computes the identical diff. Every fifteen minutes, for days.
    tournaments = [tournament({ start_date: clubDay(-1), end_date: clubDay(2) })];
    mapped = [
      {
        tournament_id: "t1",
        discord_event_id: "evt-1",
        synced_name: "Fall Open",
        // A start on the hour, so the club-time computation cannot match it.
        synced_starts_at: "2020-01-01T00:00:00.000Z",
        synced_ends_at: "2020-01-02T00:00:00.000Z",
      },
    ];

    const { actions, skipped } = await run();
    expect(actions).toEqual([]);
    expect(skipped).toEqual([{ tournamentId: "t1", reason: "started_cannot_retime" }]);
  });

  it("still pushes a RENAME onto a started event, with the times left alone", async () => {
    // A rename is the change members actually notice, so it lands — and
    // recording the tournament's current times alongside it settles the
    // comparison, which is what stops the retry loop rather than merely
    // narrowing it.
    tournaments = [tournament({ name: "Autumn Open", start_date: clubDay(-1), end_date: clubDay(2) })];
    mapped = [
      {
        tournament_id: "t1",
        discord_event_id: "evt-1",
        synced_name: "Fall Open",
        synced_starts_at: "2020-01-01T00:00:00.000Z",
        synced_ends_at: "2020-01-02T00:00:00.000Z",
      },
    ];

    const action = only((await run()).actions);
    expect(action.kind).toBe("update");
    expect(action.name).toBe("Autumn Open");
    expect(action.patchTimes).toBe(false);
    // Recorded anyway. Discord keeps the times it was created with; they
    // describe an event already under way, which nobody can act on.
    expect(Date.parse(action.syncedStartsAt)).toBeLessThan(Date.now());
  });

  it("cancels the Discord event when the tournament is suspended", async () => {
    // A suspended tournament is one the club has told members is off. Leaving a
    // live event with a reminder attached contradicts that where they look.
    tournaments = [tournament({ suspended_at: new Date().toISOString() })];
    mapped = [
      {
        tournament_id: "t1",
        discord_event_id: "evt-1",
        synced_name: "Fall Open",
        synced_starts_at: new Date().toISOString(),
        synced_ends_at: new Date().toISOString(),
      },
    ];

    const action = only((await run()).actions);
    expect(action.kind).toBe("cancel");
    expect(action.discordEventId).toBe("evt-1");
  });

  it("cancels when the tournament is archived", async () => {
    tournaments = [tournament({ status: "archived" })];
    mapped = [
      {
        tournament_id: "t1",
        discord_event_id: "evt-1",
        synced_name: "Fall Open",
        synced_starts_at: new Date().toISOString(),
        synced_ends_at: new Date().toISOString(),
      },
    ];

    expect(only((await run()).actions).kind).toBe("cancel");
  });

  it("CANCELS an event whose tournament was DELETED outright", async () => {
    // deleteTournament is a hard DELETE, so there is no row left for the loop
    // to reach — and without this sweep it would be the one way of removing a
    // tournament that left its Discord event standing forever, while archiving,
    // suspending and completing all took it down.
    //
    // Reachable only because 00169 leaves tournament_id un-referenced: an
    // ON DELETE CASCADE would take the mapping and the event id with it.
    tournaments = [];
    mapped = [
      {
        tournament_id: "t1",
        discord_event_id: "evt-1",
        synced_name: "Fall Open",
        synced_starts_at: new Date().toISOString(),
        synced_ends_at: new Date().toISOString(),
      },
    ];

    const action = only((await run()).actions);
    expect(action.kind).toBe("cancel");
    expect(action.tournamentId).toBe("t1");
    expect(action.discordEventId).toBe("evt-1");
  });

  it("CAPS the mapping read, and says when the cap bites", async () => {
    // What makes the sweep above safe. If the mapping read could hand back more
    // ids than the read that resolves them, everything past the ceiling would
    // come back missing and be cancelled in one tick.
    tournaments = [];
    mapped = Array.from({ length: 600 }, (_, i) => ({
      tournament_id: `t${i}`,
      discord_event_id: `evt-${i}`,
      synced_name: "Fall Open",
      synced_starts_at: new Date().toISOString(),
      synced_ends_at: new Date().toISOString(),
    }));

    const { actions, skipped } = await run();

    expect(actions).toHaveLength(500);
    expect(skipped).toContainEqual({ tournamentId: "*", reason: "mapping_cap_reached" });
  });

  it("FAILS CLOSED when the mapping read errors", async () => {
    // Treating it as "nothing announced yet" would create a SECOND Discord
    // event for every tournament that already has one, on every tick.
    readError.mapped = { code: "42P01", message: "relation does not exist" };
    const { GET } = await import("../route");
    expect((await GET(req())).status).toBe(503);
  });

  it("falls back rather than throwing on a malformed time setting", async () => {
    settings = [{ key: "tournament_event_start_time", value: "not a time" }];
    expect(only((await run()).actions).kind).toBe("create");
  });
});

describe("POST /api/discord/tournament-events", () => {
  it("records the mapping the bot confirmed", async () => {
    const { POST } = await import("../route");
    const res = await POST(
      req("/api/discord/tournament-events", {
        method: "POST",
        body: JSON.stringify({
          tournamentId: "t1",
          guildId: "g1",
          discordEventId: "evt-1",
          name: "Fall Open",
          syncedStartsAt: "2026-09-01T16:00:00.000Z",
          syncedEndsAt: "2026-09-02T01:00:00.000Z",
        }),
      }),
    );

    expect(res.status).toBe(200);
    expect(upserted).toHaveBeenCalledWith(
      expect.objectContaining({
        tournament_id: "t1",
        guild_id: "g1",
        discord_event_id: "evt-1",
        synced_starts_at: "2026-09-01T16:00:00.000Z",
      }),
    );
  });

  it("rejects a half-filled mapping instead of storing one", async () => {
    // A row missing synced_* would compare as changed forever.
    const { POST } = await import("../route");
    const res = await POST(
      req("/api/discord/tournament-events", {
        method: "POST",
        body: JSON.stringify({ tournamentId: "t1", guildId: "g1", discordEventId: "evt-1" }),
      }),
    );

    expect(res.status).toBe(400);
    expect(upserted).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/discord/tournament-events", () => {
  it("clears one mapping", async () => {
    const { DELETE } = await import("../route");
    const res = await DELETE(
      req("/api/discord/tournament-events?tournamentId=t1&guildId=g1", { method: "DELETE" }),
    );

    expect(res.status).toBe(200);
    expect(deleted).toHaveBeenCalled();
  });

  it("refuses an unscoped delete", async () => {
    const { DELETE } = await import("../route");
    const res = await DELETE(
      req("/api/discord/tournament-events?tournamentId=t1", { method: "DELETE" }),
    );

    expect(res.status).toBe(400);
    expect(deleted).not.toHaveBeenCalled();
  });
});
