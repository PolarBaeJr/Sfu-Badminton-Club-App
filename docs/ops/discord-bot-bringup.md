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
   scopes and the **Manage Roles** and **Manage Events** permissions.

   Manage Events is what lets the bot create the scheduled event a tournament
   produces when it goes active (00169). It is easy to leave off, and the
   symptom is not an error anybody sees -- the Events tab simply stays empty --
   so the bot checks for the bit before it tries and logs
   `missing MANAGE_EVENTS` with the fix. A server invited before that migration
   can be repaired without re-inviting: **Server Settings -> Roles -> (the bot's
   role) -> Manage Events**.

## 2. Migrations

Do these before `/setup` — it writes to tables that have to exist first. Run, in
order, and **only** these:

| Migration | What it adds |
|---|---|
| `00165_discord_links.sql` | the link table and its tombstones |
| `00166_discord_nightly_sync.sql` | the pg_cron schedule, plus two `cron_config` rows |
| `00167_discord_runtime_config.sql` | guilds, roles, settings |
| `00168_discord_self_roles.sql` | the self-serve ping roles and the session-ping schedule |
| `00169_discord_tournament_events.sql` | the tournament -> Discord scheduled event mapping, and its schedule |
| `00170_discord_announcement_posts.sql` | the announcement -> Discord message mapping, and its schedule |

> ### ⚠️ Pause the prod → staging snapshot before running these on staging
>
> The snapshot does `DROP SCHEMA public CASCADE` at 04:00 and then restores
> prod's `public` schema on top. Every table this bot keeps state in lives in
> `public`: `discord_guilds`, `discord_guild_roles`, `discord_settings`,
> `cron_config`, and — since 00168, 00169 and 00170 — `discord_self_roles`,
> `discord_session_pings`, `discord_tournament_events` and
> `discord_announcement_posts`.
>
> The last three make the consequence more than "lose the config". They are
> IDEMPOTENCY records: `discord_session_pings` is the only thing stopping a
> session being pinged again, `discord_tournament_events` is the only thing
> stopping a second Discord event being created for a tournament that already
> has one, and `discord_announcement_posts` is the only thing stopping a club
> announcement being posted into the channel twice. Inheriting prod's copies of
> those means staging believes prod's work was its own.
>
> The announcement relay has a second guard of its own — it relays nothing
> published more than 72 hours ago — so a staging database that comes up with
> its mapping table wiped does not replay a week of prod's notices into the test
> server. That guard is a floor, not a substitute for pausing the snapshot.
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

**Use the public origin, in both environments.** The in-cluster container name
is faster and stays off the internet, and it is a trap: the dashboard rotates
the container name on every replace, not only when scaling — observed going
`…-1000` → `…-1` → `…-2` across three routine replaces in one evening. Each
rotation breaks the URL and surfaces as `TypeError: fetch failed`, which reads
as a network fault rather than a stale name.

`APP_PUBLIC_URL` must be the public origin regardless — it builds the link a
member taps on a phone.

## 4c. Tell the app where the bot is

The reverse direction, and it is easy to miss because **the value looks
configured when it is not**. `DISCORD_BOT_URL` appears in the `player` service
of both compose files, but the player app is onboarded through the dashboard,
so that `environment:` block never reaches it. Compose is not where this gets
set on a deployed host.

Set it on the player service through the dashboard, re-passing the secret,
because a replace without `env` **drops** it:

```
replace_service(<player-service>, <image>, env={
  "DISCORD_BOT_URL": "https://<bot-subdomain>",
  "DISCORD_SERVICE_SECRET": "ref:DISCORD_SERVICE_SECRET",
})
```

Then confirm it is actually there — the container name changes on every
replace, so resolve it first:

```
C=$(ssh <host> 'docker ps --format "{{.Names}}" | grep <player> | head -1')
ssh <host> "docker exec $C printenv DISCORD_BOT_URL"
```

**Why this one fails quietly.** The `/link` page asks the bot to apply roles the
moment an account connects, and treats a failed sync as non-fatal on purpose —
the link is already made, so it says *"your roles will appear shortly"* rather
than failing. With `DISCORD_BOT_URL` unset the sync is never attempted, that
message is shown forever, and the only evidence is one line in the **player's**
log, not the bot's:

```
[discord] cannot sync: DISCORD_BOT_URL or DISCORD_SERVICE_SECRET unset
```

Nothing appears in the bot's log, because the bot is never contacted. If a
member reports "connected but no roles", read the player log first.

To apply roles for members who linked while it was broken, sweep everyone
rather than asking them to re-link. Run it from inside the bot container so the
secret stays in its own environment:

```
ssh <host> 'docker exec <bot> node -e "
const s=process.env.DISCORD_SERVICE_SECRET;
fetch(\"http://127.0.0.1:3002/sync\",{method:\"POST\",
  headers:{authorization:\`Bearer \${s}\`,\"content-type\":\"application/json\"},
  body:JSON.stringify({trigger:\"manual\"})})
 .then(r=>r.text().then(t=>console.log(r.status,t)))"'
```

## 5. DNS

**The prod bot is `bot.sfubadminton.com`, not `discord.`.** The `discord.`
subdomain is a redirect to the server invite, and pointing the bot's own
hostname at it would be far worse than a 404 in one specific place: `pg_net`
follows redirects. The nightly `POST /sync` would land on Discord's invite
page, receive a **200**, and look healthy forever while never syncing a member.

Two consequences when setting prod up:

- `cron_config.discord_bot_url` must be `https://bot.sfubadminton.com`. **The
  OWNER STEP comment in `00166_discord_nightly_sync.sql` still says
  `discord.sfubadminton.com`** -- it is not edited because that migration is
  already applied and `db-migrate.sh` checksums files, so changing it would
  report DRIFTED. Take the hostname from here, not from that comment.
- Verify the sync by reading `net._http_response.content`, never the status.
  A 200 from a redirect target proves nothing.


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

## 7b. The channels the club has to name

Three features post into a channel, and none of them guesses one — a relay that
picked a channel by itself would be a relay putting club business somewhere
nobody chose. Each is a `discord_settings` row, so each is off until it is set:

| Key | What it drives | Set in |
|---|---|---|
| `audit_channel_id` | link/unlink and sweep embeds | `/setup audit_channel:` |
| `session_ping_channel_id` | the before-each-session ping | SQL (00168) |
| `announcement_channel_id` | the announcement relay (00170) | SQL |

```sql
INSERT INTO discord_settings (key, value)
VALUES ('announcement_channel_id', '<channel id>')
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value;
```

Right-click the channel -> **Copy Channel ID** (Developer Mode on). The bot
needs View Channel and Send Messages there. It edits and deletes only its own
messages, which needs no further permission — so unlike the scheduled events
there is nothing to grant.

**Only announcements addressed to everyone are relayed.** A competitive-only or
eligible-only notice is skipped and logged as `narrow_audience`, because that
rule is matched against a value on the reading member and no Discord channel
carries one. That is the design, not a gap; see 00170's header.

---

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
