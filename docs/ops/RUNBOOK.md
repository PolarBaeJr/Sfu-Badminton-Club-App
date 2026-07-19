# Operations Runbook

Step-by-step procedures for running the app in production. Written for whoever holds the "technical exec" role — including a successor who has never touched it.

> ⚠️ **This repository is public.** Never commit real secrets, hostnames, SSH keys, or tokens into these docs. Placeholders like `<pi-host>`, `<ssh-user>`, `<served-container>` stand for real values that live in the club **password manager** and [CREDENTIALS.md](CREDENTIALS.md) (kept private, not filled in here).

---

## Mental model

- **The app** (player + admin) runs as Docker containers on a **self-hosted server** (Raspberry Pi), behind the club's own **reverse proxy** which auto-deploys new images.
- **The database** is a self-hosted **Supabase** stack on the same server. It is **separate** from the app — deploying the app never touches data.
- **Deploys are automatic** from GitHub. **Migrations are manual.** **Backups are nightly.**

---

## Deploy a change

1. Make the change on a branch, open a PR to `main`, get the **security-review** + **test** checks green, merge.
2. Fast-forward / push to **`deploy/docker-prod`** (the CI build branch):
   ```sh
   git push <remote> HEAD:deploy/docker-prod
   ```
3. GitHub Actions builds ARM64 images and pushes to GHCR, tagged **`latest`** and **`sha-<commit>`**.
4. The proxy's **auto-update** polls GHCR **every ~10 minutes** and redeploys `latest` automatically. No manual step on the server.

### Verify a deploy landed (read-only — do NOT `docker pull`)

Compare the **running container's image** to the newest `latest`, and check the commit label:

```sh
# on the server
docker inspect <served-container> -f '{{.Image}}'                 # running image id
docker image inspect ghcr.io/<owner>/badminton-player:latest -f '{{.Id}}'   # newest latest id
docker image inspect ghcr.io/<owner>/badminton-player:latest \
  -f '{{index .Config.Labels "org.opencontainers.image.revision"}}'         # commit it was built from
```

Matching image ids + the expected commit = deployed.

> 🛑 **Never run `docker pull ...:latest` on the server manually.** The auto-updater decides "update available" by comparing the **local `latest` tag** to the registry. Pulling `latest` yourself advances the local tag *without* recreating the container, which makes the updater think it's already up to date — and it will **never auto-deploy that image**. If you did this by accident, force a redeploy via the proxy dashboard's **Replace** button.

### If auto-update stalls

Open the proxy dashboard → the `badminton-player` / `badminton-admin` service → **Replace** (forces pull + recreate). Announce before doing service-mutation actions on the dashboard.

---

## Roll back

Every build is tagged `sha-<commit>` (immutable). To roll back, point the service at the previous `sha-<commit>` tag via the proxy dashboard (or redeploy an earlier commit to `deploy/docker-prod`). Prefer this over editing containers by hand.

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

> The live DB has **real data**. Migrations are **forward-only** — never edit the `00001–00007` baseline or re-apply it destructively. New change = a new `00008_*.sql` (ALTER/CREATE).

1. Write the new migration file in `supabase/migrations/`.
2. **Back up the DB first.**
3. Apply it manually on the server:
   ```sh
   docker exec -i <db-container> psql -U postgres < supabase/migrations/00008_your_change.sql
   ```
4. If the change touches the ELO math, update **both** the SQL and the TypeScript engine.
5. Regenerate types if applicable, redeploy the app.

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
| **New code didn't go live** | Did CI build succeed? Did auto-update run (≤10 min)? Did someone `docker pull latest` and mask it? → Replace via dashboard. |
| **Push notifications silent** | VAPID secrets set on both apps and the edge functions? |
| **Emails not sending** | `RESEND_API_KEY` set? Sender domain still verified? |
| **A scheduled job stopped** | `CRON_SECRET` set and the job sending the `x-cron-secret` header? |

---

## Golden rules

- ✅ Deploys via `deploy/docker-prod` → CI → auto-update.
- ✅ Migrations manual, forward-only, backup first.
- ✅ Verify deploys by inspecting the image; **never `docker pull latest` on the server.**
- ✅ Restart Supabase as a full stack.
- ❌ Never `docker compose --build` on the server (CI builds images; the server pulls).
- ❌ Never commit real secrets to this public repo.
