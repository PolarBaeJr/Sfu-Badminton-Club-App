# Staging — badminton.polardev.org

A full second copy of the app on the Pi, alongside production, with its own
database. Production is never touched by anything done here.

| | production | staging |
|---|---|---|
| host | `sfubadminton.com` | `badminton.polardev.org` |
| player / admin ports | 3011 / 3010 | 3013 / 3014 |
| Supabase | `supabase-prod`, kong `:54321` | `supabase-staging`, kong `:64321` |
| compose project | `supabase` | `supabase-staging` |
| images | `ghcr.io/polarbaejr/badminton-*:latest` | `badminton-*:staging` (local) |
| outbound email | Resend (real) | **mailpit — never leaves the Pi** |
| Sentry / PostHog | on | off |
| auto-update | on | **off** |

## Why staging needs its own image, not just its own config

Every `NEXT_PUBLIC_*` value is a Docker **build arg**, inlined into the client
bundle when the image is built. The production image therefore has production's
Supabase URL compiled into it. Running that image against a staging `.env` moves
only the server — every browser-side query would still go to the production
database. That is worse than having no staging at all, so staging gets its own
build.

The same fact is why `proxy.autoupdate` is `"false"` on both staging
containers. The auto-updater replaces a container with the newest image for its
service group; left on, it would swap the staging build for the production one
and silently point this host at production data.

## Reading staging email

GoTrue sends to a local **mailpit** instead of Resend, so sign-in codes and
notifications are captured on the Pi and can never reach a real inbox or bounce
against the production sending domain. Read them at
`https://mail-staging.polardev.org`.

Google sign-in is **off** on staging: its redirect URI is registered against the
production domain in the Google console. Sign in with an email code instead.

## Passkeys

They work. `NEXT_PUBLIC_PASSKEY_RP_ID` is a build arg, set to
`badminton.polardev.org` for staging — a passkey enrolled on staging is scoped
to that host and is not usable against production, and vice versa.

## The data

Schema is a `pg_dump --schema-only` of production's `public` schema — a read;
production is never written to. Verified at parity: 46 tables, 104 RLS policies,
53 functions, 27 triggers.

Configuration rows (`platform_settings`, `legal_documents`, `seasons`) are
copied because they are settings, not people. **No production member data is
copied.** The roster is 14 synthetic accounts covering every state the admin UI
has controls for — competitive, recreational, pending approval, suspended,
banned, inactive, exec, trainer — plus two admin accounts on the owner's own
addresses.

## Deploying a change to staging

Images are built off the Pi and loaded onto it; the Pi never builds.

```bash
# from the repo root on a machine with Docker (arm64 host — the Pi is aarch64)
docker buildx build --target runner-player -t badminton-player:staging \
  --build-arg NEXT_PUBLIC_SUPABASE_URL=https://badminton.polardev.org/supabase \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=<staging anon key> \
  --build-arg NEXT_PUBLIC_APP_URL=https://badminton.polardev.org \
  --build-arg NEXT_PUBLIC_PLAYER_URL=https://badminton.polardev.org \
  --build-arg NEXT_PUBLIC_ADMIN_URL=https://badminton.polardev.org/admin \
  --build-arg NEXT_PUBLIC_PASSKEY_RP_ID=badminton.polardev.org \
  --load .
docker save badminton-player:staging | gzip -1 | ssh pi 'gunzip | docker load'

# then on the Pi
cd /mnt/ssd/Deploy/badminton
sudo docker compose -f docker-compose.staging.yml --env-file .env.staging up -d
```

The admin image is the same command with `--target runner-admin`,
`-t badminton-admin:staging`, and `--build-arg NEXT_PUBLIC_BASE_PATH=/admin`.

## Routing

`proxy-manager` resolves `badminton.polardev.org` from two places: the
`proxy.*` labels on the staging containers (`/` and `/admin`), and a static
entry in `cmd/proxy/routes.json` for `/supabase` → `host.docker.internal:64321`.
Longest-prefix wins, so `/supabase` and `/admin` both beat the player's `/`.

The proxy reloads on any Docker event or a hit to `/refresh` on the metrics
port — editing routes does **not** require restarting it, so production keeps
serving throughout.
