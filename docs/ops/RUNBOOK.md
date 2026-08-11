# Operations Runbook

Step-by-step procedures for running the app in production. Written for whoever holds the "technical exec" role — including a successor who has never touched it.

> ⚠️ **This repository is public.** Never commit real secrets, hostnames, SSH keys, or tokens into these docs. Placeholders like `<pi-host>`, `<ssh-user>`, `<served-container>` stand for real values that live in the club **password manager** and [CREDENTIALS.md](CREDENTIALS.md) (kept private, not filled in here).

---

## Mental model

- **The app** (player + admin) runs as **compose-managed** Docker containers (`badminton-player-1` / `badminton-admin-1`) on a **self-hosted server** (Raspberry Pi), behind the club's own **reverse proxy**.
- **The database** is a self-hosted **Supabase** stack on the same server. It is **separate** from the app — deploying the app never touches data.
- **Deploys are a push + a compose recreate** on the server. **Migrations are manual.** **Backups are nightly.**

---

## Deploy a change

1. Make the change on a branch, open a PR to `main`, get the **security-review** + **test** checks green, merge.
2. Fast-forward / push to **`deploy/docker-prod`** (the CI build branch):
   ```sh
   git push <remote> HEAD:deploy/docker-prod
   ```
3. GitHub Actions builds ARM64 images and pushes to GHCR, tagged **`latest`** and **`sha-<commit>`**.
4. **Recreate the serving containers on the server** — pull the new images and let compose recreate them:
   ```sh
   # on the server
   cd <deploy-dir> && docker compose pull player admin && docker compose up -d player admin
   ```
   This is the only manual step; nothing on the server updates on its own.

> ⚠️ **Env-clone gotcha.** If your change adds a **new runtime variable** to the server's `.env`, you must do a real `docker compose up -d` so the container picks it up. Do **not** use the proxy dashboard's **"Replace"** to redeploy in that case — Replace **clones the old environment** and your new variable will be missing. Compose recreate reads `.env` fresh; Replace does not.

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

Every build is tagged `sha-<commit>` (immutable). To roll back, point the compose service at the previous `sha-<commit>` tag (pin the image tag in the compose file / `.env`, then `docker compose pull player admin && docker compose up -d player admin`), or redeploy an earlier commit to `deploy/docker-prod`. Prefer this over editing containers by hand.

---

## Restore a database backup

Backups are nightly `pg_dump` archives kept locally (rolling retention) and copied **encrypted** off-site (Google Drive + a second machine). To restore:

1. Locate the desired dump (local backup dir or the decrypted off-site copy).
2. **Take a fresh backup first** (never restore over the only copy).
3. Restore into the running Postgres container:
   ```sh
   # custom-format dump:
   docker exec -i <db-container> pg_restore -U postgres -d postgres --clean --if-exists < backup.dump
   ```
4. Verify: log in, check the leaderboard and a recent match.

See `backup/README.md` for the backup scripts and the rclone/crypt setup.

---

## Manage admins & execs

Roles live on the `players` table (`role` = `player`/`admin`, `is_exec` = true/false). Prefer the **admin console** (Members → edit) to change them. Direct SQL (last resort, on the server):

```sh
# promote to admin
docker exec -i <db-container> psql -U postgres -c \
  "UPDATE players SET role='admin' WHERE email='someone@example.com';"

# grant exec
docker exec -i <db-container> psql -U postgres -c \
  "UPDATE players SET is_exec=TRUE WHERE email='someone@example.com';"
```

To re-seed the primary admin from scratch, see `scripts/reseed-admin.sql`.

---

## Apply a database migration

> The live DB has **real data**. Migrations are **additive and forward-only** — never edit an already-applied baseline or re-apply it destructively. New change = a new `000NN_*.sql` (ALTER/CREATE only).

1. Write the new migration file in `supabase/migrations/` (next number in sequence).
2. **Back up the DB first.**
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

**Sentry** captures errors across each app's browser, server, and edge runtimes (source maps uploaded at build time so stack traces are readable). **PostHog** captures anonymous, cookieless product analytics from the client. Both are configured **by environment variable only** — no values in this repo; real values live in the password manager / [CREDENTIALS.md](CREDENTIALS.md).

Env var names (values kept private):

| Variable | Where | When it takes effect |
|----------|-------|----------------------|
| `NEXT_PUBLIC_SENTRY_DSN` | **build-time** (GitHub Actions secret) — client bundle | needs a **CI rebuild** |
| `SENTRY_DSN` | **runtime** (server `.env`) | needs the **compose recreate** (`up -d`) |
| `SENTRY_ORG` / `SENTRY_PROJECT` / `SENTRY_AUTH_TOKEN` | **build-time** — source-map upload | needs a **CI rebuild** |
| `NEXT_PUBLIC_POSTHOG_KEY` / `NEXT_PUBLIC_POSTHOG_HOST` | **build-time**, client-only | needs a **CI rebuild** |

> Rule of thumb: anything `NEXT_PUBLIC_*` is baked into the client bundle at **build time** → change it → **rebuild via CI**. The server-side `SENTRY_DSN` is a runtime var → change `.env` → **compose recreate** (mind the env-clone gotcha above).

---

## Restart Supabase

**Always restart the full stack**, not individual containers — restarting one container can leave the API gateway caching stale internal addresses and break auth routing.

```sh
# stop then start the whole Supabase stack together
```

---

## Common incidents

| Symptom | First checks |
|---------|--------------|
| **Site down** | Is the server up? Are the app + Supabase containers running? Check the proxy is routing to a container with the right host label. |
| **Login broken** | Supabase Auth container healthy? Full-stack restart if the gateway is caching stale IPs. Email (Resend) sending? |
| **New code didn't go live** | Did CI build succeed? Did anyone run the **compose recreate** (`docker compose pull player admin && up -d`) on the server? A push alone doesn't deploy. |
| **New env var not taking effect** | `NEXT_PUBLIC_*`? Needs a **CI rebuild**. Server-side var? Needs `docker compose up -d` — **not** dashboard "Replace" (it clones the old env). |
| **Push notifications silent** | VAPID secrets set on both apps and the edge functions? |
| **Emails not sending** | `RESEND_API_KEY` set? Sender domain still verified? |
| **A scheduled job stopped** | `CRON_SECRET` set and the job sending the `x-cron-secret` header? |

---

## Golden rules

- ✅ Deploys via `deploy/docker-prod` → CI builds → **compose recreate on the server** (`docker compose pull player admin && up -d`).
- ✅ Migrations manual, additive, forward-only, backup first.
- ✅ Verify deploys by inspecting the running image against `latest`.
- ✅ A new runtime var in `.env` needs a real `compose up -d`, **not** dashboard "Replace" (Replace clones the old env).
- ✅ Restart Supabase as a full stack.
- ❌ Never `docker compose --build` on the server (CI builds images; the server pulls).
- ❌ Never commit real secrets to this public repo.
