# Staging — badminton.polardev.org

A full second copy of the app on the Pi, alongside production, with its own
database. Production is never touched by anything done here.

| | production | staging |
|---|---|---|
| host | `sfubadminton.com` | `badminton.polardev.org` |
| player / admin ports | 3011 / 3010 | 3013 / 3014 |
| Supabase | `supabase-prod`, kong `:54321` | `supabase-staging`, kong `:64321` |
| compose project | `supabase` | `supabase-staging` |
| images | `ghcr.io/polarbaejr/badminton-*:latest` | `ghcr.io/polarbaejr/badminton-*-staging:latest` |
| built from | `deploy/docker-prod` | `deploy/docker-staging` **and** `deploy/docker-prod` |
| outbound email | Resend (real) | **mailpit — never leaves the Pi** |
| Sentry | on | off |
| PostHog | **off** (ships, but no key is set in prod, so it collects nothing) | off |
| auto-update | on | on |

## Why staging needs its own image, not just its own config

Every `NEXT_PUBLIC_*` value is a Docker **build arg**, inlined into the client
bundle when the image is built. The production image therefore has production's
Supabase URL compiled into it. Running that image against a staging `.env` moves
only the server — every browser-side query would still go to the production
database. That is worse than having no staging at all, so staging gets its own
build.

It is also why staging gets its **own GHCR package**
(`badminton-player-staging`) rather than a second tag on production's. The
auto-updater watches each container's own image reference and replaces it with
that same reference, so a distinct package can only ever pull a staging build.
Sharing production's package and distinguishing by tag would put one label typo
between staging and the production database.

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

> ⚠️ **The snapshot copies real people, and a scrub removes them again. Know
> which half is live on the Pi before you trust either.**
>
> `scripts/prod-to-dev-snapshot.sh` runs nightly at 04:00 and copies **the whole
> `public` schema plus `auth.users` and `auth.identities`** from production. That
> copy is faithful, which means real names, real email addresses, real phone
> numbers, officer notes about members and fee records.
>
> **The scrub** runs at the end of the same script. It replaces every member's
> name, email, phone, bio and avatar with values derived from their own row id,
> blanks the officer notes and the audit-log diffs, and deletes the bearer
> tokens, passkeys, push endpoints and bounce records outright. Ids, ratings,
> matches, fee status and row counts are preserved, so staging stays a realistic
> rehearsal rather than becoming a fixture. Replacements are stable across
> refreshes, so a member is the same "Jordan Nguyen" tomorrow as today, and a bug
> report written against staging still reads the next morning.
>
> It ends by querying staging for any remaining real identifier and **failing the
> whole refresh** if it finds one. That check is not decoration: a scrub that
> silently matched zero rows looks exactly like one that worked, and the first
> symptom otherwise is someone reading a real address off staging. Ablating one
> statement of the scrub does make it fail, which has been tested.
> `SCRUB_MEMBER_DATA=0` skips the whole thing and says so loudly on stderr.
>
> **Two things it deliberately does not touch.** `$STAGING_ADMIN_EMAILS`, because
> sign-in here is an email code and scrubbing the owner's address locks the owner
> out of staging entirely. And announcement bodies, which are exec-authored
> broadcasts already shown to the whole membership and are a real rendering
> surface; they can name a member, so that is an accepted trade rather than an
> oversight.
>
> **UNTIL THE SCRIPT IS PULLED ON THE PI, NONE OF THAT IS RUNNING.** It executes
> from a plain checkout there and nothing auto-updates it, unlike the player and
> admin images. Until then staging is a second full copy of the membership
> database: it doubles the blast radius of any breach and belongs in the scope of
> one, a member who deletes their account is not deleted here until the next
> refresh, and access to the staging console is access to real member records.
> Nothing accidental protects it either, since it is reachable on the public
> internet behind the same auth as production and nothing more, and staging is
> deliberately **not** gated on the test suite, so it is also where untested code
> runs.
>
> The one thing genuinely isolated either way is **outbound email**: staging
> sends to mailpit, so a real address in the staging database can never be mailed
> by mistake. That is the mail path only. It says nothing about the data at rest.
>
> If the scrub ever becomes a nuisance, the other option is to stop copying
> member rows at all. The original seed was 14 synthetic accounts covering every
> state the admin UI has a control for (competitive, recreational, pending
> approval, suspended, banned, inactive, exec, trainer) plus two admin accounts
> on the owner's own addresses, and it covered the UI fine.

Configuration rows (`platform_settings`, `legal_documents`, `seasons`) are
copied because they are settings, not people. Two things are deliberately
**not** faithful copies: staging keeps its own Discord config, so the staging
bot can never aim at the real guild, and the owner's staging admin role is
re-granted after each refresh, because production roles leave the console
unusable.

## Deploying a change to staging

**Push to `deploy/docker-staging`.** That is the whole flow:

```
push deploy/docker-staging
  → .github/workflows/build-staging.yml builds both images on an arm64 runner
  → pushes ghcr.io/polarbaejr/badminton-{player,admin}-staging:latest
  → proxy-manager sees a new digest and replaces the staging containers
```

Pushes to `deploy/docker-prod` rebuild staging too, so staging is never behind
what is live — otherwise it stops being a rehearsal of production.

The workflow needs one repo secret, the anon key from
`/mnt/ssd/Deploy/supabase-staging/.env` on the Pi:

```bash
gh secret set STAGING_SUPABASE_ANON_KEY
```

Without it the build fails immediately and says so, rather than shipping an
image whose client bundle cannot reach any database.

Staging is deliberately **not** gated on the test suite. Staging is where you go
to find out whether something works; refusing to deploy a red commit there
removes the one place it is safe to look at one.

### Building by hand (while CI is unavailable)

Images are built off the Pi and loaded onto it; the Pi never builds.

```bash
# from the repo root on a machine with Docker (arm64 host — the Pi is aarch64)
docker buildx build --target runner-player \
  -t ghcr.io/polarbaejr/badminton-player-staging:latest \
  --build-arg NEXT_PUBLIC_SUPABASE_URL=https://badminton.polardev.org/supabase \
  --build-arg NEXT_PUBLIC_SUPABASE_ANON_KEY=<staging anon key> \
  --build-arg NEXT_PUBLIC_APP_URL=https://badminton.polardev.org \
  --build-arg NEXT_PUBLIC_PLAYER_URL=https://badminton.polardev.org \
  --build-arg NEXT_PUBLIC_ADMIN_URL=https://badminton.polardev.org/admin \
  --build-arg NEXT_PUBLIC_PASSKEY_RP_ID=badminton.polardev.org \
  --load .
docker save ghcr.io/polarbaejr/badminton-player-staging:latest \
  | gzip -1 | ssh pi 'gunzip | docker load'

# then on the Pi
cd /mnt/ssd/Deploy/badminton
sudo docker compose -f docker-compose.staging.yml --env-file .env.staging up -d
```

The admin image is the same command with `--target runner-admin`,
`-t ghcr.io/polarbaejr/badminton-admin-staging:latest`, and
`--build-arg NEXT_PUBLIC_BASE_PATH=/admin`.

## Routing

`proxy-manager` resolves `badminton.polardev.org` from two places: the
`proxy.*` labels on the staging containers (`/` and `/admin`), and a static
entry in `cmd/proxy/routes.json` for `/supabase` → `host.docker.internal:64321`.
Longest-prefix wins, so `/supabase` and `/admin` both beat the player's `/`.

The proxy reloads on any Docker event or a hit to `/refresh` on the metrics
port — editing routes does **not** require restarting it, so production keeps
serving throughout.
