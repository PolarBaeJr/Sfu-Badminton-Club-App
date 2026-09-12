# `bot` — the Discord bot

A small, dependency-free Node service that connects the club's Discord server to
the app: slash commands members can use without opening the site, role grants
that follow their account status, and announcements pushed out of the console.

It is **not** a Next.js app and has no UI. It is a plain `node:http` server plus
a WebSocket gateway connection, written against Discord's REST API directly —
`package.json` has no runtime dependencies at all, only TypeScript for the
build.

Bring-up and operational detail live in
[`docs/ops/discord-bot-bringup.md`](../../docs/ops/discord-bot-bringup.md);
the design is in [`docs/design/discord-bot.md`](../../docs/design/discord-bot.md).

---

## Run it

```sh
npm run build -w bot      # tsc → dist/
npm run start -w bot      # node dist/index.js, listens on $PORT (default 3002)
npm run test -w bot       # vitest, 37 suites
npm run register -w bot   # push the slash-command definitions to Discord
```

`npm run dev -w bot` is just build-then-start; there is no watch mode.

### Environment

Names only — values live in the deployment's secret store, never in the repo.

| Variable | For |
|----------|-----|
| `DISCORD_BOT_TOKEN` | REST + gateway auth |
| `DISCORD_APPLICATION_ID` | command registration |
| `DISCORD_PUBLIC_KEY` | verifying inbound interaction signatures |
| `DISCORD_GUILDS` | which guilds the bot manages |
| `DISCORD_AUDIT_CHANNEL_ID` | where audit entries are posted |
| `DISCORD_DEV_GUILD_ID` | *optional* — register commands to one guild instantly |
| `DISCORD_SERVICE_SECRET` | shared secret for the service endpoints below |
| `APP_API_URL` | where the bot calls the player app's `/api/discord/*` |
| `APP_PUBLIC_URL` | origin used in links the bot posts |
| `STORAGE_IMAGE_HOST` | host allowed for image attachments |
| `PORT` | HTTP port (default 3002) |

> `APP_API_URL` must be the **public origin**. And the corresponding
> `DISCORD_BOT_URL` on the *player* app has to be set through the deployment
> dashboard — the `environment:` block in compose is decoration for the player
> and admin services, because those containers are onboarded by the proxy rather
> than started by compose. Unset, linking appears to work and grants no roles,
> and the only place that is visible is the **player** log.

## Layout

```
src/
  index.ts          HTTP server: the Discord interactions endpoint + service routes.
  verify.ts         Ed25519 signature check on inbound interactions.
  commands.ts       Slash-command definitions and dispatch.
  register.ts       One-shot script that PUTs those definitions to Discord.
  gateway.ts        WebSocket connection (presence, events).
  discord-api.ts    Thin REST client.
  roles.ts          Pure role-diff logic — no fetch, no token, no clock.
  setup.ts          Pure: decides what /setup adopts vs. creates.
  sync.ts           Applies a role diff to a guild; sweeps every guild.
  api.ts            Calls back into the player app's /api/discord/* surface.
  ...               announcements, session-pings, tournament-events,
                    match-results, feedback, handles, audit, config, multipart.
  __tests__/        Vitest. The pure modules above are why this is testable.
```

## Commands

`/leaderboard` `/profile` `/sessions` `/sessionpost` `/tournaments` `/bug`
`/feedback` `/announce` `/link` `/unlink` `/setup` `/config` `/rolepicker`

## Service endpoints

All except `/health` require `Authorization` matching `DISCORD_SERVICE_SECRET`.

| Route | Driven by |
|-------|-----------|
| `GET /health` | the proxy's health check |
| `POST /sync` | nightly `pg_cron` — full role reconciliation sweep |
| `POST /sync-member` | the app, immediately on link/unlink |
| `POST /session-pings` | `pg_cron`, alongside the app's reminder job |
| `POST /tournament-events` | `pg_cron`, every 15 minutes |
| `POST /announcements` | `pg_cron` |
| `POST /match-results` | `pg_cron` |
| `POST /feedback` | `pg_cron` |

**Nothing here is on a `setInterval`, deliberately.** The compose service omits
`proxy.unscalable`, so a timer inside the process would become one sweep *per
replica*, all writing the same roles. One HTTP request reaches exactly one
replica however many are running.

`/health` is a real GET rather than a bare TCP accept, because the proxy falls
back to a TCP dial when no `proxy.health` label is set — and a dial cannot tell
"process is up" from "process cannot reach the app API". It reports `ok: true`
even when the gateway is disconnected: interactions do not travel over the
gateway, so a blip there must not pull a healthy interactions endpoint out of
the pool. The gateway state is in the body instead.

## Things that will catch you

**Slash commands register globally and take up to an hour to appear.** That hour
is indistinguishable from a registration that failed, and it has cost this
project time twice. Set `DISCORD_DEV_GUILD_ID` and the same set registers to
that one guild *immediately* — a separate list from the global one, so a test
server shows both copies until the global set catches up.

**`autocomplete: true` is part of the stored definition.** Deploying the handler
alone changes nothing; Discord will not send an autocomplete interaction for an
option it hasn't been told is one. Re-run `register`.

**The interaction signature covers the raw body.** Parse-and-re-serialise
reorders keys and drops whitespace, which invalidates every signature — and the
failure looks exactly like a wrong public key.

**`/setup` matches existing roles by name, and skips anything at or above the
bot's own position.** A role the bot can't reach is reported as `above_bot`;
drag the bot higher in the role list and re-run — adoption is idempotent. Role
permission masks arrive as *decimal strings* because they're 64 bits wide:
parse with `BigInt`, never `Number`.

**`/setup` is gated by Discord's `MANAGE_GUILD`, not by the club's own
`EXEC_ONLY` gate** — deliberately, because it *is* the bootstrap: it is what
creates the `@Executives` role the `EXEC_ONLY` commands are later granted to, so
gating it on that role would leave a fresh server with no way in. Discord
enforces `default_member_permissions` server-side, so the command isn't even
visible to anyone else, and it independently refuses to let a bot create or
assign a role above its own position.

**Nothing in `sync.ts` throws on a predictable failure.** A 403 modifying a
member whose top role outranks the bot is normal, not an incident; a sweep that
aborted on the first one would leave everyone after them unrepaired. Failures
are counted and reported, and the sweep continues.

**Never let a multi-call `catch` assert a cause.** A wrong Discord API path once
produced a 400 that the handler blamed on a missing Manage Roles permission the
bot already had.

**`@me` is not valid on `/guilds/{id}/members/{user_id}`** — it returns a 400
`NUMBER_TYPE_COERCE`.

**Repair a member with `POST /sync`, not by re-linking.**
