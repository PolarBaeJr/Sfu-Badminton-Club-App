# SFU Badminton Club App

A members' web app (installable PWA) for running a university badminton club: a live **ELO ladder** (singles + doubles), **seasons & fees**, **sessions with attendance**, a full **tournament system**, and a private **admin console** — plus a public landing page, leaderboard, and exec roster.

**Live:** [badminton.polardev.org](https://badminton.polardev.org) · **Status:** executive beta (July 2026)

> New here? Start with the plain-language overview in **[docs/project/](docs/project/README.md)**.

---

## Repository layout

This is an **npm-workspaces + Turborepo** monorepo:

```
apps/
  player/        Next.js 14 app — the members' experience (badminton.polardev.org)
  admin/         Next.js 14 app — the exec/admin console (/admin)
packages/
  shared/        ELO rating engine, Zod validators, email + push senders
  ui/            Reusable React component library (~2 dozen components)
  config/        Shared configuration
supabase/
  migrations/    Database schema, functions, RLS (00001–00007 baseline)
  functions/     Deno edge functions (cron jobs: reminders, expiries, snapshots)
backup/          Nightly DB backup scripts (pg_dump → local + encrypted off-site)
docs/            Documentation (see below)
```

## Tech stack (short version)

TypeScript · Next.js 14 (App Router) · React 18 · Tailwind CSS · Supabase (self-hosted Postgres 17, Auth, RLS) · Deno edge functions · Docker · GitHub Actions → GHCR · self-hosted on a Raspberry Pi.

Full breakdown: **[docs/project/06-tech-stack.md](docs/project/06-tech-stack.md)**.

## Quick start (local development)

**Prerequisites:** Node 20, npm 10.

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

Full setup (database, migrations, secrets, gotchas): **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)**.

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

Push to the `deploy/docker-prod` branch → GitHub Actions builds ARM64 images to GHCR (tagged `latest` + `sha-<commit>`) → the self-hosted proxy auto-deploys the new image. **Never** run `docker compose --build` on the Pi, and **never** `docker pull` the `latest` tag on the Pi manually (it masks the auto-update check). See **[docs/ops/RUNBOOK.md](docs/ops/RUNBOOK.md)**.

## Documentation

| Area | Where |
|------|-------|
| **Project overview** (for execs) | [docs/project/](docs/project/README.md) — what it is, what's built, roadmap, security, ops, tech stack |
| **Local development** | [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) |
| **Architecture & data model** | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| **Operations runbook** | [docs/ops/RUNBOOK.md](docs/ops/RUNBOOK.md) |
| **Credentials & custody** | [docs/ops/CREDENTIALS.md](docs/ops/CREDENTIALS.md) |
| **Admin/exec user guide** | [docs/guides/admin-guide.md](docs/guides/admin-guide.md) |
| **Player FAQ** | [docs/guides/player-faq.md](docs/guides/player-faq.md) |
| **Legal (drafts)** | [docs/legal/](docs/legal/) — privacy, conduct, waiver, terms |

## Ownership

Property of the SFU Badminton Club. Maintained by the club's technical exec(s). For handover, see [docs/ops/CREDENTIALS.md](docs/ops/CREDENTIALS.md).
