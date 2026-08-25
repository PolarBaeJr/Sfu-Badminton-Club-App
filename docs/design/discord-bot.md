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
| `/session <date>` | Detail for one session: time, courts, capacity, waitlist depth | No |
| `/register <session>` | Register for a session | Yes |
| `/withdraw <session>` | Withdraw from a session | Yes |
| `/waitlist <session>` | Join the waitlist | Yes |
| `/my-sessions` | Your upcoming registrations | Yes |
| `/matches` | Your recent matches and results | Yes |
| `/stats` | Your singles and doubles record, streaks, points | Yes |
| `/leaderboard` | Club ladder (see §2) | No |
| `/feedback` | Submit feedback to the exec team | No |

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
   Whether `pending_approval` players show on a public ladder is a club decision — see §8.

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
| `MEMBER` | **Open decision — see §8.** Do not guess a predicate. |
| `SESSION_STAFF` | Holds `sessions.attendance.write` **and** `sessions.checkin.token.write` |
| `EXEC` | `players.is_exec` |
| `ADMIN` | `players.role = 'admin'` |

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

| App state | Discord role |
|---|---|
| Active club member | `@Member` |
| Exec permission | `@Exec` |
| Session staff capability | `@Session Staff` |
| Account linked | `@Linked` |

**Remove the role when the underlying app permission disappears.** Don't manually
maintain these roles.

Sync is **one-directional: app → Discord.** There is no path where editing a Discord
role writes back to `players`. If there were, Discord server admins would become app
admins, and Discord role management is not audited the way the app's permission changes
are.

Triggers: on link, on permission change in the app, and on a periodic reconciliation
sweep to repair drift (a role removed by hand in Discord, a member who lapsed while the
bot was down). Reconciliation is the authority; event-driven sync is the fast path.

---

## 6. API pattern

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
having different registration rules, capacity logic, fee checks, or waitlist logic.

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

## 7. Deployment: one container, scalable

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
  capacity and waitlist logic.
- Set `proxy.health` from the start. Without it the proxy does a bare TCP dial, which
  cannot tell "process is up" from "process cannot reach the app API".

If a gateway connection is ever genuinely needed (presence, message events, reactions),
it belongs in a **second, singleton service** — not by adding a gateway to this one.
Keep the scalable thing scalable.

---

## 8. Open decisions

1. **What is a `MEMBER`?** This is the one tier that cannot be written down yet, and
   guessing it silently gates the wrong people out of member-only sessions. The
   candidate columns on `players` are `active_flag`, `eligibility_flag`, `status`
   (`recreational` / `competitive` / `pending_approval` / `suspended`),
   `membership_type` (`internal` / `alumni` / `external`), and `inactive_since`.

   The app already has a working gate and v1 should adopt **it** rather than invent a
   predicate: `apps/player/src/lib/actions/_shared.ts` runs four checks *in order* —
   `status === 'pending_approval'`, then `status === 'suspended'`, then `is_banned`
   (an independent column, not folded into `status`), then `active_flag === false`,
   which additionally attempts `reactivateLapsedMember()` before refusing. The order is
   load-bearing and the reactivation side effect means this is a call, not a boolean
   expression to copy.

   The genuinely open question is club policy, not code: does
   `membership_type = 'alumni'` get `@Member`? Note that gate does not test
   `membership_type` at all.
2. Do `pending_approval` players appear on the public leaderboard?
3. Link table vs. column on `players` — either way the escalation guard changes.
4. Which Discord server(s), and whether the bot is single-guild or multi-guild.

---

## 9. What to build first

Read-only, no link required, no writes: `/leaderboard`, `/sessions`, `/session <date>`.
They exercise the whole path — Discord signature verification, service auth to the app
API, the authorization layer, pagination — without any way to corrupt state. Add
`/link`, then the write commands, once that path is proven.
