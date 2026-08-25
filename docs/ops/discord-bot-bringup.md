# Discord bot: bringing it up

What a human has to do to get the bot running. Everything here is a step that
**cannot** be done from a code change — a Discord Developer Portal setting, a
credential, or a SQL statement that only the DB owner runs.

> ⚠️ **This repository is public.** `<placeholders>` stand for real values that
> live in the club password manager and [CREDENTIALS.md](CREDENTIALS.md).

Do staging first, all the way through. Prod is the same list with prod values.

---

## Mental model

The bot is **three** moving parts, and they authenticate to each other in two
different directions. Getting this backwards is the most common way to waste an
hour:

```
Discord  --(signed with DISCORD_PUBLIC_KEY)-->  bot  --(Bearer DISCORD_SERVICE_SECRET)-->  player app
```

- **Discord → bot**: Discord signs every interaction with your application's
  public key. The bot verifies it. This is why `DISCORD_PUBLIC_KEY` must match
  the application you set the interactions URL on.
- **Bot → app**: the bot calls `/api/discord/*` with a bearer token. That token
  is `DISCORD_SERVICE_SECRET`, and it must be **byte-identical in two places**
  (see step 4). This is the step people get wrong.

The bot holds no session cookie and never signs in as a user.

---

## 1. A second Discord application, for staging

Staging needs **its own** application. Not a second bot user on the same
application — a separate application, because the interactions URL is a
property of the application and staging and prod cannot share one.

In the Discord Developer Portal:

1. **New Application** → name it something obviously non-production.
2. **Bot** tab → **Reset Token**, copy it. This is `DISCORD_BOT_TOKEN`.
3. **General Information** → copy **Application ID** (`DISCORD_APPLICATION_ID`)
   and **Public Key** (`DISCORD_PUBLIC_KEY`).
4. Invite it to your test server with the `bot` and `applications.commands`
   scopes and the **Manage Roles** permission.

## 2. Roles in the test server

Create the roles the sweep manages. At minimum `@Linked` and `@Session Staff`;
add the membership and team roles you actually want synced.

**Then drag the bot's own role above every role it manages.** Discord refuses,
with a 403, any attempt to modify a member whose highest role sits above the
bot's. The bot treats that 403 as expected and colours it amber in the audit
log rather than red — so if you skip this step the sweep will look like it is
working while changing nothing.

## 3. Guilds and roles go in the database, not in env

The guild list, the role ids, and the audit channel are **runtime config**, read
from Postgres on every sweep with a 60-second cache. Adding a server is an
INSERT, not a redeploy.

Run `supabase/migrations/00167_discord_runtime_config.sql`, then insert your
rows. The exact INSERT statements are at the bottom of that migration file.

> An **empty** guild registry is not inert. The desired-role calculation runs
> per guild, so zero guilds means the sweep walks every member, decides nothing
> applies, and reports success. Confirm your rows are actually there.

Also run, in order, and **only** these:

| Migration | What it adds |
|---|---|
| `00165_discord_links.sql` | the link table and its tombstones |
| `00166_discord_nightly_sync.sql` | the pg_cron schedule, plus two `cron_config` rows |
| `00167_discord_runtime_config.sql` | guilds, roles, settings |

> **Pause the prod → staging snapshot job before running these on staging.**
> The snapshot does `DROP SCHEMA public CASCADE` at 04:00. All three tables live
> in `public` and will be erased. pg_cron's own schedule lives in the `cron`
> schema and survives — so a wiped staging would keep running the sweep against
> whatever `discord_bot_url` production's row holds.

## 4. The shared secret, in both places

`DISCORD_SERVICE_SECRET` must be identical in:

1. `.env.staging` on the server — this is what the **bot** sends.
2. The dashboard secrets file for the **player** service — this is what the app
   compares against.

The app's check fails closed: if the secret is unset there, every bot call is
rejected. A mismatch and a missing value look exactly the same from outside
(both 401), so set them from one source:

```sh
# on the server. Copies the existing line; never prints the value.
SRC=<staging-deploy-dir>/.env.staging
DST=/etc/proxy-manager/secrets/badminton-staging-player.env
sudo grep -q '^DISCORD_SERVICE_SECRET=' "$DST" \
  || grep -m1 '^DISCORD_SERVICE_SECRET=' "$SRC" | sudo tee -a "$DST" >/dev/null

# verify by key name only
sudo cut -d= -f1 "$DST" | grep DISCORD
```

Then make the player service pick it up:

```
replace_service(service="badminton-staging-player",
                image="ghcr.io/<owner>/badminton-player-staging:latest",
                env={"DISCORD_SERVICE_SECRET": "ref:DISCORD_SERVICE_SECRET"})
```

`ref:NAME` is a **dashboard-API feature only**. Docker Compose does not resolve
it — anything compose creates (including the bot) reads `${VAR}` from
`.env.staging` instead. Putting `ref:` in a compose file yields the literal
string `ref:NAME` as the value, silently.

## 5. DNS

Point `<bot-subdomain>` at the server. Do this in the Cloudflare UI; the
dashboard's DNS token is currently returning 403 (code 9109).

## 6. Start it

```sh
cd <staging-deploy-dir>
git pull
docker compose -f docker-compose.staging.yml --env-file .env.staging up -d bot
curl -s https://<bot-subdomain>/health
```

The bot is **not** behind the proxy's auth gate, and that is deliberate — auth
is opt-in per host via the `proxy.auth` label, and the bot's service simply
omits it. Discord must be able to reach it unauthenticated; the signature check
is the gate.

## 7. Tell Discord where it is, and register the commands

1. Developer Portal → **General Information** → **Interactions Endpoint URL** →
   `https://<bot-subdomain>/interactions`. Discord sends a signed PING and
   refuses to save unless it gets a valid response — so the bot must already be
   running, with the matching `DISCORD_PUBLIC_KEY`.
2. `npm run register -w bot`

## 8. Check it worked

- `/link` in the test server returns a button.
- The audit channel gets an embed for the link.
- A manual sweep posts exactly **one** embed, not one per member. (Discord rate
  limits a channel at roughly 5 messages per 5 seconds; per-member posting
  would throttle and drop entries.)

---

## When it looks broken

**Every bot call returns 401.** The secret does not match, or is missing on the
app side. Step 4. Check the key is present in the player container's env by
name — `docker exec <container> printenv | cut -d= -f1 | grep DISCORD` — never
by value.

**The bot reports invalid JSON from the app.** It is being redirected to the
sign-in page. `fetch` follows redirects, so the bot never sees the 307 — it gets
the login HTML under a 200 and dies parsing it. `/api/discord/` must be in
`isPublicPath` (`apps/player/src/lib/public-paths.ts`); there is a test for it.

**The sweep succeeds and changes nothing.** Either the guild registry is empty
(step 3) or the bot's role is too low (step 2). The audit embed distinguishes
these: an empty registry reports zero members considered, a role-position
problem reports amber 403s.

**Staging serves old code after a green build.** Staging containers do not
auto-update: their image is recorded as a bare `sha256:` id rather than a repo
reference, so the update check errors and is skipped, forever and silently. Use
`replace_service` explicitly. Also check `list_routes` — a service can end up
with **two** backends (a label-discovered container and one from the onboarded
record) round-robining between old and new code, which makes every probe look
intermittent.
