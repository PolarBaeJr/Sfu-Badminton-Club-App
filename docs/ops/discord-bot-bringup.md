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

## 2. Migrations

Do these before `/setup` — it writes to tables that have to exist first. Run, in
order, and **only** these:

| Migration | What it adds |
|---|---|
| `00165_discord_links.sql` | the link table and its tombstones |
| `00166_discord_nightly_sync.sql` | the pg_cron schedule, plus two `cron_config` rows |
| `00167_discord_runtime_config.sql` | guilds, roles, settings |

> ### ⚠️ Pause the prod → staging snapshot before running these on staging
>
> The snapshot does `DROP SCHEMA public CASCADE` at 04:00 and then restores
> prod's `public` schema on top. All four config tables live in `public`:
> `discord_guilds`, `discord_guild_roles`, `discord_settings`, `cron_config`.
>
> So the damage is not just that staging's rows are erased — **staging inherits
> production's**. It would come up holding prod's guild id, prod's role ids,
> prod's `discord_bot_url` and prod's secret, i.e. the staging bot pointed at
> the production Discord server.
>
> What partly saves you is that staging's bot is a separate Discord application
> and is not a member of the prod server, so its calls 403. That is luck, not a
> safeguard. pg_cron's schedule lives in the `cron` schema and survives the drop
> regardless, so the wiped staging keeps running the sweep on time.
>
> Until the snapshot script learns to preserve these tables, staging cannot both
> refresh from prod and hold its own bot config. Pick one deliberately.

## 3. Roles in the test server

**Run `/setup` in the server. That is the whole step.**

> `/setup` is a slash command, so it only exists after step 7
> (`npm run register -w bot`) and after the bot is running and reachable. If you
> are working through this in order, come back here once step 7 is done. The
> bot needs no config to serve `/setup` — that is the point of it.

It lists the guild's roles, adopts any that already match by name, creates the
rest with **no permissions**, and writes the ids to the database itself. No
copying snowflakes out of Discord's UI into SQL.

Requires **Manage Server** to run — Discord enforces that server-side, so the
command is not even visible to anyone else. That gate is the point: whoever runs
it decides which Discord role the bot hands to everyone the app says qualifies,
so it is restricted to the people who could already edit those roles by hand.

It is idempotent. Matching is on the normalised name, so "Session Staff",
"session-staff" and "session_staff" are one role, not three, and a club that
already made its own keeps its own name. Re-run it any time — after creating a
role by hand, after renaming one, or to pick up a role you skipped.

It never deletes or renames anything, and it never guesses: two roles sharing a
name are reported, not resolved, because picking one decides who gets what.

**Then drag the bot's own role above every role it manages.** `/setup` tells you
this every time it runs, because it is the single most common way this bot looks
like it is working while changing nothing: Discord refuses, with a 403, any
attempt to modify a member whose highest role sits above the bot's. The bot
colours that 403 amber rather than red, so a nightly sweep hitting it does not
read as an incident.

> Roles `/setup` creates carry **zero permissions**. Discord's API copies
> `@everyone`'s permissions onto a new role when the field is omitted, so on a
> server where `@everyone` can manage messages this would otherwise mint nine
> roles carrying that power. A created role is a label until a human grants it
> something.

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

## 4b. Tell the bot where the app is

`APP_API_URL` has **no default**, deliberately. Set it in `.env`.

The obvious value — `http://player:3000` — does not work and used to be the
default. Player and admin are onboarded through the proxy dashboard rather than
started by compose, so they run under generated names and nothing resolves
`player`. The symptom is `TypeError: fetch failed` on every app call, which
reads as a network fault rather than a config mistake.

Use the in-cluster container name on staging (stable for a single replica, and
fastest), or the public origin on prod (survives the replica renumbering that
scaling causes). `.env.example` spells out the trade-off. `APP_PUBLIC_URL` must
be the public origin either way — it builds the link a member taps on a phone.

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

- `/setup` reports the roles it created or adopted.
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
