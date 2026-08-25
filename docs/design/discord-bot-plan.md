# Discord Bot — Implementation Plan

Companion to [`discord-bot.md`](./discord-bot.md), which is the *what*. This is the
*how*, in the order it can actually be built.

The spec was written against an idealised app. Investigating the real one moved three
things, and the phasing below exists because of them.

---

## What the investigation changed

### 1. There is no waitlist, and RSVP is uncapped

The spec assumed `/register`, `/withdraw`, `/waitlist` and justified the whole API
pattern on *"avoids the bot accidentally having different registration rules, capacity
logic, fee checks, waitlist logic."* The app does not have that logic to inherit.

What exists is **`session_rsvp`**, written by `setSessionIntent(sessionId, intent)`
where `intent ∈ {'going', 'declined', null}` — an upsert, not a queue.

- **No waitlist table, column, or function.** Nothing queues anyone.
- **No RSVP capacity enforcement.** `session_rsvp`'s four RLS policies are plain
  per-user checks with no cap trigger, and `setSessionIntentImpl` doesn't consult a cap
  before upserting.
- `check_session_caps` / `session_cap_for` sound relevant and **are not** — they cap how
  many *rated matches* a player may play in a session, per `platform_settings`.
  Unrelated to attendance.

So the command mapping is:

| Spec command | Reality |
|---|---|
| `/register <session>` | `setSessionIntent(id, 'going')` — a rename |
| `/withdraw <session>` | `setSessionIntent(id, 'declined')` — see the choice below |
| `/waitlist <session>` | **No referent. Blocked on an app-side feature.** |

**`/waitlist` is not a bot task.** Building it in the bot would mean inventing club
capacity policy inside a Discord client, which is exactly what the core rule forbids.
It leaves v1. It returns when the app has a waitlist.

**`'declined'` and `null` are different states** and `/withdraw` must pick one.
`declined` is a recorded "no"; `null` is "no answer given". They feed attendance signal
differently. **Decision: `/withdraw` → `'declined'`.** Clearing an RSVP to `null` is a
separate, rarer intent and is omitted from v1 rather than conflated.

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

### Phase 1 — Read-only bot, shippable alone

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

### Phase 2 — Linking and role sync

- `/link` → ephemeral button → app page → existing login → token exchange → link row.
- `/unlink`, which **must** also strip the Discord roles.
- Role sync + a reconciliation sweep. Sync to the roles that exist (spec §5).
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

1. **Waitlist.** `/waitlist` has no app feature behind it. Drop it from v1, or scope a
   real waitlist (queue, cap, promotion rules) as separate app work? *Blocks the final
   v1 command list.*
2. **RSVP capacity.** Related and larger: RSVP currently has no cap enforcement at all.
   Is that intentional? *Not a bot question, but the bot will make it visible.*
3. **Bot role position in Discord.** The bot's role must sit **above** all eight roles
   or sync 403s. And `Admin` carries a lock icon — if it is integration-managed, no bot
   can assign it. Confirm, and if so we document `Admin` as manually maintained rather
   than shipping sync that can only fail.
4. **Does `membership_type = 'alumni'` get member-level access?** Affects channel
   visibility and the `/register` gate.
5. **Do `pending_approval` players appear on the public leaderboard?**
6. **Which Discord server, and is the bot single-guild?**

### Your work

- Regenerate `database.gen.ts` — `players.portfolio` shipped in `00086` and is missing
  from it.
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
