# SFU Badminton Club App

A members' web app (installable PWA) for running a university badminton club: a live **ELO ladder** (singles + doubles), **seasons & fees**, **sessions with attendance**, a full **tournament system**, and a private **admin console** — plus a public landing page, leaderboard, and exec roster.

**Live:** [sfubadminton.com](https://sfubadminton.com) · admin console at [sfubadminton.com/admin](https://sfubadminton.com/admin) · **Status:** deployed to production, not yet released to members (September 2026) · **Version:** see `version` in the root `package.json` (also shown in the app under Settings → About)

> `badminton.polardev.org` is **staging**, not a second live site. Its database is wiped and refreshed from production nightly — see [docs/STAGING.md](docs/STAGING.md).

> New here? Start with the plain-language overview in **[docs/project/](docs/project/README.md)**.

---

## Repository layout

This is an **npm-workspaces + Turborepo** monorepo:

```
apps/
  player/        Next.js 15 app — the members' experience (sfubadminton.com)
  admin/         Next.js 15 app — the exec/admin console (sfubadminton.com/admin)
  bot/           Discord bot — plain Node, no framework, no runtime deps
packages/
  shared/        ELO rating engine, Zod validators, email + push senders
  ui/            Reusable React component library (31 components)
  config/        Shared configuration (placeholder — nothing imports it yet)
supabase/
  migrations/    Database schema, functions, RLS — applied MANUALLY, never by CI
  functions/     Deno edge functions — present but NOT scheduled on the
                 self-hosted stack; the live jobs are pg_cron -> app routes
scripts/         Operator tooling: migration runner, type/manifest generators,
                 the nightly prod→staging snapshot
backup/          Nightly DB backup scripts (pg_dump → local + encrypted off-site)
docs/            Documentation (see below)
.github/         CI — builds and pushes images; never touches the database
```

**Every one of those has its own README.** Start there rather than here for
anything specific to a part:

| Part | |
|------|--|
| [`apps/player`](apps/player/README.md) | the members' app |
| [`apps/admin`](apps/admin/README.md) | the exec console — read its authorization section before touching a write path |
| [`apps/bot`](apps/bot/README.md) | the Discord bot |
| [`packages/shared`](packages/shared/README.md) | ELO engine, DB types, validators, senders |
| [`packages/ui`](packages/ui/README.md) | the component library |
| [`packages/config`](packages/config/README.md) | shared config (currently unused) |
| [`supabase`](supabase/README.md) | schema, migrations, SQL tests |
| [`scripts`](scripts/README.md) | operator tooling |
| [`backup`](backup/README.md) | database backups and restore |
| [`.github`](.github/CI.md) | CI |
| [`docs`](docs/README.md) | all documentation, indexed |

## Tech stack (short version)

TypeScript · Next.js 15 (App Router) · React 19 · Tailwind CSS · Supabase (self-hosted Postgres 17, Auth, RLS) · pg_cron for scheduled work · Docker · GitHub Actions → GHCR · self-hosted on the club's own hardware.

Full breakdown: **[docs/project/06-tech-stack.md](docs/project/06-tech-stack.md)**.

> **React is pinned at the workspace root.** `packages/ui` declares react and
> react-dom as *peer* dependencies, and the root `package.json` `overrides` force
> a single copy. Two copies of React in one tree produce error #31 at runtime —
> add react to a package's `dependencies` and you will reintroduce it.

## Quick start (local development)

**Prerequisites:** Node 24 (`engines.node` is `>=24.0.0 <25`, enforced by `engine-strict` in `.npmrc`), npm 10.

```sh
# 1. Install
npm install

# 2. Configure env (copy the example and fill in your Supabase keys)
cp .env.example apps/player/.env.local
cp .env.example apps/admin/.env.local
# edit both: NEXT_PUBLIC_SUPABASE_URL, NEXT_PUBLIC_SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY

# 3. Run
npm run dev:player   # http://localhost:3000
npm run dev:admin    # http://localhost:3001
```

## Common scripts

| Command | Does |
|---------|------|
| `npm run dev` | Run all apps (Turborepo) |
| `npm run dev:player` / `npm run dev:admin` | Run one app |
| `npm run build` | Build everything |
| `npm run lint` | Lint |
| `npm run type-check` | TypeScript check |
| `npm run test` | Run tests (Vitest) |

## Deployment

Push to the `deploy/docker-prod` branch → GitHub Actions builds ARM64 images to GHCR (tagged `latest` + `sha-<commit>`) → the self-hosted proxy auto-deploys within ~10 minutes.

**Apply migrations BEFORE pushing.** An image deploy is DB-safe, but app code that expects a new column breaks the moment the containers roll.

**The exception is a migration that changes an existing function's signature or tightens what it accepts.** Migrations-first assumes the old image keeps working against the new schema. That assumption fails when the old image still calls the function the migration just changed, and it fails for the whole rolling window — the old containers keep serving until the last one is replaced. Draw generation is the live case: an old generator can commit an unstamped match after the new one has already checked for foreign matches, and nothing later removes it. Those migrations need the affected feature drained first. The draw-generation drain step is written up in `docs/sensitive/PROD-CUTOVER-00177-00205.md` — note that `docs/sensitive/` is **gitignored and not in this repository**, so that file exists only on the maintainer's machine.

**Never** run `docker compose --build`, `docker compose up -d`, or a manual `docker pull` for the player/admin containers on the Pi — they are owned by the proxy, not compose, and doing so detaches them from auto-update. See **[docs/ops/RUNBOOK.md](docs/ops/RUNBOOK.md)**.

## Documentation

| Area | Where |
|------|-------|
| **All documentation, indexed** | [docs/README.md](docs/README.md) |
| **Project overview** (for execs) | [docs/project/](docs/project/README.md) — what it is, what's built, roadmap, security, ops, tech stack |
| **Operations runbook** | [docs/ops/RUNBOOK.md](docs/ops/RUNBOOK.md) |
| **Credentials & custody** | [docs/ops/CREDENTIALS.md](docs/ops/CREDENTIALS.md) |
| **Admin/exec user guide** | [docs/guides/admin-guide.md](docs/guides/admin-guide.md) |
| **Player FAQ** | [docs/guides/player-faq.md](docs/guides/player-faq.md) |
| **Legal (drafts)** | [docs/legal/](docs/legal/) — privacy, conduct, waiver, terms |

## Ownership

Property of the SFU Badminton Club. Maintained by the club's technical exec(s). For handover, see [docs/ops/CREDENTIALS.md](docs/ops/CREDENTIALS.md).
