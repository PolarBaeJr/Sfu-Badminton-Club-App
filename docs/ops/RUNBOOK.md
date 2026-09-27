# Operations Runbook

Step-by-step procedures for running the app in production. Written for whoever holds the "technical exec" role — including a successor who has never touched it.

> ⚠️ **This repository is public.** Never commit real secrets, hostnames, SSH keys, or tokens into these docs. Placeholders like `<pi-host>`, `<ssh-user>`, `<served-container>` stand for real values that live in the club **password manager** and [CREDENTIALS.md](CREDENTIALS.md) (kept private, not filled in here).

---

## Mental model

- **The app** (player + admin) runs as Docker containers on **self-hosted servers**, behind the club's own **reverse proxy**, which **auto-updates them from GHCR**. They are not managed by hand. **Never run `docker compose up` or `docker compose pull` against the player or admin containers** — doing so is what took production down on 2026-08-06. The containers also float across both hosts under dynamic scaling, so a `docker ps` on one machine is not a map of where they run.
- **The database** is a self-hosted **Supabase** stack on the same server. It is **separate** from the app — deploying the app never touches data.
- **A deploy is a push.** CI builds the image and the proxy rolls the containers on its own; there is no manual step on the server. **Migrations are manual.** **Backups are nightly.**

---

## Deploy a change

1. Make the change on a branch, open a PR against **`deploy/docker-prod`**, get the **CI / checks** job green (type-check, lint, test, plus the edge-function drift check), merge. There is no `security-review` check and no `main` branch gate; if you are waiting for either, you are waiting for something that does not exist.
2. Fast-forward / push to **`deploy/docker-prod`** (the CI build branch):
   ```sh
   git push <remote> HEAD:deploy/docker-prod
   ```
3. GitHub Actions builds ARM64 images and pushes to GHCR, tagged **`latest`** and **`sha-<commit>`**.
4. **Nothing.** The proxy on the host watches the registry, notices the new
   digest and rolls the serving containers itself. Confirm it landed with the
   read-only check in the next section.

> ⚠️ **Never recreate the app containers by hand.** This step used to read
> `docker compose pull player admin && docker compose up -d player admin`, and
> told you it was "the only manual step; nothing on the server updates on its
> own". Both halves were wrong, and the command is now forbidden outright by
> [`.github/CI.md`](../../.github/CI.md), which names this file as its
> authority. It fails in three separate ways:
>
> - It **detaches the containers from auto-update.** The player and admin
>   containers are owned by the proxy. A manual recreate takes them out of its
>   hands, so the next real deploy silently does nothing and the symptom appears
>   days later as "new code didn't go live".
> - Under dynamic scaling a compose recreate **drops the replica count to 1**
>   without reporting it, and prod player/admin float across both hosts.
> - The compose **service** names are not the container names. The obvious
>   invocation therefore targets the wrong thing, which is how production went
>   down on 2026-08-06.

> **Runtime variables (settled 2026-09-24).** The prod player and admin
> containers are centrally managed by the proxy dashboard (central env, with
> the Mac dashboard as origin), and the prod compose files in
> `/mnt/ssd/Deploy/badminton` on the Pi are retired
> (`*.retired-centralenv-20260924`). To add or change a variable on player or
> admin, use the dashboard's **Add env** or the MCP `set_service_env`, and pass
> secrets as `ref:NAME`, never as a literal. The dashboard rolls the containers
> itself. `.env` in that directory no longer feeds player or admin (it still
> serves the bot and staging).

### Verify a deploy landed (read-only)

Compare the **running container's image** to the newest `latest`, and check the commit label:

```sh
# on the server
docker inspect <served-container> -f '{{.Image}}'                 # running image id
docker image inspect ghcr.io/<owner>/badminton-player:latest -f '{{.Id}}'   # newest latest id
docker image inspect ghcr.io/<owner>/badminton-player:latest \
  -f '{{index .Config.Labels "org.opencontainers.image.revision"}}'         # commit it was built from
```

Matching image ids + the expected commit = deployed.

### Reaching the server

Deploys and verification run **on the server** over SSH. If the public SSH port is unreachable, fall back to the **Tailscale** address (`ssh <pi-host>` over the tailnet). Announce before doing service-mutation actions on the proxy dashboard.

---

## Roll back

Every build is tagged `sha-<commit>` (immutable).

**Roll back by redeploying an earlier commit to `deploy/docker-prod`.** It goes
out the same way every other deploy does, so it needs no manual step on the
server and leaves auto-update intact.

The older advice here was to pin the previous `sha-<commit>` in the compose file
and then `docker compose pull player admin && docker compose up -d player admin`.
Do not: that is the forbidden recreate from the Deploy section, and pinning a tag
additionally fights the proxy, which is watching for a newer digest. You would be
rolling back and re-arming the thing that rolls you forward again.

---

## Restore a database backup

Backups are nightly `pg_dump` archives kept locally on a 14-day window and
copied off-site to Google Drive and to a second machine. **Both off-site copies
are encrypted**, the second machine's with `age` since 2026-09-22, so a restore
from either starts with a decrypt. See `backup/README.md`. To restore:

> ### Read this first: the dump does not carry permissions
>
> The nightly dumps are taken with `--no-acl`, and `pg_dump` never emits roles
> at any flag combination. So the archive contains **no roles and no grants**.
> Because `--clean --if-exists` drops and recreates every table, and a freshly
> created table carries only its owner's privileges, a plain restore leaves
> `anon` and `authenticated` able to read **nothing**.
>
> **That failure is silent.** A denied PostgREST read comes back as an empty
> list, not an error, so the restored site serves 200s with no data on it. You
> will think the restore worked.
>
> Read the "Restoring" section of `backup/README.md` before running anything
> here: it carries the globals-first procedure and the caveats. The permanent
> fix is written on branch `fix/backup-globals-and-acls` and is **not merged**.

1. Locate the desired dump (local backup dir or the decrypted off-site copy).
2. **Take a fresh backup first** (never restore over the only copy).
3. Restore roles and grants **first**, per `backup/README.md`. Applying globals
   to a container that already has `anon`, `authenticated`, `authenticator` and
   `service_role` will print `already exists` for each and still exit 0, so
   capture stderr and check that `already exists` is the *only* error there.
4. Then restore the dump into the running Postgres container:
   ```sh
   # custom-format dump:
   docker exec -i <db-container> pg_restore -U postgres -d postgres --clean --if-exists < backup.dump
   ```
5. **Re-apply any deletions made since the dump was taken.** A restore brings
   back members who asked to be deleted, and if the dump predates their
   request it erases the request too, so nothing will ever delete them again.
   `backup/README.md` has the procedure and `scripts/request-account-deletion.sh`
   is the tool.
6. Verify, and do not verify by loading a page: a permissions failure renders
   as an empty page, not an error. Check that a table a member should be able
   to read actually returns rows.

See `backup/README.md` for the backup scripts and the rclone/crypt setup.

---

## Manage admins & execs

Roles live on the `players` table (`role` = `player`/`admin`, `is_exec` = true/false, `is_trainer` = true/false). Prefer the **admin console** — **Permissions**, and only Permissions. The Members edit dialog used to carry a "Console access" dropdown and no longer does: the server action refuses those three columns from every caller now, so the Permissions page is the one place the change can be made, and it is the only one that checks you are not editing yourself, that you are not touching an admin, and that you are not handing out more than you hold.

Direct SQL (last resort, on the server) — note that it bypasses all of the above **and writes no audit row**, so nothing on `/accounts` will show that it happened:

```sh
# promote to admin
docker exec -i <db-container> psql -U postgres -c \
  "UPDATE players SET role='admin' WHERE email='someone@example.com';"

# grant exec
docker exec -i <db-container> psql -U postgres -c \
  "UPDATE players SET is_exec=TRUE WHERE email='someone@example.com';"
```

To re-seed the primary admin from scratch, see `supabase/One Time Scripts/reseed-admin.sql`.

---

## Apply a database migration

> The live DB has **real data**. Migrations are **additive and forward-only** — never edit an already-applied baseline or re-apply it destructively. New change = a new `000NN_*.sql` (ALTER/CREATE only).

1. Write the new migration file in `supabase/migrations/` (next number in sequence).
2. **Back up the DB first.**
2b. Regenerate the release manifest and commit it:
   ```sh
   ./scripts/gen-migration-manifest.sh    # writes supabase/migrations/.manifest.json
   ```
   `migration-manifest.test.ts` fails when the committed manifest disagrees with
   the directory, so forgetting this fails CI rather than shipping an image that
   claims to expect a schema it does not.
3. Apply it manually by piping the file over SSH into the Postgres container, stopping on the first error:
   ```sh
   cat supabase/migrations/000NN_your_change.sql \
     | ssh <pi-host> "docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1"
   ```
4. If the change touches the ELO math, update **both** the SQL and the TypeScript engine.
5. Regenerate `packages/shared/src/types/database.gen.ts`, then redeploy:
   ```sh
   npm run gen:types                 # reads staging (supabase-staging-db on `pi`)
   npm run gen:types -- --container supabase-db --label production
   ```
   `npm run gen:types` runs `scripts/gen-db-types.mjs`, which reads the catalogs
   over the same ssh path as step 3 — no connection string, so no password. Point
   it at whichever database the migration has actually reached: **default is
   staging**, and the `--container supabase-db --label production` form is the
   one to commit once the migration is live on prod.

   The output is a pure function of the schema (no timestamps, everything
   sorted), so a re-run against an unchanged database rewrites the file byte for
   byte. A non-empty `git diff` after running it therefore means a real schema
   change — which makes this the cheapest way to check whether prod and staging
   have diverged: generate against each and diff.

   Nothing enforces this step, which is how the file once got 18 tables behind.

Nothing in CI or the app runs SQL — so migrations are always a deliberate manual step.

### Before promoting an image: preflight (mandatory)

```sh
./scripts/db-migrate.sh preflight prod       # or staging
```

This is **the authoritative schema-compatibility gate** (F-012). It compares
`supabase/migrations/.manifest.json` — the rollup of every migration's version
and checksum — against `public.schema_migrations`, and exits non-zero on a
pending file, a checksum that drifted after the migration was applied, or a
database that is *ahead* of the checkout (promoting would be a downgrade).
Exit 3 is its own state: the database has no `schema_migrations` table at all,
which is a bootstrap problem rather than a version mismatch.

**The readiness probe deliberately does not check this.** Readiness gates the
proxy backend, so a lagging database would fail it on every replica at once,
empty the local backend pool, and hand the site to a mesh peer talking to the
same database — turning a blocked promotion into a total outage. Readiness
answers "can this container reach the database" and only that. Schema
compatibility is a release-time decision made once, by a human, here.

Preserve the preflight output in the release record.

---

## Manage edge-function secrets

Edge functions fail closed without `CRON_SECRET`. To set/rotate:

```sh
supabase secrets set CRON_SECRET=$(openssl rand -hex 32)
# then update every scheduled job to send the matching x-cron-secret header
supabase functions deploy
```

Also set the shared VAPID + Resend secrets (same values as the apps). Full steps: `supabase/functions/DEPLOY.md`.

---

## Monitoring (Sentry / PostHog)

**Sentry** captures errors across each app's browser, server, and edge runtimes (source maps uploaded at build time so stack traces are readable). **PostHog ships in the code but is inert in production.** `NEXT_PUBLIC_POSTHOG_KEY` is not set there, so `lib/posthog.ts` and `lib/actions/_shared.ts` both short-circuit and no client is ever constructed: nothing is collected and nothing is sent. Treat it as disabled rather than as a data source. Note also that it would **not** be anonymous if enabled, because `components/posthog-identify.tsx` calls `identify()` with the player's uuid. Setting that key is therefore a privacy decision, not a config change, and it adds an entry to the member data export's disclosed-recipients list in the same commit. Both are configured **by environment variable only** — no values in this repo; real values live in the password manager / [CREDENTIALS.md](CREDENTIALS.md).

Env var names (values kept private):

| Variable | Where | When it takes effect |
|----------|-------|----------------------|
| `NEXT_PUBLIC_SENTRY_DSN` | **build-time** (GitHub Actions secret) — client bundle | needs a **CI rebuild** |
| `SENTRY_DSN` | **runtime** (server `.env`) | see the unsettled-procedure note in Deploy |
| `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN` | **build-time** — source-map upload | needs a **CI rebuild** |
| `NEXT_PUBLIC_POSTHOG_KEY` / `NEXT_PUBLIC_POSTHOG_HOST` | **build-time**, client-only | needs a **CI rebuild** |

> Rule of thumb: anything `NEXT_PUBLIC_*` is baked into the client bundle at **build time** → change it → **rebuild via CI**. The server-side `SENTRY_DSN` is a runtime var, and getting a changed runtime var into the app containers is the unsettled procedure flagged under Deploy. Read that note before you start.

---

## Restart Supabase

**Always restart the full stack**, not individual containers — restarting one container can leave the API gateway caching stale internal addresses and break auth routing.

The code block here was empty. The one procedure the page insists on gave no
command, which is why it is written out below in full.

Prod is the compose project **`supabase`** (11 containers) at
`/mnt/ssd/Deploy/supabase-prod`; staging is `supabase-staging` at
`/mnt/ssd/Deploy/supabase-staging`. Two compose files are in play per stack, the
base and an override, so run these from the directory and let compose pick up
both rather than passing `-p`.

**No config change, just bounce it.** Same containers, so the internal addresses
do not move and there is nothing for kong to cache stale:

```sh
# on the server
cd /mnt/ssd/Deploy/supabase-prod && docker compose restart
```

**After editing `.env` or a compose file.** A restart does NOT re-read `.env`,
so a rotated secret or a new variable needs a real recreate. This is a full API
outage for as long as it takes to come back, so it is a maintenance-window
action, not a casual one:

```sh
# on the server
cd /mnt/ssd/Deploy/supabase-prod && docker compose down && docker compose up -d
```

> Two notes before anyone generalises from this. The prohibition on
> `docker compose up/pull` applies to the **player and admin** containers, which
> the proxy owns; the Supabase stack is a separate project that nothing
> auto-updates, so compose is the correct tool here. And `down` takes the
> database container with it, so confirm a current backup exists first.

---

## Common incidents

| Symptom | First checks |
|---------|--------------|
| **Site down** | Is the server up? Are the app + Supabase containers running? Check the proxy is routing to a container with the right host label. |
| **Login broken** | Supabase Auth container healthy? Full-stack restart if the gateway is caching stale IPs. Email (Resend) sending? |
| **New code didn't go live** | Did CI build succeed and push the image? Then the proxy should have rolled it on its own. If it did not, suspect the containers were detached from auto-update by a past manual `compose up`. Verify by image, per the read-only check under Deploy. |
| **New env var not taking effect** | `NEXT_PUBLIC_*`? Needs a **CI rebuild**. Server-side var on player/admin? No settled procedure: see the note under Deploy. Supabase stack? Needs a `down`/`up -d`, per Restart Supabase. |
| **Push notifications silent** | VAPID secrets set on both apps and the edge functions? |
| **Emails not sending** | `RESEND_API_KEY` set? Sender domain still verified? |
| **A scheduled job stopped** | `CRON_SECRET` set and the job sending the `x-cron-secret` header? |

---

## Golden rules

- ✅ Deploys via `deploy/docker-prod` → CI builds and pushes the image → **the proxy rolls the containers itself**. Verify by image; never recreate player/admin by hand.
- ✅ Migrations manual, additive, forward-only, backup first.
- ✅ Verify deploys by inspecting the running image against `latest`.
- ❌ Never `docker compose up -d` or `pull` the **player/admin** containers: the dashboard owns them, their prod compose files are retired, and a recreate would fight it. Runtime vars go through the dashboard (`set_service_env`, secrets as `ref:NAME`).
- ✅ Restart Supabase as a full stack.
- ❌ Never `docker compose --build` on the server (CI builds images; the server pulls).
- ❌ Never commit real secrets to this public repo.
