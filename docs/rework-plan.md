# SFU Badminton — Structural Rework Plan (2026-07)

Batch of interrelated changes. Build on branch fixup/security-and-cleanup; deploy in ONE
coordinated window (schema migration + ELO rescale disrupt live use). Tasks #14–22.

## Phase 0 — Foundations
- seasons: add competitive_fee_cents, recreational_fee_cents.
- session_group enum ('competitive'|'recreational'|'all') + sessions.group column.
- club_fees: term_id -> season_id (UNIQUE(player_id, season_id)); DELETE terms table. [DATA-MIGRATION: remap active term's paid rows -> active season]
- RPCs: admin_access_level(uid) -> admin|exec|null (do NOT touch is_admin — RLS depends on it); get_active_season() anon-safe.
- shared: remove termSchema; feeMarkSchema term_id->season_id; add seasonFeeSchema, sessionGroupSchema; regen database.gen.ts.

## Phase 1 — Seasons as backbone
- Replace hardcoded "Season 26" (top-bar, login logged-out via anon RPC, my-stats, onboarding, emails) with active season name. Remove "CLUB ·" from subtitle. Fallback: club name only.

## Phase 2 — Fees follow seasons (replace terms)
- Each season has comp fee + rec fee (flat, admin-set); player owes by status. Exec/fee_exempt excluded.
- Manual entries: admins add a NAME (no account) to the collection list (nullable player_id + manual_name). [task #14]
- DELETE terms.ts + terms-manager.tsx + TermSelector. Fee amounts edited on Seasons page. Fees section ADMIN-ONLY.

## Phase 3 — Exec RBAC
- admin_access_level RPC + apps/admin/src/lib/permissions.ts (SECTION_ACCESS map).
- Exec-allowed: Dashboard, Announcements, Matches, Tournaments, Sessions, Seasons.
- Admin-only: Fees, Audit Log, Settings, Players (PII).
- Enforce in 3 layers: middleware (admin_access_level), server-action gate (getExecOrAdmin vs getAdminPlayer), sidebar nav filtering.

## Phase 4 — Comp/Rec training schedules
- sessions.group; admin picks group on create/edit; players see group IN (their status, 'all').

## Phase 5 — ELO rescale (nominal 400, top ~1300) [DATA-MIGRATION heavy]
- Affine stretch: new = round(a*(old-1200)+400), a = 900/(current_max-1200). Scale K-factors by a.
- Data early-stage (mostly 1200 defaults) so low-risk now. Migrate all elo columns.
- ~40 hardcoded 1200 sites + constants + onboarding/email copy + tests.

## Phase 6 — Public + fast leaderboard
- get_public_leaderboard() SECURITY DEFINER RPC (display name coalesce(display_name,full_name), ELO, W/L — NO email/phone). Never open players/ratings RLS to anon.
- Convert leaderboard to SSR (drop client fetch+sort). Drop realtime on public path; revalidate ~30-60s.
- Exclude /leaderboard from player middleware. display_name: publish coalesce(display_name, full_name).

## Phase 7 — Public site + branding [tasks #20,21,22]
- Root / = public landing page (club/app intro, leaderboard peek, Sign-in chip -> /login). Logged-in -> feed.
- /exec = public exec list (name + exec_title + photo; add players.exec_title nullable).
- New logo (replace "SB"), redesign login page. frontend-design skill.

## Phase 8 — Admin UI polish
- Edit Player dialog roomier. Platform Settings: labeled fields/toggles not raw JSON.

## Key decisions (defaults chosen; override if wanted)
ELO=affine stretch(B); fee edit on Seasons page; Players=admin-only for execs; migrate historical elo=yes;
pending_approval sees 'all' sessions; leaderboard realtime=drop on public; /leaderboard/[id]=auth-only; display_name=publish coalesce.
