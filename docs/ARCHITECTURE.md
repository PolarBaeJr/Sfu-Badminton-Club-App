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

- **`apps/player`** — the member experience. Reads mostly via the browser Supabase client (RLS-protected) and the public RPCs; mutations go through server actions. Navigation is **public vs member**: signed-out visitors get a slim public bar (brand → `/`, Leaderboard, Execs); signed-in members get the full member nav; execs/admins also get an **"Exec Panel"** link to the admin app. Logged-in users are no longer redirected off `/`. It also serves the **`/api/calendar/[token]`** route — an ICS/webcal feed authenticated by the per-player token from `calendar_feed_tokens` (calendar clients can't log in, so the unguessable token is the credential); rate-limited.
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

**Passkey gate (admin).** On top of the role checks, the admin app requires a **WebAuthn passkey** (`@simplewebauthn`, `passkey_credentials`). The middleware sends any exec/admin who hasn't enrolled to `/unavailable` (with a passkey-login option); a verified passkey is recorded in a **signed HttpOnly cookie** (`apps/admin/src/lib/passkey/`), with a grace state until enrollment.

## Public data access

Anonymous visitors can touch **nothing** at the table level (no `TO anon` RLS policies). Public reads flow only through three `SECURITY DEFINER` RPCs granted to `anon`, each hand-picking safe columns:

- `get_active_season()` · `get_executives()` · `get_leaderboard()`

`get_executives()` also returns each exec's `bio` and `exec_photo_url`. Both are
public **for execs only** — the function is `SECURITY DEFINER` filtered to
`is_exec = TRUE`, so it cannot leak an ordinary member's bio.

This is the pattern to extend for any future public/API read (see roadmap A5).

## Core data model

| Table | Purpose |
|-------|---------|
| `players` | Member records; `role`, `is_exec`, `exec_title`, `fee_exempt`, status, `waiver_reset_at` (per-player forced re-sign), `deletion_requested_at` (30-day deletion grace) |
| `ratings` | Per-player ELO/stats — **singles + doubles** elo, k-factor, provisional, wins/losses, points, games, current/best streaks |
| `matches` | A played match; type, event type, rated flag, format/weights, winner, score summary, result status |
| `match_participants` | Per-player-per-match: pre/post rating, rating delta, points, games, win flag |
| `match_games` | Per-game scores |
| `challenges` | Challenge lifecycle (issue → accept → confirm), `expires_at` |
| `head_to_head_stats` | A-vs-B records |
| `partnership_stats` | Doubles pair records (matches, wins, losses, avg elo delta) |
| `seasons` | Season backbone; `active_flag`, competitive/recreational fees |
| `season_final_ratings` / `season_snapshots` | End-of-season archives |
| `sessions` | Club sessions; `track` (competitive/recreational/all), `status`, `season_id`, `start_time`/`end_time` |
| `session_attendance` | Check-ins/attendance; `status` (`checked_in`/`present`/`no_show`/`excused`), `marked_by`, `marked_at` |
| `session_rsvp` | Ahead-of-time intent per (session, player); `intent` (`going`/`declined`) — distinct from same-day check-in |
| `tournaments` | `status` = draft/active/completed/archived |
| `tournament_events` | Per-event phases (registration → checkin → bracket → live → completed) |
| `tournament_participants` / `tournament_pairs` | Registrations + statuses; check-in fields |
| `tournament_matches` | Bracket matches; elo snapshot |
| `audit_logs` / `tournament_audit_log` | Change history |
| `push_subscriptions` | Web-push endpoints |
| `legal_documents` | Versioned legal text; `document` ∈ `waiver`/`code_of_conduct`/`terms_of_use`/`privacy_policy`, `reacceptance_required_since` (global forced re-sign) |
| `waiver_acceptances` | Append-only acceptance history (who accepted which `document`+`version`, when); waiver re-signs every 365 days |
| `event_waiver_acceptances` | Per-player acceptance of a tournament's `waiver_text`; `waiver_hash` (SHA-256) re-requires acceptance after edits |
| `calendar_feed_tokens` | Per-player secret token backing the ICS/webcal feed; resettable (revokes old links) |
| `passkey_credentials` | Enrolled WebAuthn passkeys gating the admin console |
| `email_suppressions` | Addresses the app must not mail — hard bounce, complaint, or one-click unsubscribe. RLS on with **zero policies**, so only the service role reaches it |
| `tournament_checkin_tokens` | One opaque token per tournament backing the check-in QR; rotating it revokes every printed copy. Same zero-policy RLS |
| `cron_config` | URL + shared secret for the pg_cron jobs; unreadable by `authenticated` |

Columns worth knowing, added later:

| Column | Why |
|--------|-----|
| `players.membership_type` | `internal` / `alumni` / `external`. **Independent of `role`/`is_exec`** — an exec is still an internal member — and gates tournament entry |
| `players.exec_photo_url` | Public exec-page photo, deliberately separate from `avatar_url` so a profile change never alters the club page |
| `tournaments.allowed_memberships` | Which groups may register; defaults to all three |
| `tournament_events.games_per_match` / `points_per_game` | Typed match shape; NULL falls back to the `match_format` enum |
| `tournament_events.seeded_from_event_id` / `seed_by` | Pool → bracket: seed this event from another's standings, by wins or points |
| `tournament_matches.time_exceeded` | The clock ended the game — relaxes score legality to the cap alone |
| `club_fees.reference` / `tournament_fees.reference` | Transaction id, so a bank export can be reconciled against a flat fee |
| `seasons.term` / `year` | Real columns behind the season picker; `name` is derived by trigger so it cannot drift |

## The ELO engine

- Logistic expected score with `ELO_SCALE = 800`; members start at 400.
- **Every knob is configurable** from admin Settings, stored in
  `platform_settings.rating_defaults`: the four K-factors, the provisional
  threshold, the sweep multiplier, and `min_elo`/`max_elo`. Missing, zero,
  negative or inverted values fall back to the hardcoded defaults rather than
  freezing or collapsing the ladder.
- Match importance via `format_weight` × `event_multiplier` (+ optional
  override), and a coarse margin bonus for a clean sweep.
- Implemented **twice and kept in sync**: TypeScript
  (`packages/shared/src/elo/engine.ts`, used by tournaments) and SQL
  (`calculate_elo_update`, applied by `apply_match_result`, used by challenges).
  Both read the same settings — if they ever diverge, the same scoreline moves
  ratings differently depending on where it was played.

**The cap is lossy.** The new rating is clamped and the delta derived from the
clamped value, so at the ceiling the winner gains nothing while the loser still
drops in full — rating leaves the ladder with none created. Keep `max_elo` well
clear of your strongest player.

## Scheduled work

Two jobs run, both **pg_cron → an admin app route** (`cron.job`):

| Job | Schedule | Route |
|-----|----------|-------|
| `session-reminders` | `*/5 * * * *` | `/api/cron/session-reminders` |
| `weekly-digest` | `0 17 * * 1` | `/api/cron/weekly-digest` |

Postgres cannot send a web push (VAPID key) or an email (provider SDK) itself,
so it POSTs the app and the app does the work. Both authenticate with a shared
secret from the locked-down `cron_config` table, and both fail **closed** — the
scheduled statement is a no-op until the secret row exists, so nothing is ever
POSTed unauthenticated.

**The Deno edge functions are not wired up.** `supabase/functions/*`
(`expire-challenges`, `apply-season-compression`, `capture-season-snapshot`,
`detect-noshow-patterns`, …) exist and are mounted in the `supabase-edge-functions`
container, but **nothing schedules them** on the self-hosted stack — there is no
hosted cron. Treat them as dormant: the logic they contain is not running.

## Observability

- **Sentry** (`@sentry/nextjs`) — error tracking wired for all three Next.js runtimes in each app (`sentry.client.config.ts` / `sentry.server.config.ts` / `sentry.edge.config.ts`), with **source-map upload** at build time and a `tunnelRoute` (`/monitoring`) to dodge ad-blockers. Errors are **tagged with the player id**; per-route error boundaries and a `global-error.tsx` in each app report, and genuine server-action failures `captureException`. **Session Replay is off.**
- **PostHog** — product analytics, client (`posthog-js`) + server (`posthog-node` via `trackServerEvent`). Captures pageviews/leaves plus domain events (`challenge_*`, `match_result_*`, `session_checked_in`, `session_rsvp`, `account_deletion_*`, `leaderboard_viewed`, `push_notification_subscribed`). **Cookieless, identified-only, no replay.**

## Deploy pipeline

```
git push origin HEAD:deploy/docker-prod
      │
      ▼
GitHub Actions ── builds ARM64 images ──► GHCR (tags: latest + sha-<commit>)
      │
      ▼
self-hosted proxy ── auto-update poll (~10 min) ──► rolls the containers
```

The reverse proxy that fronts and auto-deploys these containers is a **separate
self-hosted project** with its own repository and docs — it is not part of this
app, and its internals are deliberately not documented here.

**Do not run `docker compose pull` / `up -d` for the player or admin apps.** The
serving containers are owned by the proxy, not by compose —
they are named `goproxy-badminton-{player,admin}-N` and the index increments on
every deploy. Reaching for compose fights the proxy and detaches the
containers from auto-update.

Verifying a deploy: the container index incrementing is the signal. The
`image.revision` label is **not** trustworthy — check behaviour, or grep the
compiled bundle inside the running container for a string you know is new.

Rollback is a *replace* with an explicit `sha-<commit>` tag — every commit is
published, not just `latest`. Turn auto-update **off** first, or it pulls
`latest` straight back over the rollback.

Migrations are applied **manually** and never by CI or the app, so an image
deploy is DB-safe — but the converse matters too: an app deploy that expects a
column will break until its migration is applied. Apply first, deploy second.
