# Discord Bot — Command & Permission Spec

Status: **specified, not built.** No Discord code exists in this repo yet.
This document is the v1 target, not a description of something running.

## Core rule

> Discord authenticates the person through the link. The app controls everything else.

Everything below is a consequence of that sentence. The bot never decides who may
do what. It resolves a Discord user to an app account, asks the app, and renders
the answer.

---

## 1. Commands

### Member commands (v1)

| Command | What it does | Requires `/link` |
|---|---|---|
| `/link` | Start linking a Discord account to a badminton account | — |
| `/unlink` | Detach the Discord account | Yes |
| `/profile` | Your name, handle, membership, Elo, record | Yes |
| `/sessions` | Upcoming sessions with capacity and your status | No |
| `/session <date>` | Detail for one session: time, location, going count, your RSVP | No |
| `/register <session>` | RSVP `going` to a session | Yes |
| `/withdraw <session>` | RSVP `declined` | Yes |
| `/my-sessions` | Your upcoming registrations | Yes |
| `/matches` | Your recent matches and results | Yes |
| `/stats` | Your singles and doubles record, streaks, points | Yes |
| `/leaderboard` | Club ladder (see §2) | No |
| `/feedback` | Submit feedback to the exec team | No |

**There is no separate waitlist command, because the RSVP list *is* the waitlist.**
Sessions carry no capacity column; RSVP is uncapped by design and court space is
settled in the room. `session_rsvp.created_at` is therefore the only ordering that
exists, and it is the fair one. `/sessions` and `/session` should show the going count
(`get_session_attendee_counts`) and, for a linked member, when they RSVP'd — that is
the "where am I in line" answer, and it needs no new feature.

### Later

`/player @user` · `/headtohead @user` · `/rank` · `/tournaments` ·
`/tournament <name>` · `/register-tournament`

---

## 2. Leaderboard commands

The club does not have *a* leaderboard — it has **two independent Elo ladders plus a
tournament points column**, and `get_leaderboard()` returns all of them in one row per
player:

```
singles_elo   singles_wins   singles_losses   singles_provisional   current_singles_streak
doubles_elo   doubles_wins   doubles_losses   doubles_provisional   current_doubles_streak
tournament_points        status        handle        name        avatar_url
```

That shape dictates the command surface:

| Command | Behaviour |
|---|---|
| `/leaderboard [singles\|doubles\|points] [page]` | Ranked page of ~10. **Defaults to `doubles`** — that is the ladder most club play feeds. |
| `/rank` *(later)* | Your position on both ladders plus neighbours above and below |
| `/headtohead @user` *(later)* | Reads `head_to_head_stats`, which is keyed `(player_a_id, player_b_id, match_type)` — so it answers **per ladder**, not overall |

Four rules the renderer must obey, because getting them wrong produces confidently
wrong numbers in a public channel:

1. **Always mark provisional players.** `singles_provisional` / `doubles_provisional`
   mean the rating has not settled. A number shown without that marker reads as
   settled and it is not. Suffix them (`1204*`) with a legend line.
2. **Never mix ladders in one table.** Singles Elo and doubles Elo are not comparable
   and a combined "overall" ranking would be invented, not derived.
3. **Paginate; do not proxy the raw call.** `get_leaderboard()` takes no arguments and
   returns *every* player. The bot must slice server-side, in the app API — not fetch
   the whole club and slice in the bot.
4. **`status` is a label, not a filter, unless the club says otherwise.**
   `recreational` / `competitive` / `pending_approval` all appear in the result set.
   Whether `pending_approval` players show on a public ladder is a club decision — see §9.

Leaderboard commands are read-only and need no link, so they are the natural first
thing to build and the natural load test.

---

## 3. Permission model

**App permissions are the authorization system. Discord roles are a mirror, never an input.**

```
Don't:  if (user.hasDiscordRole("Exec")) allow()
Do:     Discord ID -> linked app account -> app permission check -> allow / deny
```

### The tiers are labels for capability queries

This is the part most likely to be implemented wrong. The app does **not** have six
roles. `user_role` has exactly two values, `player` and `admin`. Everything between
them is a boolean column or a capability lookup. Do not add an enum value for these
tiers, and do not add a `hasRole('SESSION_STAFF')` helper — that is precisely the
failure mode the core rule forbids.

| Tier | How it is *actually* determined |
|---|---|
| `UNLINKED` | No link row for this `discord_user_id` |
| `LINKED_USER` | Link row exists and resolves to a `players` row |
| `MEMBER` | `membership_type IN ('internal', 'alumni')` — **not** `external` |
| `SESSION_STAFF` | Holds `sessions.attendance.write` **and** `sessions.checkin.token.write` |
| `EXEC` | `players.is_exec` |
| `ADMIN` | `players.role = 'admin'` |

`MEMBER` is settled: **alumni get member access, same as internal.** `external` means
a player from another club or university and is *not* a member. So the tier is
`membership_type IN ('internal', 'alumni')`.

One thing not to conflate: that predicate decides the **Discord tier and channel
visibility**. It is *not* the RSVP gate. The app's gate
(`apps/player/src/lib/actions/_shared.ts`) tests `status`, `is_banned` and
`active_flag` and **does not test `membership_type` at all** — so an active external
player can RSVP today. The bot mirrors that behaviour; it must not start refusing
externals just because they lack `@Member`.

`SESSION_STAFF` is not stored anywhere. It is derived from the capability system
introduced across migrations `00086`–`00105`: `permission_role`,
`permission_baseline_id`, `permission_grants[]`, `permission_revokes[]`. A player can
hold those two keys via a baseline, an exec portfolio, or a direct grant, and all three
routes must resolve identically. Resolve capabilities through the app's existing
resolver — never by reading the columns and reimplementing precedence.

Also worth stating plainly: `is_exec` is enforced almost entirely in the app layer.
Only one RLS policy references it. So an authorization mistake in this bot is not
caught by the database.

### Mirrored Discord roles

`@Linked` · `@Member` · `@Session Staff` · `@Exec` · `@Admin`

These exist for channel visibility and for humans to see at a glance. They are output.
Nothing reads them to make a decision.

---

## 4. The `/link` flow

```
/link  ->  ephemeral reply with a "Connect Account" button
       ->  app website
       ->  user logs in with their existing account
       ->  one-time token validated
       ->  discord_user_id attached to the app account
       ->  Discord roles synchronized
```

Login happens on the app, with the auth the club already uses. The bot never sees a
password and never becomes an identity provider.

### Constraints

- `discord_user_id` **UNIQUE**
- `user_id` **UNIQUE**
- `link_token` expires in **5–10 minutes**
- `link_token` is **single-use**

Together: **one Discord account ↔ one badminton account.** No sharing, no proxy
registration through a second Discord identity.

Two implementation notes specific to this codebase:

- Adding `discord_user_id` to `players` (or a `player_discord_links` table) touches the
  privilege-escalation guard. What blocks self-promotion here is a **BEFORE trigger**,
  not RLS, and its column list is explicit — a new column that is not in that list is
  not protected. Whichever shape is chosen, the guard has to be updated in the same
  migration.
- `/unlink` must clear the Discord roles as part of unlinking. An unlinked user holding
  `@Exec` is a stale grant of channel access.

---

## 5. Role sync

### The roles that already exist

The server is already set up, and its roles map onto app columns almost exactly.
Sync to **these**, don't invent a parallel set:

| Discord role | App source | Note |
|---|---|---|
| `Admin` 🔒 | *(not synced — see below)* | Managed manually in Discord |
| `VP` | `is_exec` **and** `permission_role` is one of the four named jobs | `finance` / `tournaments` / `internal` / `external` — **not** `custom` |
| `Executives` | `players.is_exec` | VP is a subset of this |
| `Competitive Team` | `players.status = 'competitive'` | |
| `Recreation Team` | `players.status = 'recreational'` | |
| `Internal` | `players.membership_type = 'internal'` | |
| `Alumni` | `players.membership_type = 'alumni'` | Member access, same as internal |
| `External` | `players.membership_type = 'external'` | Another club / university — not a member |

Two roles in this spec do **not** exist yet and need creating: **`@Linked`** and
**`@Session Staff`**.

**`@Member` should not be created.** The original spec called for one, but
`Internal` / `Alumni` / `External` already partition membership exactly — they *are*
the `membership_type` enum. A separate `@Member` would be a fourth, redundant, and
immediately-drifting source of truth. Member-only channel visibility is `Internal` **+** `Alumni`, and excludes `External`.
This retires the `MEMBER` question entirely.

### `portfolio` does not exist — corrected

An earlier draft of this table mapped `VP` to `players.portfolio IS NOT NULL`. **That
column does not exist.** 00086 added it and 00087 dropped it again in the same sitting,
77 migrations ago; its heir is `permission_role`, a closed set of
`finance` / `tournaments` / `internal` / `external` / `custom`.

`custom` does **not** earn the VP role. access-level.ts says why in as many words —
"`custom` IS NOT A FIFTH VP JOB. It is the empty base" — it is the storage shape for a
hand-picked capability set, not an office. A varsity trainer with one session capability
is stored as `custom` and is not a VP.

### Name collision — read this before adding per-job roles

`permission_role` and `membership_type` **both** have values called `internal` and
`external`, and they mean completely unrelated things. The existing `Internal` and
`External` Discord roles are `membership_type`. If per-job roles are ever added, they
must be named `VP Internal` / `VP External` or similar. Reusing the bare names would
silently merge a VP with every ordinary internal member.

### Multi-guild

The bot serves **more than one guild**, which changes the sync design in three ways:

- **The link is global, the roles are not.** `discord_user_id` identifies a person
  across all of Discord, so one link covers every guild. Role *IDs* are per-guild, so
  the bot needs a guild registry mapping each guild to its own role IDs. Config, not
  schema — but it must not be hardcoded.
- **Sync fans out.** A permission change syncs into every registered guild where that
  member is present. A guild missing a given role is a skip, not an error.
- **Register commands globally**, not per-guild. Guild commands would need
  re-registering on every join.

A guild that has not been registered is inert: the bot ignores it rather than
half-syncing. Joining a new server is a deliberate config change.

### Discord's own constraints on this

- **The bot can only manage roles strictly below its own highest role.** Its role must
  be positioned above all eight, i.e. above `Admin` and `VP`. This is a Discord server
  setting, not code, and it fails silently-ish (a 403 per call) if wrong.
- **`Admin` is out of scope for sync — decided, not pending.** It is managed manually in
  Discord and the bot neither reads nor writes it. It also carries a lock icon, so a bot
  could not assign it regardless. `players.role = 'admin'` still grants everything on
  the app side; it simply has no Discord mirror.
- A bot also cannot modify roles for a member whose own top role outranks the bot's.
  Execs and admins are exactly those members. Expect the top of the hierarchy to be the
  part that doesn't sync.

### Rules

**Remove the role when the underlying app permission disappears.** Don't manually
maintain these roles.

Sync is **one-directional: app → Discord.** There is no path where editing a Discord
role writes back to `players`. If there were, Discord server admins would become app
admins, and Discord role management is not audited the way the app's permission changes
are. `permission_role` in particular is a privileged column, guarded by
`guard_player_privileged_columns` and writable only through the audited, admin-only
permissions editor; a Discord round-trip would be a way around that.

Triggers: on link, on permission change in the app, and on a periodic reconciliation
sweep to repair drift (a role removed by hand in Discord, a member who lapsed while the
bot was down). Reconciliation is the authority; event-driven sync is the fast path.

---

## 6. `/profile` renders an image card

`/profile` returns a **generated PNG**, not an embed — one card carrying identity,
rank, and the stat grid.

### Visual language

It reads as part of the badminton site, not as a game card. The app's tokens define
that, and they are unusually specific:

| Token | Value | Consequence for the card |
|---|---|---|
| `--red` | `#c00` | The single accent. SFU red, used sparingly |
| `--bg` | `#fafafa` | Near-white ground, not a saturated panel |
| `--ink` | `#111` | Text |
| `--line` | `rgba(0,0,0,0.08)` | Hairline rules separate the stat grid — no boxes |
| `--gold` `--silver` `--bronze` | `#ca8a04` `#9FA0A3` `#A6683A` | Podium positions only |
| `--win` / `--loss` | `#16a34a` / `#c00` | Streak and record colouring |
| `--shadow-sm/md/lg` | **`none`** | The design is flat. No drop shadows on the card |

**Square corners are deliberate** in this app — do not round the card, the avatar, or
the stat cells. Pull the live values rather than trusting this table if the site has
moved on.

### Content, mapped to real columns

- **Identity:** `display_name` (fall back to `full_name`), `handle`, `avatar_url`,
  `member_code`
- **Badge line:** `exec_title` if set, else `portfolio`, else `status`, else
  `skill_tier`
- **The grid — two ladders side by side**, because that is the shape of the data:

  | | Singles | Doubles |
  |---|---|---|
  | Elo | `singles_elo` | `doubles_elo` |
  | Record | `singles_wins`–`singles_losses` | `doubles_wins`–`doubles_losses` |
  | Streak | `current_singles_streak` | `current_doubles_streak` |

  plus `tournament_points` and club-level counters (sessions attended, matches played).
- **Provisional ratings must be marked on the card too** (§2 rule 1). An unmarked
  number on a shareable image outlives the message it was posted in.

### Privacy is not optional here

`players` has **`profile_visibility`** and **`hide_from_leaderboard`**, and both are
load-bearing for a bot that renders cards into public channels:

- `hide_from_leaderboard` must exclude the player from `/leaderboard` output **and**
  from rank numbers on anyone else's card.
- `profile_visibility` gates `/player @user` (§1, later). Rendering a card for
  another member is a *read of their profile* and must run the same visibility check
  the website runs.
- Do not put `email`, `phone`, or `bio` on the card.

### Rendering constraints

- **Defer the interaction immediately.** Discord's 3-second deadline cannot survive a
  fetch + render + upload. Acknowledge with a deferred response, then follow up with
  the attachment; that buys 15 minutes.
- **This is the CPU-bound part of the system.** Everything else is I/O. Rasterising
  cards is the one workload that will actually contend for cores, which is a concrete
  reason the bot is its own container (§8) and the concrete reason replicas may be
  needed.
- **Bake the fonts into the image.** The container ships the font files; no system
  font fallback, or cards render differently between hosts.
- `avatar_url` is an external fetch. Give it a short timeout and a generated
  initials-block fallback. A card must never fail because a CDN was slow.
- **Cache by `(player_id, stats_updated_at)`.** Cards are re-requested far more often
  than stats change.

---

## 7. API pattern

```
Discord Bot  ->  Badminton App API  ->  Authorization layer  ->  Services  ->  Database
```

| Endpoint | Purpose |
|---|---|
| `GET /api/discord/users/{discordId}` | Resolve link + permission tier |
| `GET /api/discord/sessions` | Upcoming sessions |
| `POST /api/discord/sessions/{id}/register` | Register |
| `DELETE /api/discord/sessions/{id}/registration` | Withdraw |
| `GET /api/discord/users/{discordId}/stats` | Player stats |
| `GET /api/discord/leaderboard?ladder=&page=` | Paged ladder |

The bot calls the same services the web app calls. It does not talk to the database and
it does not reimplement rules. This is the whole point: it avoids the bot accidentally
having different registration rules, fee checks, or waiver checks. (Capacity and
waitlist are not among them — see §1: RSVP is uncapped and the RSVP list *is* the
waitlist.)

### These routes are unauthenticated by shape — fix that explicitly

`GET /api/discord/users/{discordId}` takes the caller's claimed identity as a path
parameter. On its own that means anyone who can reach the route can read any linked
member's stats, and `POST .../register` becomes a way to sign other people up.

The core rule — "Discord authenticates the person through the link" — is about the
**link**, not about this API. So:

- The bot authenticates to the app as a **service**, with a credential only the bot
  holds. `discordId` is then *data the service is asserting*, not a claim that
  authenticates itself.
- The authorization layer still resolves that `discordId` to an app account and runs the
  normal permission check. Service auth gets you in the door; it does not grant
  anything.
- Rate limit these routes. Note that the current limiter
  (`packages/shared/src/utils/rate-limit.ts`) is an **in-process `Map`** — per replica,
  by accepted decision. Budget for that rather than reviving a shared store.
- Never accept a `discordId` from anywhere but the interaction Discord itself signed.

---

## 8. Deployment: one container, scalable

The bot runs as **its own compose service** — separate image, separate lifecycle,
separate crash domain from the player and admin apps. Built by CI and pulled, like
everything else; never built on the host.

### Build it stateless so it *can* scale

There are two ways to receive a Discord command, and the choice decides whether scaling
is possible at all:

| | Gateway bot (WebSocket) | **HTTP interactions endpoint** |
|---|---|---|
| Transport | Outbound persistent connection | Discord POSTs signed requests to a URL |
| Inbound route needed | No | Yes |
| Scaling | Only by **sharding** — replicas must divide shards, or every replica handles every command twice | Stateless; scales like any web service |
| Fits this stack | Poorly | Cleanly |

**Use the HTTP interactions endpoint.** Slash commands are all v1 needs, role sync is
outbound REST from the app, and nothing in this spec requires a live gateway
connection. That makes the bot an ordinary stateless HTTP service, which is exactly the
thing that scales here.

So it *does* take the standard proxy labels and *does* join `edge`:

```yaml
networks: [edge, default]
labels:
  proxy.enable:  "true"
  proxy.host:    "<host>"
  proxy.port:    "<port>"
  proxy.service: "discord-bot"
  proxy.health:  "/health"
```

Note the differences from the other services:

- **No `proxy.unscalable`.** Omitting it is what keeps replicas an option.
- **Verify replica count after every deploy.** A compose recreate silently drops a
  scaled service back to one replica, and the site stays `200` throughout — the drop is
  invisible unless you count containers.
- Discord requires the interactions endpoint to **verify the Ed25519 signature** on
  every request and respond within **3 seconds**. Anything slower must acknowledge
  first and follow up, which is a hard constraint on registration calls that touch
  the waiver and session-status gates.
- Set `proxy.health` from the start. Without it the proxy does a bare TCP dial, which
  cannot tell "process is up" from "process cannot reach the app API".

If a gateway connection is ever genuinely needed (presence, message events, reactions),
it belongs in a **second, singleton service** — not by adding a gateway to this one.
Keep the scalable thing scalable.

---

## 9. Open decisions

1. Link table vs. column on `players` — either way the escalation guard changes.
2. Waitlist promotion notifications — when a spot frees up, is the first waitlisted
   player told? (See the plan; a real feature, deliberately out of v1.)

**Settled:** `MEMBER` is `membership_type IN ('internal','alumni')` (§3, §5).
`Admin` is not synced (§5). There is no waitlist command — RSVP is the waitlist (§1),
and `sessions.capacity` is nullable so the cap never refuses an RSVP. Players with
`status = 'pending_approval'` are **excluded from the leaderboard**. The bot is
**multi-guild**.

---

## 10. What to build first

Read-only, no link required, no writes: `/leaderboard`, `/sessions`, `/session <date>`.
They exercise the whole path — Discord signature verification, service auth to the app
API, the authorization layer, pagination — without any way to corrupt state. Add
`/link`, then the write commands, once that path is proven.
