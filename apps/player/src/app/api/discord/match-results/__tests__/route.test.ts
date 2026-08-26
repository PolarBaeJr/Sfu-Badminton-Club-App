import { describe, it, expect, vi, beforeEach } from "vitest";

// What this file is really guarding.
//
// /announcements and /tournament-events carry an orphan sweep and a liveness
// guard, and the reflex is to copy both here. That reflex is WRONG, and the two
// tests that matter most below prove the route resists it:
//
//   "leaves a mapped match alone when it is not in the window"
//   "does NOT retract anything when the matches read comes back empty"
//
// A confirmed match is never hard-deleted — the only .delete() on matches is
// scoped to never-confirmed rows — so absence can only mean "unchanged". A
// sweep would read absence as deletion and start tearing down live results, and
// a liveness guard would protect against a failure mode that already resolves
// safely. Both tests fail the moment somebody adds either.
//
// The stub's .limit() and .gte() are REAL, deliberately. A no-op .gte() would
// hand the window read every row and make the first of those two tests
// vacuous — it would pass whether or not the route swept.

interface MatchSeed {
  id: string;
  played_at: string | null;
  updated_at: string;
  match_type: string;
  format: string;
  score_summary: string | null;
  winner_side: string | null;
  result_status: string;
  event_type: string;
  match_participants: {
    team_side: string;
    win_flag: boolean | null;
    player: {
      id: string;
      full_name: string | null;
      handle: string | null;
      hide_from_leaderboard: boolean | null;
    } | null;
  }[];
}

let matches: MatchSeed[] = [];
let mappings: Record<string, unknown>[] = [];
let settings: { key: string; value: string }[] = [];
let matchesError: { message: string } | null = null;
let mappingError: { message: string } | null = null;
/** Every table the route touched, in order. */
const reads: string[] = [];
/** Every `.in(...)` the mapping read spelled out. */
const mappingInArgs: [string, unknown[]][] = [];

const upserts: Record<string, unknown>[] = [];
const deletes: [string, unknown][][] = [];

function iso(offsetHours: number): string {
  return new Date(Date.now() + offsetHours * 3600_000).toISOString();
}

function player(over: Record<string, unknown> = {}) {
  return {
    id: "p1",
    full_name: "Alice Nguyen",
    handle: "alice",
    hide_from_leaderboard: false,
    ...over,
  };
}

/** A confirmed, relayable singles match: Alice (side a) beat Bao (side b). */
function match(over: Partial<MatchSeed> = {}): MatchSeed {
  return {
    id: "m1",
    played_at: iso(-2),
    updated_at: iso(-2),
    match_type: "singles",
    format: "best_of_3_21",
    score_summary: "21-18, 19-21, 21-15",
    winner_side: "a",
    result_status: "confirmed",
    event_type: "rated_challenge",
    match_participants: [
      { team_side: "a", win_flag: true, player: player() },
      {
        team_side: "b",
        win_flag: false,
        player: player({ id: "p2", full_name: "Bao Tran", handle: "bao" }),
      },
    ],
    ...over,
  };
}

function mapping(over: Record<string, unknown> = {}) {
  return {
    match_id: "m1",
    channel_id: "chan-old",
    discord_message_id: "msg-1",
    synced_summary: "Alice Nguyen def. Bao Tran — 21-18, 19-21, 21-15",
    ...over,
  };
}

// The window filter is applied for real. Anything the route does NOT filter on
// is a no-op, so a filter the route stops sending fails loudly here rather than
// silently widening the read.
function matchesBuilder() {
  let rows = matches;
  const builder: Record<string, unknown> = {};
  builder.select = () => builder;
  // REAL, and it has to be: .limit() truncates whatever .order() left, so a
  // no-op sort here makes the ordering test pass no matter which column the
  // route sorts on — the exact bug it exists to catch.
  builder.order = (column: string, opts?: { ascending?: boolean }) => {
    const dir = opts?.ascending === false ? -1 : 1;
    rows = [...rows].sort(
      (a, b) => dir * String(a[column as keyof MatchSeed]).localeCompare(String(b[column as keyof MatchSeed])),
    );
    return builder;
  };
  builder.not = (column: string, op: string) => {
    if (op === "is") rows = rows.filter((r) => r[column as keyof MatchSeed] !== null);
    return builder;
  };
  builder.gte = (column: string, value: string) => {
    rows = rows.filter((r) => String(r[column as keyof MatchSeed]) >= value);
    return builder;
  };
  builder.eq = (column: string, value: unknown) => {
    rows = rows.filter((r) => r[column as keyof MatchSeed] === value);
    return builder;
  };
  // REAL, so the cap test is not vacuous.
  builder.limit = (n: number) => {
    rows = rows.slice(0, n);
    return builder;
  };
  builder.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: matchesError ? null : rows, error: matchesError }).then(resolve);
  return builder;
}

function mappingBuilder() {
  let rows = mappings;
  const builder: Record<string, unknown> = {};
  builder.select = () => builder;
  builder.eq = () => builder;
  builder.order = () => builder;
  builder.limit = (n: number) => {
    rows = rows.slice(0, n);
    return builder;
  };
  // REAL, deliberately. The route aims this read at the ids the window
  // returned; a no-op .in() would hand it every mapping and make the targeting
  // untested — which is precisely the bug where retraction reach and window
  // reach drift apart.
  builder.in = (column: string, values: unknown[]) => {
    mappingInArgs.push([column, values]);
    rows = rows.filter((r) => values.includes(r[column]));
    return builder;
  };
  builder.upsert = (row: Record<string, unknown>) => {
    upserts.push(row);
    return Promise.resolve({ error: null });
  };
  builder.delete = () => {
    const filters: [string, unknown][] = [];
    const del: Record<string, unknown> = {};
    del.eq = (c: string, v: unknown) => {
      filters.push([c, v]);
      return del;
    };
    del.then = (resolve: (v: unknown) => unknown) => {
      deletes.push(filters);
      return Promise.resolve({ error: null }).then(resolve);
    };
    return del;
  };
  builder.then = (resolve: (v: unknown) => unknown) =>
    Promise.resolve({ data: mappingError ? null : rows, error: mappingError }).then(resolve);
  return builder;
}

vi.mock("@/lib/supabase-server", () => ({
  createServiceRoleClient: () => ({
    from: (table: string) => {
      reads.push(table);
      if (table === "discord_settings")
        return {
          select: () => Promise.resolve({ data: settings, error: null }),
        };
      if (table === "discord_match_posts") return mappingBuilder();
      if (table === "matches") return matchesBuilder();
      throw new Error(`unexpected table ${table}`);
    },
  }),
}));

/** Mirrors MAX_WINDOW in the route; the cap test above asserts they agree. */
const MAX_WINDOW_IN_TEST = 150;

let bucket = 0;
function req(path = "?guildId=g1") {
  return new Request(`http://localhost/api/discord/match-results${path}`, {
    headers: {
      authorization: "Bearer test-secret",
      "x-forwarded-for": `10.9.0.${(bucket += 1)}`,
    },
  });
}

interface Action {
  kind: string;
  matchId: string;
  channelId: string;
  discordMessageId: string | null;
  summary: string;
  teamA: string;
  teamB: string;
  score: string;
  winner: string | null;
}

async function run(path?: string) {
  const { GET } = await import("../route");
  const res = await GET(req(path));
  return {
    status: res.status,
    body: (await res.json()) as {
      actions?: Action[];
      skipped?: { matchId: string; reason: string }[];
      windowCapReached?: number;
      mappingCapReached?: number;
    },
  };
}

function only(actions: Action[] | undefined): Action {
  expect(actions).toHaveLength(1);
  return (actions as Action[])[0] as Action;
}

beforeEach(() => {
  process.env.DISCORD_SERVICE_SECRET = "test-secret";
  settings = [{ key: "match_results_channel_id", value: "chan-1" }];
  matches = [match()];
  mappings = [];
  matchesError = null;
  mappingError = null;
  upserts.length = 0;
  deletes.length = 0;
  reads.length = 0;
  mappingInArgs.length = 0;
});

describe("GET /api/discord/match-results", () => {
  it("refuses without the service secret", async () => {
    const { GET } = await import("../route");
    const bad = new Request("http://localhost/api/discord/match-results?guildId=g1", {
      headers: { authorization: "Bearer wrong" },
    });
    expect((await GET(bad)).status).toBe(401);
  });

  it("posts a confirmed rated result", async () => {
    const a = only((await run()).body.actions);

    expect(a.kind).toBe("post");
    expect(a.channelId).toBe("chan-1");
    expect(a.discordMessageId).toBeNull();
    expect(a.summary).toBe("Alice Nguyen def. Bao Tran — 21-18, 19-21, 21-15");
    expect(a.winner).toBe("a");
  });

  it("NEVER sends a rating delta or a post rating", async () => {
    // The point of the whole design: the score is a fact about a game, the
    // rating change is a judgment about a person. Serialised so a future edit
    // that widens the select is caught here rather than in the channel.
    const raw = JSON.stringify((await run()).body);

    expect(raw).not.toMatch(/rating_delta|ratingDelta|post_rating|postRating/);
  });

  // ---- DOUBLES ------------------------------------------------------------

  it("groups a doubles match by team_side rather than assuming two players", async () => {
    // Singles-shaped code renders one name per side and silently drops two
    // members from a result they played in.
    matches = [
      match({
        match_type: "doubles",
        match_participants: [
          { team_side: "a", win_flag: true, player: player({ id: "p1", full_name: "Alice Nguyen" }) },
          { team_side: "a", win_flag: true, player: player({ id: "p2", full_name: "Bao Tran" }) },
          { team_side: "b", win_flag: false, player: player({ id: "p3", full_name: "Cam Diaz" }) },
          { team_side: "b", win_flag: false, player: player({ id: "p4", full_name: "Dev Rao" }) },
        ],
      }),
    ];

    const a = only((await run()).body.actions);
    expect(a.teamA).toBe("Alice Nguyen & Bao Tran");
    expect(a.teamB).toBe("Cam Diaz & Dev Rao");
    expect(a.summary).toBe("Alice Nguyen & Bao Tran def. Cam Diaz & Dev Rao — 21-18, 19-21, 21-15");
  });

  it("renders the same names in the same order however the rows arrive", async () => {
    // Unsorted, the roster would look changed on every tick and edit the same
    // message forever.
    const roster = [
      { team_side: "a", win_flag: true, player: player({ id: "p2", full_name: "Bao Tran" }) },
      { team_side: "a", win_flag: true, player: player({ id: "p1", full_name: "Alice Nguyen" }) },
      { team_side: "b", win_flag: false, player: player({ id: "p3", full_name: "Cam Diaz" }) },
    ];
    matches = [match({ match_type: "doubles", match_participants: roster })];

    expect(only((await run()).body.actions).teamA).toBe("Alice Nguyen & Bao Tran");
  });

  it("falls back to the handle when a player has no name", async () => {
    matches = [
      match({
        match_participants: [
          { team_side: "a", win_flag: true, player: player({ full_name: null, handle: "alice" }) },
          {
            team_side: "b",
            win_flag: false,
            player: player({ id: "p2", full_name: null, handle: "bao" }),
          },
        ],
      }),
    ];
    expect(only((await run()).body.actions).summary).toBe("alice def. bao — 21-18, 19-21, 21-15");
  });

  // ---- WHAT NEVER GOES OUT ------------------------------------------------

  it.each([
    ["pending_confirmation"],
    ["disputed"],
    ["voided"],
    ["walkover"],
  ])("never posts a %s match", async (status) => {
    matches = [match({ result_status: status })];
    const { body } = await run();

    expect(body.actions).toEqual([]);
    expect(body.skipped?.[0]?.reason).toContain(status);
  });

  it("never posts a casual match", async () => {
    // A club night of doubles rotations would be a firehose.
    matches = [match({ event_type: "casual" })];
    expect((await run()).body.actions).toEqual([]);
  });

  it("holds back the WHOLE match when any participant is hidden from ranking", async () => {
    // Not "posted with that name redacted" — in a two-player match that
    // identifies the opt-out by elimination.
    matches = [
      match({
        match_participants: [
          { team_side: "a", win_flag: true, player: player({ hide_from_leaderboard: true }) },
          { team_side: "b", win_flag: false, player: player({ id: "p2", full_name: "Bao Tran" }) },
        ],
      }),
    ];
    const { body } = await run();

    expect(body.actions).toEqual([]);
    expect(body.skipped?.[0]?.reason).toContain("hidden");
  });

  it("does not post a confirmed match with no winner_side", async () => {
    matches = [match({ winner_side: null })];
    expect((await run()).body.actions).toEqual([]);
  });

  it("does not post 'def.' with no names when the participant join comes back empty", async () => {
    matches = [match({ match_participants: [] })];
    const { body } = await run();

    expect(body.actions).toEqual([]);
    expect(body.skipped?.[0]?.reason).toContain("participants");
  });

  // ---- FREE TEXT ----------------------------------------------------------

  it("strips markdown and mention syntax out of the score", async () => {
    matches = [match({ score_summary: "21-18 `@everyone` <@1234> **x**" })];
    const a = only((await run()).body.actions);

    expect(a.score).toBe("21-18 everyone 1234 x");
    expect(a.score).not.toMatch(/[`*_~|@<>]/);
  });

  it("caps a long score rather than sending it whole", async () => {
    matches = [match({ score_summary: "9".repeat(400) })];
    expect(only((await run()).body.actions).score.length).toBeLessThanOrEqual(120);
  });

  it("posts without a score when there is none", async () => {
    matches = [match({ score_summary: null })];
    expect(only((await run()).body.actions).summary).toBe("Alice Nguyen def. Bao Tran");
  });

  // ---- EDIT ---------------------------------------------------------------

  it("says nothing when the mapped summary still matches", async () => {
    mappings = [mapping()];
    expect((await run()).body.actions).toEqual([]);
  });

  it("edits when a corrected score changes the line", async () => {
    mappings = [mapping()];
    matches = [match({ score_summary: "21-18, 21-15", updated_at: iso(-1) })];

    const a = only((await run()).body.actions);
    expect(a.kind).toBe("edit");
    expect(a.discordMessageId).toBe("msg-1");
    // The message it is actually in, not the configured channel: repointing the
    // setting does not move messages already posted.
    expect(a.channelId).toBe("chan-old");
  });

  it("edits when the roster was corrected but the score was not", async () => {
    // Why the mapping stores the rendered line and not score_summary.
    mappings = [mapping()];
    matches = [
      match({
        match_participants: [
          { team_side: "a", win_flag: true, player: player() },
          {
            team_side: "b",
            win_flag: false,
            player: player({ id: "p9", full_name: "Cam Diaz" }),
          },
        ],
      }),
    ];
    expect(only((await run()).body.actions).kind).toBe("edit");
  });

  // ---- RETRACT ------------------------------------------------------------

  it.each([
    ["voided", { result_status: "voided" }],
    ["disputed", { result_status: "disputed" }],
    // convertMatchToCasual rewrites BOTH, and either alone must be enough.
    ["converted to casual", { event_type: "casual", result_status: "pending_confirmation" }],
    // NOT "hidden after the fact" — flipping hide_from_leaderboard does not
    // bump matches.updated_at, so an already-posted match cannot re-enter the
    // window that way. What this case pins is that a hidden participant is
    // grounds for retraction WHEN some other edit brings the match back.
    ["hidden, on a match updated for another reason", {}],
  ])("retracts a mapped match once it is %s", async (label, over) => {
    mappings = [mapping()];
    matches = [
      match(
        label.startsWith("hidden")
          ? {
              match_participants: [
                { team_side: "a", win_flag: true, player: player({ hide_from_leaderboard: true }) },
                { team_side: "b", win_flag: false, player: player({ id: "p2" }) },
              ],
            }
          : (over as Partial<MatchSeed>),
      ),
    ];

    const a = only((await run()).body.actions);
    expect(a.kind).toBe("retract");
    expect(a.discordMessageId).toBe("msg-1");
    expect(a.channelId).toBe("chan-old");
  });

  it("can still retract after the channel setting is cleared", async () => {
    // Otherwise a club that clears the setting to stop the relay strands every
    // message it already posted.
    settings = [];
    mappings = [mapping()];
    matches = [match({ result_status: "voided" })];

    expect(only((await run()).body.actions).kind).toBe("retract");
  });

  it("still reads matches with no channel set, so retraction keeps working", async () => {
    // The relay being off must not disarm takedowns: a club that clears the
    // setting to stop posting would otherwise strand every message it already
    // sent. Nothing new goes out, and the reason is legible — "we played and
    // nothing appeared" needs an answer that is not a shrug.
    settings = [];
    const { body } = await run();

    expect(body.actions).toEqual([]);
    expect(body.skipped?.[0]?.reason).toContain("channel");
  });

  // ---- THE TWO PROPERTIES THAT REPLACE THE SWEEP AND THE GUARD ------------

  it("leaves a mapped match alone when it is not in the window", async () => {
    // THE NO-SWEEP PROPERTY. /announcements would treat this as a delete and
    // retract. Here absence means the match has not been touched in 72 hours,
    // which means it is unchanged, which means its message is still correct.
    //
    // The stub's .gte() is real, so this row is genuinely filtered out.
    mappings = [mapping()];
    matches = [match({ updated_at: iso(-500), played_at: iso(-500) })];

    const { status, body } = await run();
    expect(status).toBe(200);
    expect(body.actions).toEqual([]);
  });

  it("does NOT retract anything when the matches read comes back empty", async () => {
    // THE NO-LIVENESS-GUARD PROPERTY, and the inverse of 00170. There, an empty
    // read meant "everything was deleted" and would have wiped the channel, so
    // the route has to refuse. Here it means "nothing was touched", the safe
    // answer is inaction, and a guard would be protecting against nothing.
    mappings = [mapping({ match_id: "m1" }), mapping({ match_id: "m2" })];
    matches = [];

    const { status, body } = await run();
    expect(status).toBe(200);
    expect(body.actions).toEqual([]);
  });

  // ---- FAILURES AND CAPS --------------------------------------------------

  it("names a failed matches read rather than reporting nothing to do", async () => {
    matchesError = { message: "permission denied for table matches" };
    expect((await run()).status).toBe(503);
  });

  it("refuses rather than treating a failed mapping read as 'nothing relayed yet'", async () => {
    // That would post a SECOND copy of every result on every tick.
    mappingError = { message: "relation does not exist" };
    expect((await run()).status).toBe(503);
  });

  it("requires a guild", async () => {
    expect((await run("")).status).toBe(400);
  });

  it("reports the window cap instead of looking like it relayed everything", async () => {
    matches = Array.from({ length: 260 }, (_, i) => match({ id: `m${i}` }));
    const { body } = await run();

    expect(body.actions).toHaveLength(150);
    expect(body.windowCapReached).toBe(150);
  });

  it("truncates the window by updated_at, not by played_at", async () => {
    // THE ORDERING PROPERTY. A match played in April and voided this morning
    // belongs at the FRONT of the window: it is the one with something due. Sort
    // by played_at and it lands at the back, falls off the cap on any busy
    // night, reads as "absent, therefore unchanged", and its message stays up
    // forever — the retraction this whole route exists to deliver.
    mappings = [mapping({ match_id: "stale" })];
    matches = [
      // Old game, touched moments ago: voided, so it is due for retraction.
      match({ id: "stale", played_at: iso(-2000), updated_at: iso(-0.1), result_status: "voided" }),
      // A full cap's worth of results played more recently but touched earlier.
      ...Array.from({ length: MAX_WINDOW_IN_TEST }, (_, i) =>
        match({ id: `recent${i}`, played_at: iso(-1), updated_at: iso(-1) }),
      ),
    ];

    const { body } = await run();
    expect(body.actions?.some((a) => a.matchId === "stale" && a.kind === "retract")).toBe(true);
  });

  it("does not read mappings at all when the window is empty", async () => {
    // The cheap half of the no-liveness-guard property: no window rows means
    // nothing can be due, so there is nothing to compare mappings against.
    matches = [];
    await run();

    expect(reads).not.toContain("discord_match_posts");
  });

  it("reads only the mappings for matches in the window", async () => {
    // Retraction reach IS window reach. A blanket mapping read with its own
    // limit would let the two drift, and a match posted long ago and voided
    // today would come back unmapped — classified a skip, message left up.
    mappings = [mapping({ match_id: "m1" }), mapping({ match_id: "not-in-window" })];
    matches = [match({ id: "m1", result_status: "voided" })];

    const { body } = await run();
    expect(body.actions).toHaveLength(1);
    expect(only(body.actions).matchId).toBe("m1");

    // The read is TARGETED, not merely filtered afterwards. A blanket read
    // behaves the same until the guild has more mappings than its own limit,
    // at which point retraction quietly stops reaching the old ones — so the
    // targeting itself is the property, and it has to be asserted directly.
    expect(mappingInArgs).toEqual([["match_id", ["m1"]]]);
  });
});
