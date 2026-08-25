# Discord Bot — Implementation Plan

Companion to [`discord-bot.md`](./discord-bot.md), which is the *what*. This is the
*how*, in the order it can actually be built.

The spec was written against an idealised app. Investigating the real one moved three
things, and the phasing below exists because of them.

---

## What the investigation changed

### 1. The RSVP list *is* the waitlist — and capacity is being added

The spec assumed `/register`, `/withdraw`, `/waitlist` as three operations. They are
two. What exists is **`session_rsvp`**, written by `setSessionIntent(sessionId, intent)`
where `intent ∈ {'going', 'declined', null}`, and the going-list in `created_at` order
*is* the queue. There is no waitlist table and there should not be one.

| Spec command | Reality |
|---|---|
| `/register <session>` | `setSessionIntent(id, 'going')` |
| `/withdraw <session>` | `setSessionIntent(id, 'declined')` |
| `/waitlist <session>` | **Removed.** Same operation as `/register`. |

`check_session_caps` / `session_cap_for` are a red herring — they cap how many *rated
matches* a player may play in a session, per `platform_settings`. Nothing to do with
attendance.

#### New app feature: `sessions.capacity`, nullable

`sessions` has no capacity column today. Adding one, **nullable**, where `NULL` means
uncapped — exactly today's behaviour, so the change is backward compatible on every
existing row.

**A capacity must never refuse an RSVP.** Accept it and rank it. Waitlist stays a
*derived view* — `intent = 'going'` ordered by queue time, everyone past `capacity` is
waitlisted — not a second table with its own lifecycle to drift. `setSessionIntent`
remains a plain upsert.

#### The ordering trap — this is the part that needs a new column

Ranking by `created_at` looks right and is not, because the two withdraw paths behave
differently:

- `intent = null` → the row is **DELETEd**. Re-RSVPing inserts a fresh row, so the
  player goes to the back. Correct.
- `intent = 'declined'` → the row is **upserted and persists**, `created_at` untouched.
  So `going → declined → going` **keeps the original position**.

With no capacity that is harmless. With a capacity it is a queue-jump: hold a spot,
decline, reclaim it ahead of everyone who joined in between. It also means the
`/withdraw → 'declined'` choice made earlier in this plan would be the exploitable one.

**Fix: rank by `going_since`, not `created_at`.** A column set to `now()` whenever
`intent` transitions *to* `'going'`, and left alone while it stays `'going'`. Then
declining and rejoining goes to the back, `'declined'` keeps its useful meaning as a
recorded "no", and `/withdraw → 'declined'` stays the right call.

#### Migration to run (phase 0)

```sql
-- Nullable: NULL = uncapped, which is every existing session.
ALTER TABLE public.sessions
  ADD COLUMN IF NOT EXISTS capacity INTEGER;

ALTER TABLE public.sessions
  DROP CONSTRAINT IF EXISTS sessions_capacity_check;
ALTER TABLE public.sessions
  ADD CONSTRAINT sessions_capacity_check
  CHECK (capacity IS NULL OR capacity > 0);

COMMENT ON COLUMN public.sessions.capacity IS
  'Attendance cap, or NULL for uncapped. Never refuses an RSVP: everyone past the cap '
  'in going_since order is waitlisted. The waitlist is derived, not stored.';

-- Queue position. Distinct from created_at, which survives a decline and would
-- let going -> declined -> going reclaim an earlier spot.
ALTER TABLE public.session_rsvp
  ADD COLUMN IF NOT EXISTS going_since timestamptz;

-- Backfill so nobody currently RSVP'd loses their place.
UPDATE public.session_rsvp
   SET going_since = created_at
 WHERE intent = 'going' AND going_since IS NULL;

CREATE OR REPLACE FUNCTION public.touch_rsvp_going_since()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.intent = 'going' THEN
    -- Only stamp on a transition INTO going; an unchanged going row keeps its place.
    IF TG_OP = 'INSERT' OR OLD.intent IS DISTINCT FROM 'going' THEN
      NEW.going_since := now();
    END IF;
  ELSE
    NEW.going_since := NULL;
  END IF;
  RETURN NEW;
END $$;

DROP TRIGGER IF EXISTS trg_rsvp_going_since ON public.session_rsvp;
CREATE TRIGGER trg_rsvp_going_since
  BEFORE INSERT OR UPDATE ON public.session_rsvp
  FOR EACH ROW EXECUTE FUNCTION public.touch_rsvp_going_since();

CREATE INDEX IF NOT EXISTS idx_session_rsvp_queue
  ON public.session_rsvp (session_id, going_since)
  WHERE intent = 'going';

NOTIFY pgrst, 'reload schema';
```

**Yours to run.** Note the `NOTIFY` at the end — without it PostgREST serves the old
shape and failed reads come back as **empty lists, not errors**.

#### Open, because it is club policy not code

**Promotion notifications.** When someone inside the cap declines, the first waitlisted
player is promoted by definition — the derived view just changes. Do they get told?
That is a real feature (a notification, and a decision about how late is too late to be
told you're in) and it is not part of this plan unless you want it.

### 2. Two expected failures dominate the main write path

`setSessionIntentImpl` rejects before writing when:

- `assertCurrentWaiver()` fails — the member's waiver is not current
- `session.status !== 'open'` → `'This session is closed'`
- RLS returns `42501` → `'RSVP is not open for this session'`

These are not edge cases; they are the two or three things that will actually happen.
The bot must render them as instructions, not as failures:

> **Waiver:** "Your waiver needs re-signing before you can RSVP — <link>"
> **Closed:** "That session is closed for RSVPs."

A generic "something went wrong" here turns a self-serve fix into an exec DM.

### 3. The routes cannot call the server actions — this is the big one

The session actions are Next server actions. They resolve identity through
`requirePlayer()` → `getCurrentPlayer()` → `createServerSupabaseClient()`, which reads
`cookies()` from `next/headers`. **A `/api/discord/*` route acting on behalf of a player
has no cookie.** And `session_rsvp`'s RLS is `TO authenticated` keyed on the caller's
identity, so a service-role client would bypass the very boundary that enforces the
rules.

This refactor is the largest single piece of work in the project and it is invisible in
the spec. It is why writes are phase 3, not phase 1.

**Approach: keep RLS as the boundary; change only how identity is supplied.**

1. Split identity from the gate. `requirePlayer()` currently does both: it fetches the
   player *and* runs the four ordered checks (`pending_approval` → `suspended` →
   `is_banned` → `active_flag`, with `reactivateLapsedMember()`). Extract the gate as
   `assertPlayerUsable(player)` so it is reusable verbatim. **Do not reimplement those
   checks or their order** — the ordering is load-bearing and the reactivation is a side
   effect.
2. Give the impl functions an explicit `(supabase, player)` rather than having them
   reach for ambient request state.
3. The route resolves `discord_user_id` → link → `user_id`, obtains a **user-scoped**
   Supabase client for that user, and calls the impl. RLS applies unchanged.
4. `revalidatePath('/sessions')` is a no-op outside a Next render — drop it from the
   shared impl rather than letting it throw or mislead.

Rejected: service-role plus reimplemented checks. It duplicates the rules in a second
place and removes the database backstop.

---

## Phases

### Phase 0 — Decide, then migrate

- Owner decisions in "What needs to be done" below.
- Migration: the link. `player_discord_links` (`user_id` UNIQUE, `discord_user_id`
  UNIQUE, `linked_at`) is preferable to a column on `players` — links are their own
  lifecycle, and `players` is already privileged-column heavy.
- **Add the new column(s) to `guard_player_privileged_columns` in the same migration** if
  the column shape is chosen instead. What blocks self-promotion here is a BEFORE
  trigger with an explicit column list, not RLS; a column missing from that list is
  unguarded.
- Link tokens: single-use, 5–10 min TTL. Store hashed, not raw.
- End the migration with `NOTIFY pgrst` — PostgREST's schema cache will otherwise serve
  the old shape, and failed reads come back as **empty lists, not errors**.

### Phase 1 — Read-only bot — **BUILT** (branch `feat/discord-bot-phase1`)

No link, no writes, no `requirePlayer` refactor. This is deliberately the whole
end-to-end path with nothing that can corrupt state.

- Bot service: Ed25519 signature verification, `/health`, command registration.
- `GET /api/discord/leaderboard?ladder=&page=` — paginate **server-side**;
  `get_leaderboard()` takes no arguments and returns every player. Honour
  `hide_from_leaderboard`. Mark `*_provisional`.
- `GET /api/discord/sessions` and `.../sessions/{id}`.
- Service auth: bot holds a credential; `Authorization: Bearer` compared with a
  **timing-safe** equality, mirroring the existing `CRON_SECRET` pattern in
  `apps/admin/src/app/api/cron/*`. Note those routes use a plain `!==`; the new ones
  should not.

Ship here. Everything after this is additive.

**Status: code complete and locally verified.** `apps/bot` is a zero-dependency
workspace (`node:http` + `node:crypto`); `/health` returns 200, a signed PING is
answered with PONG, and a bad signature is answered 401 — the last is what Discord
probes during endpoint setup and decides whether the endpoint is accepted at all.
Full suite green. `/leaderboard` and `/sessions` are implemented; the `Dockerfile`
gained a `runner-bot` stage, CI a `bot` matrix leg, and compose a `bot` service.

Not yet verified against a running app — the routes need `DISCORD_SERVICE_SECRET`
in the player's environment, which does not exist on any host yet.

#### Deployment notes (confirmed with the proxy-manager session)

- **Hostname: `discord.sfubadminton.com`.** The zone's Let's Encrypt cert is a
  wildcard, so a single-level subdomain needs no new cert work. A **DNS record
  probably still has to be created** — wildcard cert coverage is not a wildcard
  DNS record.
- **Scaling is per-host.** `proxy.service` groups replicas discovered by one
  proxy's local Docker daemon; replicas cannot span the Pi and the mini as one
  pool. "Scalable" here means several replicas on whichever host it lands on.
- **Build it into the Mac mini stack, not the Pi.** sfu-badminton is already
  slated to live on the mini. Also: `compose pull` updates the *image*, never the
  compose *file* — a new service block, env var, or label has to be hand-patched
  into the live compose file on the host or it silently no-ops. That gap kept an
  unrelated feature dead for ten days recently.
- Secrets use the `ref:NAME` + `SECRETS_DIR` per-service mechanism, keyed by the
  `proxy.service` label. Three are needed: `discord_public_key`,
  `discord_bot_token`, `discord_service_secret`.

#### BLOCKER — the edge auth gate

The Pi's proxy logs `auth gate enabled for domain(s) polardev.org,sfubadminton.com`.
**Discord POSTs interactions with no session and no cookie.** If that gate applies
domain-wide, it will intercept them before they reach the handler, Discord will see
an auth redirect instead of a signed response, and it will disable the endpoint.

This has to be answered before DNS goes live: **how does a new `sfubadminton.com`
host get excluded from the auth gate?** Not a code change — it is a proxy
configuration question, and it is the one thing that can make a correct bot look
completely broken.

### Phase 2 — Linking and role sync — **PARTLY BUILT**

**Built and verified:** the role mapping (`apps/bot/src/roles.ts`), the sync engine
(`discord-api.ts`, `sync.ts`, `reconcile.ts`), the app's `/api/discord/members`
endpoint, and migration `00165_discord_links.sql` — which was applied twice to a real
Postgres, with `relacl` confirming only `postgres` and `service_role` hold grants and
all four verbs denied to `authenticated`, the unqualified UPDATE included.

**Not built:** the `/link` and `/unlink` commands themselves, and the app-side page
the link button points at. Both need the migration applied before any of it can be
exercised, and the page is a design surface worth looking at before it is written.

Three things decided while building, all worth a second opinion:

- **A banned member keeps only `@Linked`.** A ban is the club withdrawing access;
  leaving them holding `@Internal` keeps the member-only channels open to exactly the
  person who was just removed from them.
- **A `pending_approval` member gets no membership or team role**, for the same reason
  they stay off the ladder.
- **The sweep is driven over HTTP (`POST /sync`), never by a timer.** The compose
  service omits `proxy.unscalable` so it can scale, and a `setInterval` would become
  one sweep per replica, all writing the same roles.

And two gaps the schema work turned up, both the same shape — *an account stops being
somebody's and keeps its roles*:

- **Re-linking is sometimes a move**, and the account moved away from keeps every role
  it holds. `consume_discord_link_token` returns the displaced account as well as the
  linked one so the caller can strip it immediately.
- **A deleted link is worse**, because there is nothing left to return. The sweep
  iterates `player_discord_links`; when `merge_players` deletes the losing player the
  cascade takes the link with it, so that Discord account is in no list and nothing
  ever visits it again. `discord_role_revocations` is a tombstone written by a row
  trigger that captures the outgoing id *before* it is lost, and the sweep treats each
  tombstone as "no player, strip everything". The bot deletes a tombstone only once it
  has really cleared the account, so a 403 leaves it queued rather than discarded.

**The sweep is inert until something drives it.** `POST /sync` exists and is tested,
but there is no pg_cron job and no admin `/api/cron` leg calling it, so reconciliation
currently never runs on its own. The obvious driver — pg_net calling
`discord.sfubadminton.com/sync` — goes through Cloudflare and therefore hits **the same
edge auth gate that blocks Discord's interaction POSTs**, so the gate exclusion below
has to be settled before the driver is worth writing. Do not read "the sync engine is
built" as "roles reconcile themselves".

One thing to measure on the first real sweep: it runs entirely inside one HTTP request,
roughly three Discord calls per member, sequential. The tests use an instant mocked
fetch, so nothing has exercised its duration. Check it fits inside the proxy's upstream
timeout before relying on the 200.


- `/link` → ephemeral button → app page → existing login → token exchange → link row.
- `/unlink`, which **must** also strip the Discord roles.
- Role sync + a reconciliation sweep, **per guild** (spec §5). Commands register
  globally; role IDs are per-guild config.
- Create `@Linked` and `@Session Staff`; do not create `@Member`.
- Expect `Admin` and `VP` not to sync — see the owner decisions.

### Phase 3 — Writes

Gated on the refactor in §3 above.

- `requirePlayer` split + `(supabase, player)` threading.
- `/register`, `/withdraw`, `/my-sessions`.
- Waiver and closed-session copy.

### Phase 4 — `/profile` card

Last, because it is the only CPU-bound piece and the only one with a hard render budget.

- Defer the interaction immediately; Discord's 3s deadline cannot survive
  fetch + render + upload.
- Fonts baked into the image. Avatar fetch gets a timeout and an initials fallback.
- Cache by `(player_id, stats_updated_at)`.
- Respect `profile_visibility` and `hide_from_leaderboard`.

### Phase 5 — Ship the container

Mechanical. `Dockerfile` already has `runner-player` and `runner-admin`; add
`runner-bot`. `build-images.yml` already matrixes `app: [player, admin]`; add a leg.
Compose service joins `edge` with `proxy.enable/host/port/service` **and `proxy.health`**,
and deliberately **omits `proxy.unscalable`**.

Count replicas after every deploy — a compose recreate silently drops a scaled service
back to one and the site stays `200` throughout.

---

## What needs to be done

### Your decisions — these block work

1. **Waitlist promotion notifications** — when a spot frees up, is the first
   waitlisted player told? Real feature, not in this plan unless you want it.
2. **Bot role position in Discord.** The bot's role must sit **above** every role it
   syncs or the calls 403. (`Admin` is excluded — settled.)
*(That is the whole list.)*

**Settled since the first draft:** `/waitlist` is removed — the RSVP list is the
waitlist. `sessions.capacity` is being added, nullable. `Admin` is not synced.
`MEMBER` is `membership_type IN ('internal','alumni')`; `external` is another club or
university and is not a member. `pending_approval` players are **excluded from the
leaderboard**. The bot is **multi-guild**.

### Your work

- Regenerate `database.gen.ts`. It is stale, and the staleness was actively
  misleading: `players.portfolio` is absent from it not because the file is behind
  but because **the column was dropped in `00087`**, one migration after it was
  added. The spec's `VP = portfolio IS NOT NULL` rule was written against a column
  that has not existed for 77 migrations; it now reads `permission_role`, and
  `custom` is deliberately not a VP job.
- Run the phase-0 migration when it exists (all DB writes are yours).
- Create the Discord application, and land its token as a service secret file.

### My work, in order

1. Phase 0 migration + link-token design, handed over as SQL.
2. Phase 1: bot service + three read-only routes + service auth. **Shippable.**
3. Phase 2: link flow, `/unlink`, role sync, reconciliation.
4. Phase 3: the `requirePlayer` split, then the write commands.
5. Phase 4: `/profile` card.
6. Phase 5: `runner-bot` target, CI matrix leg, compose service.

Phase 1 is the honest first milestone: a working bot in the server, reading real club
data, with no path to changing anything.
