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
