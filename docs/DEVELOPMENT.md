# Development Guide

How to run, build, and work on the SFU Badminton Club App locally.

## Prerequisites

- **Node.js 20** (the Docker images use `node:20`; match it locally)
- **npm 10** (the repo pins `npm@10.9.3`)
- A **Supabase** project to point at — either the club's self-hosted instance (ask a maintainer for dev keys) or your own local/hosted Supabase for isolated development
- Optional: the **Supabase CLI** (for running migrations and deploying edge functions)

## 1. Install

```sh
npm install
```

This installs all workspaces (apps + packages) via npm workspaces.

## 2. Environment variables

Copy `.env.example` into each app and fill it in:

```sh
cp .env.example apps/player/.env.local
cp .env.example apps/admin/.env.local
```

| Variable | Required | Notes |
|----------|----------|-------|
| `NEXT_PUBLIC_SUPABASE_URL` | ✅ | Supabase API URL (baked into the client bundle) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | ✅ | Public anon key (safe to expose; RLS protects data) |
| `SUPABASE_SERVICE_ROLE_KEY` | ✅ | **Server-only.** Bypasses RLS — never expose to the client |
| `NEXT_PUBLIC_APP_URL` / `_PLAYER_URL` / `_ADMIN_URL` | optional | Used for redirects; set to your local URLs in dev |
| `NEXT_PUBLIC_VAPID_PUBLIC_KEY` / `VAPID_PRIVATE_KEY` / `VAPID_EMAIL` | optional | Web push (no-ops if unset) |
| `RESEND_API_KEY` | optional | Email sending (throws if a send is attempted without it) |
| `NEXT_PUBLIC_SENTRY_DSN` / `SENTRY_*` | optional | Error monitoring |
| `NEXT_PUBLIC_POSTHOG_KEY` / `_HOST` | optional | Analytics |

> **Security:** `SUPABASE_SERVICE_ROLE_KEY` and the `VAPID_PRIVATE_KEY`/`RESEND_API_KEY` are secrets. Keep them in `.env.local` (gitignored), never commit them.

## 3. Run

```sh
npm run dev:player    # http://localhost:3000
npm run dev:admin     # http://localhost:3001
npm run dev           # both, via Turborepo
```

## 4. Database & migrations

The schema lives in `supabase/migrations/`. `00001`–`00007` are the **baseline**; everything after is a forward-only change on top (currently up to `00047`).

| File | Contents |
|------|----------|
| `00001_schema.sql` | Tables + enums |
| `00002_indexes.sql` | Indexes |
| `00003_functions.sql` | SQL functions (ELO math, `admin_access_level`, public RPCs, `activate_season`) |
| `00004_triggers.sql` | Triggers |
| `00005_rls.sql` | Row-Level Security policies |
| `00006_settings.sql` | Settings |
| `00007_seed.sql` | Seed data (commented out for production) |

**Applying migrations:**
- **Local:** run the SQL files against your dev database (Supabase CLI `supabase db reset`, or `psql`).
- **Production:** migrations are applied **manually** and are **forward-only** — the live DB has real data, so never edit the baseline or re-apply it destructively. New changes = the next numbered file, `ALTER`/`CREATE` only.

Practical rules learned the hard way:
- **Apply before deploying.** App code that reads a new column breaks the moment
  the containers roll, and they roll on their own within ~10 minutes of a push.
- **Wrap each file in `BEGIN; … COMMIT;`** with `ON_ERROR_STOP=1`, so a failure
  rolls that file back instead of leaving the schema half-changed.
- **`pg_get_functiondef` output has no trailing semicolon.** If you rebuild a
  function from it, terminate it yourself — otherwise whatever follows is parsed
  as part of the function body.
- **`CREATE OR REPLACE FUNCTION` only replaces an exact signature match.** Adding
  a parameter creates a sibling overload and silently orphans the original; the
  callers keep using the old one.
- **Redefining a trigger function replaces it wholesale** — every guard it used
  to contain must be carried forward, including ones added by a change you are
  not looking at. See [ops/RUNBOOK.md](ops/RUNBOOK.md#applying-a-database-migration).

## 5. Scheduled work

The live jobs are **pg_cron → an admin app route**, because Postgres cannot send
a web push or an email itself. They read their URL and shared secret from the
locked-down `cron_config` table and are a no-op until that secret exists, so
nothing is ever POSTed unauthenticated.

The Deno functions in `supabase/functions/` are **dormant** — they exist and are
mounted, but nothing schedules them on the self-hosted stack. Do not assume
logic living there is running.

## 6. Quality checks

```sh
npm run type-check    # TypeScript across the monorepo
npm run lint          # ESLint
npm run test          # Vitest (includes the ELO engine tests)
npm run build         # Production build of both apps
```

## Gotchas

- **Turbo cold-cache race:** on a clean cache, `admin:build` can recreate `.next/types` while `admin:type-check` reads it (TS6053). Run `build` before `type-check`, or re-run.
- **The ELO engine is duplicated on purpose:** the TypeScript engine (`packages/shared/src/elo/engine.ts`, tournaments) and the SQL functions (`calculate_elo_update`, applied by `apply_match_result`, challenges) must stay in sync. Change both together, and remember both now read their knobs from `platform_settings.rating_defaults`.
- **Tailwind opacity shorthand does not work on CSS variables.** `bg-[var(--color-success)]/10` emits **no CSS at all** in Tailwind 3.4 — it fails silently, so the element simply has no background. Use `color-mix(in srgb, var(--x) 10%, transparent)`.
- **Working in a git worktree?** It has no `node_modules`, so Node resolves `@badminton/shared` and `@badminton/ui` up to the main checkout. A green build there is **meaningless** for shared-package changes. Run `npm install` in the worktree, or verify in the main checkout.
- **`packages/ui` and `packages/shared` have no build step** — they're consumed from source (`main` points at `src/index.ts`). No compilation needed at this size.
- **Two enforcement truths:** server actions use the service-role client (bypasses RLS), so the **gate helpers** in `apps/admin/src/lib/supabase-server.ts` are the real security boundary — not RLS. RLS is the backstop for direct/anon-key access.

## Project conventions

- **Next.js App Router** with server actions for mutations.
- **Zod** validation for all external input (`packages/shared/src/validators`).
- **Tailwind** for styling; shared UI in `packages/ui`.
- Access control: two-tier (`admin` / `exec`) — see [ARCHITECTURE.md](ARCHITECTURE.md) and `apps/admin/src/lib/permissions.ts`.
