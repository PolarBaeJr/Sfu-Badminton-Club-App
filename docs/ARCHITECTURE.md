# Architecture & Data Model

A technical map of how the app fits together. For the plain-language version, see [project/01-overview.md](project/01-overview.md).

## High-level shape

```
                          ┌─────────────────────────────┐
   Public visitor  ─────► │  Public pages (no login)     │
                          │  landing / leaderboard /exec │
                          └──────────────┬──────────────┘
   Member  ─────────────► ┌──────────────▼──────────────┐
                          │  Player app (Next.js)        │
                          │  ladder, challenges,         │
                          │  sessions, tournaments       │
                          └──────────────┬──────────────┘
   Exec / Admin  ───────► ┌──────────────▼──────────────┐        ┌──────────────────┐
                          │  Admin console (Next.js)     │        │  Edge functions   │
                          │  RBAC-gated management       │        │  (Deno, cron):    │
                          └──────────────┬──────────────┘        │  reminders,       │
                                         │                        │  expiries,        │
                          ┌──────────────▼──────────────┐        │  snapshots        │
                          │  Supabase (self-hosted)      │◄───────┤                   │
                          │  Postgres 17 · Auth · REST   │        └──────────────────┘
                          │  RLS · Storage · Realtime    │
                          └─────────────────────────────┘
```

Both Next.js apps talk to the same self-hosted Supabase backend. Edge functions run scheduled jobs against the same database.

## The two apps

- **`apps/player`** — the member experience. Reads mostly via the browser Supabase client (RLS-protected) and the public RPCs; mutations go through server actions.
- **`apps/admin`** — the exec/admin console. Management actions run as **server actions** using the **service-role** client (bypasses RLS), gated by role checks (see Access control).

Both are **Next.js 14 App Router**, built in **standalone** mode, shipped as separate Docker images.

## Shared packages

- **`packages/shared`** — the **ELO engine** (`src/elo/engine.ts`), **Zod validators** (`src/validators`), **email** (Resend, `src/email`), and **push** (web-push, `src/push`). Single source of truth for both apps.
- **`packages/ui`** — reusable React components.
- **`packages/config`** — shared config.

## Access control (three layers)

Authority is derived from columns on the `players` table — `role` (`player`/`admin`) and `is_exec` — computed into an **access level** by the `admin_access_level()` SQL function → `'admin' | 'exec' | null`.

1. **Middleware** (`apps/admin/src/middleware.ts`) — page-level gate; redirects unauthorized navigations.
2. **Server-action gate helpers** (`apps/admin/src/lib/supabase-server.ts`: `getAuthenticatedAdmin`, `getAuthenticatedExecOrAdmin`) — **the real security boundary**, since server actions use the service-role client. Every action calls one at the top.
3. **Row-Level Security** (`supabase/migrations/00005_rls.sql`) — defense for direct/anon-key access; policies are `TO authenticated` and mostly `is_admin(...)`.

The route→level map lives in `apps/admin/src/lib/permissions.ts` (`SECTION_ACCESS`, `canAccess`). The sidebar filters cosmetically off the same map.

## Public data access

Anonymous visitors can touch **nothing** at the table level (no `TO anon` RLS policies). Public reads flow only through three `SECURITY DEFINER` RPCs granted to `anon`, each hand-picking safe columns:

- `get_active_season()` · `get_executives()` · `get_leaderboard()`

This is the pattern to extend for any future public/API read (see roadmap A5).

## Core data model

| Table | Purpose |
|-------|---------|
| `players` | Member records; `role`, `is_exec`, `exec_title`, `fee_exempt`, status |
| `ratings` | Per-player ELO/stats — **singles + doubles** elo, k-factor, provisional, wins/losses, points, games, current/best streaks |
| `matches` | A played match; type, event type, rated flag, format/weights, winner, score summary, result status |
| `match_participants` | Per-player-per-match: pre/post rating, rating delta, points, games, win flag |
| `match_games` | Per-game scores |
| `challenges` | Challenge lifecycle (issue → accept → confirm), `expires_at` |
| `head_to_head_stats` | A-vs-B records |
| `partnership_stats` | Doubles pair records (matches, wins, losses, avg elo delta) |
| `seasons` | Season backbone; `active_flag`, competitive/recreational fees |
| `season_final_ratings` / `season_snapshots` | End-of-season archives |
| `sessions` | Club sessions; `track` (competitive/recreational/all), `status`, `season_id` |
| `session_attendance` | Check-ins (player_id, session_id, checked_in_at) |
| `tournaments` | `status` = draft/active/completed/archived |
| `tournament_events` | Per-event phases (registration → checkin → bracket → live → completed) |
| `tournament_participants` / `tournament_pairs` | Registrations + statuses; check-in fields |
| `tournament_matches` | Bracket matches; elo snapshot |
| `audit_logs` / `tournament_audit_log` | Change history |
| `push_subscriptions` | Web-push endpoints |

## The ELO engine

- Logistic expected score with `ELO_SCALE = 800`; start 400, top ~1300, hard-capped to a safe range.
- K-factors: provisional (<8 matches) higher, then settle.
- Match importance via `format_weight` × `event_multiplier` (+ optional override).
- Implemented **twice, kept in sync**: TypeScript (`packages/shared/src/elo/engine.ts`) and SQL (`00003_functions.sql` → `calculate_elo_update`, applied by `apply_match_result`).

## Edge functions (Deno, scheduled)

`expire-challenges`, `expire-walkover-pending`, `send-challenge-reminders`, `send-session-reminders`, `send-stale-confirmation-alerts`, `detect-noshow-patterns`, `mark-inactive-players`, `apply-season-compression`, `capture-season-snapshot`.

All gated by `x-cron-secret` (constant-time check; fail closed if `CRON_SECRET` unset), running with the service-role client.

## Deploy pipeline

```
git push deploy/docker-prod
      │
      ▼
GitHub Actions ── builds ARM64 images ──► GHCR (tags: latest + sha-<commit>)
      │
      ▼
Self-hosted proxy (Raspberry Pi) ── polls GHCR every 10 min ──► auto-deploys latest
```

Migrations are applied **manually** and never run by CI or the app — so an image deploy is DB-safe. See [ops/RUNBOOK.md](ops/RUNBOOK.md).
