# Changelog — 2026-04-25 / 26 Session

37 commits ahead of `deploy/docker-prod`. All work lives on
`deploy/docker-staging` and is running on https://test.polardev.org.

The session split into four streams: **security & data hygiene**, the
**redesign**, **staging infra**, and a string of **bug fixes** caught
while shaking the staging stack down. Each commit is linked at the
bottom by SHA.

---

## 1. Security & data hygiene (server-action + RLS)

Targeted at items from the code-review document. Most of these were
already exploitable in prod before the session started.

- **Authz on player server actions** — `acceptChallenge`,
  `rejectChallenge`, `reportWalkover`, `submitMatchResult` now
  verify the caller is a participant on the right team and that the
  challenge is in an actionable state. Walkover report also checks
  forfeit-player team-side. — `b44e27c`, `f7bbc0a`
- **`challenges.status` flip via service-role** — RLS only lets the
  *creator* update `challenges`, so a non-creator's accept/reject/
  walkover silently no-op'd. After it landed in staging this surfaced
  as "Cancel button still showing after both players accepted" and
  "Status stayed PROPOSED after rejection." Fixed by routing those
  three writes through the service-role client (validation still
  enforced at the action layer). — `dbc26a7`
- **Duplicate match-submit guard** — `submitMatchResult` checks for
  an existing match on the challenge and rejects the second submit. —
  `b44e27c`
- **Email failures observable** — replaced silent
  `.catch(() => {})` around every Resend call with
  `Sentry.captureException`. Sender now propagates errors instead of
  double-swallowing them. — `b44e27c`
- **Atomicity / N+1 cleanup** — accept/reject/submit batch their
  notification fan-out instead of N round-trips, and parallelise
  independent reads (admin emails ⊥ score / forfeit-player name).
- **Admin auth callback hardened** — switched the hand-rolled cookie
  parser to `next/headers`'s `cookieStore.getAll()`; signOut on the
  unauthorized branch now writes clear-cookie headers onto the
  response that actually goes to the browser. — `bbf8651`, `ad2ccdc`
- **Sentry user context cleared on auth failure** — prevents identity
  bleed across requests in long-lived Node processes.
- **Validators tightened** — phone/display_name/scheduled_date/
  scheduled_time now reject obviously bad values via a
  `z.preprocess` helper that coerces empty strings to undefined.
  Dropped the dead `match_id` field from `matchResultSchema`. —
  `d4b8489`
- **ELO engine cleanup** — removed `calculateDelta` (dead duplicate
  of `calculateEloUpdate`); `previewEloChange` now accepts
  `matchesPlayed` so K-factor is correct for brand-new players. —
  `d4b8489`
- **Migrations 00017 / 00018** (since squashed into the consolidated
  00001–00007 baseline; the ELO dedupe now lives in
  `00003_functions.sql`, the self-onboarding policies in
  `00005_rls.sql`):
  - `00017_dedupe_elo_functions.sql` — drops the dead numeric-actual
    overload of `calculate_elo_update` left over from 00003 (00008
    redefined it with a boolean signature; both overloads coexisted).
  - `00018_self_onboarding_rls.sql` — RLS policies for
    `players_self_insert` (constrained to status = pending_approval,
    role = player) and `ratings_self_insert`, so the onboarding path
    no longer escapes via the service-role bypass. — `291f2a3`

---

## 2. Bug fixes (caught during staging shake-down)

These were latent in the existing app and all also affect prod.

- **Misplaced `middleware.ts`** (both apps) — the file lived at the
  project root but Next.js with the `src/` layout expects it at
  `apps/<app>/src/middleware.ts`. Build silently shipped an empty
  middleware-manifest.json:
  `{ "version": 3, "middleware": {}, "sortedMiddleware": [] }`.
  **Effect:** every "must be authenticated" / "must be admin" check
  was bypassed. Anyone could hit `/admin/dashboard`, `/feed`, etc.
  without a session. Fixed by moving both files to `src/`. — `814a82c`
- **Challenges/new opponent dropdown 400** — query filter
  `status NOT IN ('pending_approval','suspended','inactive')`
  referenced the dead `inactive` enum value (00011 simplified
  enums). PostgREST rejects the entire query with 400 on the
  invalid cast → dropdown rendered empty for everyone. Removed
  `inactive`. — `0783261`
- **Tournament participants ambiguous embedding** — `tournament_
  participants` has three FKs to `players` (`added_by`,
  `checked_in_by`, `player_id`). Queries that wrote
  `player:players(...)` got PGRST201 and silently fell to an empty
  array → "No participants yet" on the event detail page even
  though the user was registered, and the leaderboard
  Tournament-Points tab was empty. Disambiguated with column-hint
  syntax `players!player_id(...)` at three call sites. — `0d10056`
- **Tournament revalidation missed the event detail** — register /
  withdraw / check-in revalidated `/tournaments` and the tournament
  detail but not `/tournaments/<id>/events/<eventId>` — the page
  the user clicked from. Added it. — `c7fb4d7`
- **Resolve-dispute dialog had no Edit-Result option** — schema
  supported `resolution_type='edited'` with `edited_winner_side`
  + `edited_games`, but the admin dropdown only offered Accept /
  Void / Convert. Added the option, wired the score editor (winner
  + per-game inputs pre-filled from current scores), and handled
  the path server-side: replace `match_games`, update `matches`,
  call `apply_match_result`. — `93ee51c`
- **Permission denied for schema public after snapshot** — `pg_dump
  --clean --if-exists` drops + recreates the `public` schema, which
  strips Supabase's default GRANTs to `anon` / `authenticated` /
  `service_role`. The staging settings page surfaced this first
  with `Error: permission denied for schema public`. Fixed by
  re-applying GRANTs at the end of every snapshot run. — `aee00be`
- **Hero banner unreadable in dark mode** — banner background was
  `var(--ink)` (which inverts to light cream in dark mode) but
  inner text was hardcoded `rgba(255,255,255,X)` so dark mode
  rendered cream-on-cream. Replaced with
  `color-mix(in oklab, var(--bg) X%, transparent)` so text inverts
  with the theme. — `5b7d736`, `95673c6` (lead restructure)
- **Dropdown clipped by table overflow** — admin matches table has
  `overflow-x: auto` for horizontal scrolling. `Dropdown`'s
  absolute-positioned menu got clipped by the overflow ancestor.
  Rewrote to render via `createPortal` to `document.body` with
  fixed coordinates computed from `getBoundingClientRect()`,
  reposition on scroll/resize, Escape closes. — `c668796`
- **Walkover regression after server hardening** — challenge-detail
  client always passed an opposing-team player as
  `forfeit_player_id`; "I Need to Withdraw" was therefore rejected
  by the new server-side team check. Client now passes self for
  withdrawal, opponent for no-show. — `f7bbc0a`
- **Feed hero "doubles" lead text** — the lead was hardcoded to
  always describe doubles, ignoring whichever discipline the user
  actually played. Restructured into two labelled rows
  (SINGLES / DOUBLES) with PROVISIONAL / ESTABLISHED pills and
  "N matches to lock in" countdown. — `378bef1`, `95673c6`

---

## 3. Redesign (Phase 1 → Phase 3l)

A handoff bundle from Claude Design — SFU red on warm cream, light-
default, Inter / Space Grotesk / JetBrains Mono. Foundation in `2a65748`,
shell in `c00905d`, then nine pages migrated.

| Phase | Page | Commit |
|---|---|---|
| 1 | tokens + fonts (next/font + globals.css rewrite) | `2a65748` |
| 1.5 | purge risk + font dup fix | `2955362` |
| 2 | shell — TopBar, BottomNav, page container | `c00905d` |
| 3a | feed | `6c02ae3`, `a9611d1` |
| 3b | leaderboard | `cf0aab2` |
| 3c | my-stats | `211ccaf` |
| 3d | challenges (list) | `06540c7` |
| 3e | sessions | `8ed8b22` |
| 3f | announcements | `55a9c83` |
| 3g/h | tournaments (list) + login | `5f9ea4d` |
| 3i | notifications | `3fbdb3a` |
| 3j | onboarding | `d867a10` |
| 3k | challenge detail | `d5ecf3e` |
| 3l | settings, player profile, `Button.tsx` rewrite | `6303bbe` |
| 3m | tournament detail (tournament hero + events grid) | `95673c6` |

Still on the old aesthetic (still functional, just visually mid-state):
the deeper tournament event-detail page and the admin app entirely.

---

## 4. Staging infrastructure

Spun up an isolated staging stack on the Pi so changes can be tested
without affecting production data.

- **Dev Supabase** — second `supabase` CLI project at
  `~/ssd/Deploy/badminton-dev/`, project_id `badminton_dev`, ports
  64321–64327. Independent containers prefixed `_badminton_dev`;
  prod stack untouched.
- **Staging app stack** — separate clone at
  `~/ssd/Deploy/badminton-staging/` tracking `deploy/docker-staging`.
  `docker-compose.staging.yml` uses project name `badminton-staging`,
  ports 3013/3014. — `6927dc5`
- **nginx** — staging hostname `test.polardev.org` routes to 3013/3014
  with `/supabase/` proxied to the dev Supabase on 64321. (prod's
  `badminton.polardev.org` untouched.)
- **OAuth split** — Google OAuth client in dev Supabase points its
  redirect URI at `https://test.polardev.org/supabase/auth/v1/
  callback`. *Action item: add that URL to the Google Cloud Console
  OAuth client's Authorized Redirect URIs.* Discord disabled in dev
  to prevent leaking through prod's redirect.
- **Daily prod → dev snapshot** — `scripts/prod-to-dev-snapshot.sh`
  uses `pg_dump`/`psql` via `docker exec` (no host postgresql-client
  needed). Dumps prod's public schema + `auth.users` +
  `auth.identities`, restores into dev, re-applies role GRANTs.
  Cron entry: `0 4 * * *` writing to `~/ssd/Deploy/badminton-
  snapshots/cron.log`. 14-day retention. Manual run:
  `~/ssd/Deploy/badminton-staging/scripts/prod-to-dev-snapshot.sh`. —
  `757a0c4`, `9bbc21d`, `aee00be`

---

## 5. Repo / branch hygiene

- Renamed `deploy/docker-selfhost` → `deploy/docker-prod` and
  `deploy/docker-test` → `deploy/docker-staging` on the fork remote.
  Default branch on GitHub flipped to `deploy/docker-prod`. Pi's
  prod repo at `~/ssd/Deploy/badminton/` still tracks the renamed
  branch under origin.
- Deleted stale planning docs: `CHANGES.md`,
  `PLAYER_APP_IMPROVEMENTS.md`, `PROJECT_STATUS.md`,
  `SIMPLIFICATION_PLAN.md`, `UPDATES.md`. — `d276c28`
- Added `docs/test.md` — pre-prod test plan covering challenge
  lifecycle, auth gates, admin actions, edge cases, mobile. —
  `ba2f271`

---

## What's open / what to do next

- **Walk `docs/test.md`** end-to-end against staging.
- **Add `https://test.polardev.org/supabase/auth/v1/callback`** to
  the Google Cloud OAuth client's authorized redirect URIs.
- **Cherry-pick or merge** `deploy/docker-staging` into
  `deploy/docker-prod` when ready. The middleware misplacement, the
  dropdown 400, the participants embedding bug, and the
  challenges.status RLS bug all also affect prod and would be the
  primary motivation for the merge.
- **Consider** a SECURITY DEFINER `apply_challenge_acceptance` RPC
  for the still-open accept-race (P2-2 in the original review). The
  service-role hot-fix in `dbc26a7` covers the silent-no-op symptom
  but not the stale-snapshot race.
- **Push notifications** are still a stub
  (`packages/shared/src/push/send.ts`). Needs VAPID keys + a real
  `web-push` integration before the notify toggle in /settings does
  anything.
