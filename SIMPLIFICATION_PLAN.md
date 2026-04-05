# SFU Badminton Platform — Simplification & Production Plan

## Context

The SFU Badminton admin app is live at `admin.badminton.polardev.org:3010` but NOT production-ready. Every server action uses a DEV MODE auth bypass that grants admin access to the first player in the database. The sidebar has no mobile support. There are zero tests. Real Supabase credentials are committed in `.env.example`. The player app can't be deployed yet.

This document is the comprehensive plan to simplify, secure, and ship this platform.

---

## 1. Current Architecture Summary

**Monorepo structure:** Turborepo with 2 Next.js 14 apps + 2 shared packages, Supabase backend.

### Auth Model
- Middleware in both apps checks `supabase.auth.getUser()` — redirects unauthenticated to `/login`
- Login supports Google OAuth + magic link
- **CRITICAL FLAW:** Admin app has `getAdminPlayer()` defined in 4 separate files (`actions.ts:12`, `tournament-actions.ts:30`, `settings/actions.tsx:6`, `announcements/actions.tsx:15`). All 4 copies grab the **first player in the database** with no session validation. Any authenticated user is treated as admin. This function is called 61 times across all server actions.
- Player app auth is correct — `requirePlayer()` in `/apps/player/src/lib/actions.ts:37-44` validates the real session user.

### Role Model
- `UserRole = 'player' | 'moderator' | 'admin' | 'coach_executive'` — defined in `database.ts:12`
- **`moderator` and `coach_executive` are never checked anywhere in application code.** Zero branches exist for these roles.
- The only role check in the entire admin app is `player?.role === 'admin'` on the settings page (line 25).
- DB functions `is_admin()` and `is_admin_or_coach()` exist but are only used in RLS policies, never called from app code.
- Shared helpers `isAdmin()`, `isAdminOrCoach()`, `canModerate()` in `helpers.ts:34-36` exist but are barely used.

### Player Model
- `PlayerStatus` has 7 values: `eligible_competitive`, `competitive_associate`, `recreational`, `alumni_external`, `suspended`, `inactive`, `pending_approval`
- The distinction between `eligible_competitive` and `competitive_associate` is unclear — both are treated as "active competitive players"
- `eligibility_flag` is a separate boolean, redundant with status
- Additional unused profile fields: `profile_visibility`, `hide_from_leaderboard`, `show_activity_status`, `notification_preferences` (JSONB)

### Tournament System
- 1,993 lines in `tournament-actions.ts` with 31 exported functions
- Supports single elimination AND round robin
- Full seeding, check-in, bracket generation, Elo integration, placement bonuses
- 716-line PDF draw sheet generator (`DrawSheetPDF.tsx`)
- Event Control Center with 6 dynamic tabs and 8 sub-components

### Other Systems
- Challenges (875 lines player-side, full lifecycle)
- Sessions (drop-in tracking)
- Varsity (weighted evaluation index)
- Announcements (compose/publish)
- Disputes, Walkovers, Seasons, Audit Logs
- Reliability Metrics, H2H Stats, Partnership Stats, Season Snapshots

### Mobile/Responsive UI
- **Admin app: NOT mobile friendly.** Fixed `w-64` sidebar, hardcoded `ml-64` layout, login page `-ml-64` hack.
- **Player app: Good mobile UX.** Bottom nav, top bar, responsive padding, mobile-first design.

### Sources of Bloat
- 4 duplicate `getAdminPlayer()` definitions
- Server actions exist in BOTH `/lib/actions.ts` AND inline `actions.tsx` files (9 inline files)
- Varsity system (niche), Sessions system (not core), Announcements (email handles this)
- DrawSheetPDF.tsx (716 lines), 7 player statuses where 4 suffice, 4 roles where 2 suffice
- Profile privacy settings never used in UI

---

## 2. Recommended Target Product Model

| Area | Current | Target |
|---|---|---|
| **Admin access** | Anyone logged in = admin | Binary: `role = 'admin'` or denied. No moderator, no coach_executive. |
| **Player types** | 7 statuses + eligibility_flag + active_flag | 4 statuses: `competitive`, `recreational`, `pending_approval`, `suspended` |
| **Tournament** | Single elim + round robin + bonuses + PDF + undo/edit/lock/bulk | Single elimination first. Round robin, PDF, placement bonuses are Phase 2. |
| **Admin nav** | 11 links, 15 pages | 7 links: Dashboard, Players, Tournaments, Matches, Seasons, Audit, Settings |
| **Settings** | Platform settings table + profile + about | Just current user info + logout. Platform config → env vars. |
| **Player nav** | 5 bottom-nav items | Keep as-is. Player app is already well-structured. |

---

## 3. REMOVE

| What | Where | Why |
|---|---|---|
| `moderator` role | `database.ts:12`, `helpers.ts:35-36`, `00001_schema.sql`, `00005_rls.sql` | Never used in any code branch. Zero middleware checks. Zero UI gates. |
| `coach_executive` role | Same locations | Never checked in app code. |
| `alumni_external` status | `database.ts:8`, `constants.ts`, admin player forms | Not a meaningful category for a university club. |
| `competitive_associate` status | `database.ts:8`, `constants.ts` | Confusing distinction from `eligible_competitive`. Merge into `competitive`. |
| `eligibility_flag` field | `database.ts:108`, admin player forms, leaderboard filters | Redundant when `competitive` status implies eligibility. |
| `profile_visibility` field | `database.ts:114` | All profiles are public. No code reads this. |
| `hide_from_leaderboard` field | `database.ts:115` | If you're competitive, you're on the leaderboard. |
| `show_activity_status` field | `database.ts:116` | No code reads this. |
| `notification_preferences` JSONB | `database.ts:117` | No UI to configure. No code reads it. |
| Varsity page | `/apps/admin/src/app/varsity/` (155 lines + notes.tsx) | Niche admin feature. Defer. |
| Sessions system (admin) | `/apps/admin/src/app/sessions/` (86 lines + actions) | Not core. Defer. |
| Sessions system (player) | `/apps/player/src/app/sessions/` | Defer. |
| Announcements system (admin) | `/apps/admin/src/app/announcements/` (456 lines total) | Email handles this. Defer. |
| Announcements system (player) | `/apps/player/src/app/announcements/` | Defer. |
| DrawSheetPDF component | `DrawSheetPDF.tsx` (716 lines) | Share a link to the bracket instead. |
| `isAdminOrCoach()` helper | `helpers.ts:35` | No coach_executive role → dead function. |
| `canModerate()` helper | `helpers.ts:36` | No moderator role → dead function. |
| `createVarsityNote` / `deleteVarsityNote` | `actions.ts:916-970` | Removing varsity system. |
| `output: 'standalone'` | `apps/admin/next.config.js:3` | Not needed for Vercel. |
| Real credentials in `.env.example` | `.env.example` lines 1-4 | Security issue. Replace with placeholders. Rotate keys. |

**Estimated removal: ~2,500 lines of code + 7 DB tables no longer referenced + significant type simplification.**

---

## 4. SIMPLIFY

| What | Current | Target | Files |
|---|---|---|---|
| `PlayerStatus` enum | 7 values | 4: `competitive`, `recreational`, `pending_approval`, `suspended` | `database.ts`, `constants.ts`, `00001_schema.sql`, admin player forms |
| `UserRole` enum | 4 values | 2: `player`, `admin` | Same files |
| `getAdminPlayer()` | 4 duplicate definitions, DEV MODE | 1 canonical function in `supabase-server.ts` | `actions.ts`, `tournament-actions.ts`, `settings/actions.tsx`, `announcements/actions.tsx` |
| Admin sidebar | 11 nav items, no mobile | 7 nav items, hamburger + overlay on mobile | `sidebar.tsx`, `layout.tsx` |
| Disputes page | Standalone page (248 lines) | Tab within Matches page | `/app/disputes/` → merge into `/app/matches/` |
| Walkovers page | Standalone page (117 lines) | Tab within Matches page | `/app/walkovers/` → merge into `/app/matches/` |
| Challenges admin page | Standalone page (302 lines) | Remove admin challenge management or merge into Matches | `/app/challenges/` |
| Tournament actions | 1,993 lines, one file | Split into 3 files: `tournament-core.ts`, `tournament-bracket.ts`, `tournament-elo.ts` | `tournament-actions.ts` |
| Settings page | Profile + platform settings + about | Just current user info + logout | `/app/settings/` |
| Dashboard stats | 7 parallel queries | 4 queries: players, pending, disputes, recent matches | `dashboard/page.tsx` |
| Player approval | Multi-field update (status, eligibility, active_flag, role) | Single action: approve as competitive or recreational | `actions.ts:approvePlayer` |
| Inline action files | 9 separate files duplicating lib/actions.ts | Remove inline files. Import from lib. | 9 files in `/app/*/actions.tsx` |

---

## 5. KEEP

| What | Why | Location |
|---|---|---|
| Elo rating engine | DO NOT TOUCH. Correct, sophisticated, battle-tested. | `packages/shared/src/elo/engine.ts` |
| `apply_match_result()` DB function | Atomic Elo update. Critical for data integrity. | `00003_functions.sql:90-266` |
| Challenge system (player) | Core engagement loop. Daily competitive play. | `/apps/player/src/app/challenges/`, player `actions.ts` |
| Dispute system | Essential for competitive integrity. | `/apps/admin/src/app/disputes/`, `resolveDispute` action |
| Walkover system | Handles no-shows and withdrawals. | `/apps/admin/src/app/walkovers/`, walkover actions |
| Tournament bracket generation | Core feature. Well-built. | `tournament-actions.ts:637-860` |
| Tournament score entry + Elo | Correctly advances brackets and applies rated Elo. | `tournament-actions.ts:969-1424` |
| Audit logging | Essential for governance. Embedded in every action. | `audit_logs` table, all action files |
| Seasons system | Required for Elo season resets. Minimal code. | `/apps/admin/src/app/seasons/` |
| Player leaderboard | Core engagement — players want rankings. | `/apps/player/src/app/leaderboard/` |
| Email notification system | Resend integration with templates. | `packages/shared/src/email/` |
| In-app notifications (player) | Challenge notifications, results, etc. | `/apps/player/src/app/notifications/` |
| Player onboarding flow | Clean: login → form → pending approval. | `/apps/player/src/app/onboarding/` |
| Zod validation schemas | 10 schemas defined. Need to actually use them. | `packages/shared/src/validators/schemas.ts` |
| RLS policies | Comprehensive row-level security. | `00005_rls.sql` |
| Player app mobile UI | Bottom nav + top bar pattern is solid. | Player components |
| Shared UI library | 17 clean components. Consume only. | `packages/ui/src/components/` |

---

## 6. ADD

| What | Why | Where |
|---|---|---|
| **Real admin auth** | Production blocker. Replace DEV MODE. | New `getAuthenticatedAdmin()` in `supabase-server.ts` |
| **Admin role check in middleware** | Block non-admin users at the edge. | `apps/admin/middleware.ts` |
| **`/unauthorized` page** | Non-admin users need a clear landing. | New page in admin app |
| **Logout button** | Admin sidebar has no way to sign out. | `sidebar.tsx` footer |
| **Admin user display** | Layout has `playerId: null` hardcoded. Show who's logged in. | `layout.tsx`, `sidebar.tsx` |
| **Mobile hamburger menu** | Admin app unusable on mobile without it. | `sidebar.tsx`, `layout.tsx` |
| **Zod validation in server actions** | Schemas exist but `.parse()` is never called. | All action files |
| **Admin "Make Admin" toggle** | Need a way to grant/revoke admin access. | Player detail page |
| **One-click player approval** | "Approve as Competitive" / "Approve as Recreational" buttons. | Dashboard or Players page |
| **Error types** | All errors are generic. Need `AuthError`, `ValidationError`. | New `packages/shared/src/types/errors.ts` |
| **Test infrastructure** | Zero tests. Need Vitest + critical path tests. | Root config + shared package tests |

---

## 7. Best Admin Approval System

### Data Model

Use the existing `role` column on `players` table. No separate table needed.

```
players.role: 'player' | 'admin'    (simplified from 4 values to 2)
```

### Signup/Signin Flow

1. User visits admin app → middleware checks `auth.getUser()`
2. If no session → redirect to `/login`
3. User authenticates via Google OAuth or magic link
4. Middleware checks user's role: `supabase.rpc('is_admin', { p_user_id: user.id })`
5. If `role !== 'admin'` → redirect to `/unauthorized`
6. If `role === 'admin'` → proceed to `/dashboard`

### Pending Users

They see `/unauthorized` page: "You don't have admin access. Contact a club executive."
No pending queue. No request button. Admin access is granted person-to-person, not self-service.

### Granting Admin Access

Any existing admin goes to Players → Player Detail → clicks "Grant Admin Access" toggle.
Sets `players.role = 'admin'`. Audit log records who granted access.

### Revoking Admin Access

Same toggle: "Revoke Admin Access". Sets `players.role = 'player'`.
User is immediately blocked on next request.

### First Admin

Seeded manually in Supabase dashboard:
```sql
UPDATE players SET role = 'admin' WHERE email = 'your@email.com';
```

### Middleware Implementation

```typescript
// apps/admin/middleware.ts — after existing auth.getUser() check
if (user && !isPublicRoute(pathname) && pathname !== '/unauthorized') {
  const { data: isAdmin } = await supabase.rpc('is_admin', { p_user_id: user.id });
  if (!isAdmin) {
    return NextResponse.redirect(new URL('/unauthorized', request.url));
  }
}
```

Uses the existing `is_admin()` DB function which is `SECURITY DEFINER` — no RLS issues.

### Server Action Auth (Single Canonical Function)

```typescript
// apps/admin/src/lib/supabase-server.ts
export async function getAuthenticatedAdmin() {
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('Not authenticated');

  const adminClient = createAdminClient();
  const { data: player } = await adminClient
    .from('players')
    .select('*')
    .eq('user_id', user.id)
    .single();

  if (!player) throw new Error('No player record found');
  if (player.role !== 'admin') throw new Error('Admin access required');

  Sentry.setUser({ id: player.id });
  return player;
}
```

Then every `getAdminPlayer()` across 4 files becomes an import of this one function.
**61 callsites remain unchanged. Only the function internals change.**

### Routes Needed

| Route | Purpose | New? |
|---|---|---|
| `/login` | Existing. No changes needed. | No |
| `/auth/callback` | Existing. No changes needed. | No |
| `/unauthorized` | Simple page: "Admin access required." | **Yes** |
| `/dashboard` | Existing. Now only accessible to admins. | No |

---

## 8. Best Player Model

### Status Simplification

| Current | Proposed | Migration |
|---|---|---|
| `eligible_competitive` | `competitive` | Rename |
| `competitive_associate` | `competitive` | Merge |
| `recreational` | `recreational` | Keep |
| `alumni_external` | *(remove)* | Set to suspended or recreational |
| `suspended` | `suspended` | Keep |
| `inactive` | *(derive from `last_active_at`)* | Don't store as status. Query by date. |
| `pending_approval` | `pending_approval` | Keep |

**Final `PlayerStatus`: `competitive` | `recreational` | `pending_approval` | `suspended`**

### What Each Type Affects

| Behavior | Competitive | Recreational |
|---|---|---|
| Appears on leaderboard | Yes | No |
| Elo rating tracked | Yes (full K-factor system) | Yes (but hidden from rankings) |
| Can play rated challenges | Yes | No (casual only) |
| Can join `eligible_only` tournaments | Yes | No |
| Can join `open` tournaments | Yes | Yes |

### Fields to Remove from Player

| Field | Why Remove |
|---|---|
| `eligibility_flag` | Redundant — `competitive` status implies eligible |
| `profile_visibility` | Not used in any UI. Club profiles are public. |
| `hide_from_leaderboard` | Use status: recreational = hidden |
| `show_activity_status` | Not read by any code |
| `notification_preferences` | No UI to configure. No code reads it. |

### Fields to Keep

`id`, `user_id`, `full_name`, `display_name`, `email`, `phone`, `status` (4 values), `role` (2 values), `active_flag`, `onboarding_completed`, `avatar_url`, `bio`, `joined_at`, `last_active_at`, `created_at`, `updated_at`

### Schema Changes

TypeScript (`database.ts`):
```typescript
export type PlayerStatus = 'competitive' | 'recreational' | 'pending_approval' | 'suspended';
export type UserRole = 'player' | 'admin';
```

DB migration:
```sql
UPDATE players SET status = 'competitive' WHERE status IN ('eligible_competitive', 'competitive_associate');
UPDATE players SET status = 'suspended' WHERE status = 'alumni_external';
UPDATE players SET role = 'player' WHERE role IN ('moderator', 'coach_executive');
```

Constants (`constants.ts`):
```typescript
export const PLAYER_STATUS_LABELS: Record<PlayerStatus, string> = {
  competitive: 'Competitive',
  recreational: 'Recreational',
  pending_approval: 'Pending Approval',
  suspended: 'Suspended',
};
```

### Simplified Approval Action

Current `approvePlayer()` takes 4 parameters. Simplify to:
```typescript
export async function approvePlayer(playerId: string, type: 'competitive' | 'recreational') {
  // Sets status to type, active_flag to true. Done.
}
```

Two buttons on the pending player card: **"Approve as Competitive"** / **"Approve as Recreational"**. One click.

---

## 9. Minimum Viable Tournament System

### KEEP (Essential)

| Feature | Function |
|---|---|
| Create tournament | `createTournament` |
| Create event within tournament | `createTournamentEvent` |
| Add/remove participants | `addParticipantToEvent`, `removeParticipantFromEvent`, `addPairToEvent`, `removePairFromEvent` |
| Check-in participants | `checkInParticipant`, `checkInPair`, `bulkCheckIn`, `markParticipantNoShow` |
| Generate single elimination bracket | `generateSingleEliminationBracket` |
| Auto-seed by Elo | `autoSeedEventByElo` |
| Enter match results | `enterMatchResult` |
| Finalize event | `finalizeEvent` |
| Event status transitions | `setEventStatus` |
| Elo integration | `applyTournamentMatchElo` (called inside `enterMatchResult`) |
| Lock/unlock draw | `lockDraw`, `unlockDraw` |

### DEFER (Phase 2)

| Feature | Why Defer | Function |
|---|---|---|
| Round robin format | Single elim covers most cases | `generateRoundRobinMatches`, `computeRoundRobinStandings`, `RoundRobinTab.tsx` |
| Placement bonuses | Nice but not essential | `applyPlacementBonuses` |
| PDF draw sheet | 716 lines. Share a link instead. | `DrawSheetPDF.tsx` |
| Edit match result | Use void + re-enter | `editMatchResult` |
| Undo match result | Admin can void instead | `undoMatchResult` |
| Tournament walkover | Handle manually for now | `enterWalkover` |
| Manual seed editing | Auto-seed by Elo is sufficient | `updateParticipantSeed`, `updatePairSeed` |

### Cleanest Admin Tournament Workflow

1. Create tournament (name, dates, scope)
2. Create events (type, format=single_elimination, max participants)
3. Open registration → Players register from player app
4. Close registration → Admin reviews participants
5. Auto-seed by Elo → Generate bracket
6. Lock draw → Open check-in
7. Run tournament → Enter scores per match
8. Finalize → Elo applied, standings published

### Cleanest Player Tournament Experience

1. See upcoming tournaments on `/tournaments`
2. Tap tournament → see events
3. Tap "Register" on an event
4. Day of: self check-in from phone
5. See bracket, find your match
6. After match: see result posted by admin
7. After tournament: see final standings + Elo change

---

## 10. UI/UX Streamlining Recommendations

### Pages to Merge

| Current | Merge Into | Reason |
|---|---|---|
| `/disputes` (248 lines) | `/matches` as a "Disputes" tab | Disputes are about matches. Same context. |
| `/walkovers` (117 lines) | `/matches` as a "Walkovers" tab | Walkovers are a match outcome type. |
| `/challenges` (302 lines, admin) | Remove or merge into `/matches` | Let the player app handle challenge lifecycle. Admin only sees results. |

### Pages to Remove (Defer)

- `/sessions` — admin and player
- `/varsity` — admin only
- `/announcements` — admin and player

### Navigation Improvement (Admin)

Current sidebar: 11 items in 3 groups. Proposed: 7 items in 2 groups:

```
MANAGE
  Dashboard
  Players
  Matches        (absorbs disputes, walkovers, challenges)
  Tournaments

SYSTEM
  Seasons
  Audit Log
  Settings
```

### Mobile Improvements (Admin)

1. **Sidebar → hamburger overlay** on screens < 768px:
   - Hide sidebar. Show fixed hamburger button top-left.
   - Tap opens full-height overlay with backdrop.
   - Tap any link or backdrop → closes.
   - Layout: `ml-0 md:ml-64`

2. **Tables → cards on mobile:**
   - Players, Matches, Audit tables are wide.
   - Use `hidden md:table-cell` to hide less-important columns.
   - Or replace rows with stacked cards on small screens.

3. **Login page fix:** Remove `-ml-64` hack. After responsive layout, it's unnecessary.

### Forms That Need Simplification

| Form | Issue | Fix |
|---|---|---|
| Admin create match (171 lines) | Requires format, type, players, scores in one form | Defer — most matches come from challenges |
| Admin create challenge (121 lines) | Players create challenges, not admins | Remove from admin |
| Player edit (203 lines) | Stats + ratings + reliability + varsity + edit all on one page | Split: read-only view + "Edit" button opens dialog |
| Tournament create event (107 lines) | 7 fields including bracket size, seeding method | Reduce to 4: event type, max participants, format (default single elim), match format (default bo3) |

### High-Friction Flows to Fix

1. **Player approval:** Navigate to Players → find pending → click → change status → change eligibility → change active_flag → save. **Fix:** Dashboard shows pending players with one-click "Approve (Competitive)" / "Approve (Recreational)" buttons.

2. **Tournament participant management:** ParticipantsTab.tsx is 385 lines with inline seed editing, partner selection, bracket size calculations. **Fix:** Simple list + add button + auto-seed only.

3. **Score entry:** ScoreEntryDialog.tsx (215 lines) handles game-by-game entry. **Fix:** Default to "best of 3 to 21" with just score inputs, not format selection.

---

## 11. Vercel-First Technical Priorities

### Do Now

| Task | Why |
|---|---|
| Remove `output: 'standalone'` from admin `next.config.js` | Standalone is for Docker. Vercel uses its own build. |
| Do NOT add `output: 'standalone'` to player app | Same — Vercel doesn't need it. |
| Keep `force-dynamic` on all pages | Correct for SSR with live Supabase data. |
| Scrub `.env.example` | Real credentials committed. Rotate and replace with placeholders. |
| Configure Vercel env vars | Set all `NEXT_PUBLIC_*` and server env vars in Vercel dashboard. |
| Configure Vercel projects | Each app = separate Vercel project. Root directory: `apps/admin` and `apps/player`. |

### Postpone

| Task | Why |
|---|---|
| Docker/Dockerfiles | Moving to Vercel. No containers needed. |
| docker-compose.yml | Same. |
| Nginx configuration | Vercel handles routing and SSL. |
| Raspberry Pi deployment | Superseded by Vercel. |
| Health check endpoints | Vercel has built-in monitoring. |
| PM2 process management | Not relevant for Vercel. |

### Vercel Optimizations for Later

| Task | When |
|---|---|
| ISR for stable pages (seasons, completed tournaments) | After MVP — add `revalidate` exports |
| Vercel Analytics / Speed Insights | Free tier, easy to add post-launch |
| Vercel Cron for challenge expiry | Replace manual expiry with cron |

---

## 12. Recommended Implementation Roadmap

### Phase 1: Auth Fix + Credential Rotation

**Objective:** Make the admin app production-safe. No unauthorized access.

**Why it matters:** Currently anyone authenticated is treated as admin. This is the only true security vulnerability.

**Code areas:**
- `apps/admin/src/lib/supabase-server.ts` — add `getAuthenticatedAdmin()`
- `apps/admin/src/lib/actions.ts:12-24` — replace DEV MODE
- `apps/admin/src/lib/tournament-actions.ts:4,30-42` — add import, replace DEV MODE
- `apps/admin/src/app/settings/actions.tsx:3,6-16` — replace
- `apps/admin/src/app/announcements/actions.tsx:3,15-25` — replace
- `apps/admin/src/app/settings/page.tsx:2,7-15` — replace inline query
- `apps/admin/middleware.ts` — add `is_admin` RPC check
- `apps/admin/src/app/unauthorized/page.tsx` — new page
- `.env.example` — scrub credentials

**Success:** Only users with `role = 'admin'` can access admin pages and actions. Audit logs record the real actor. `.env.example` has no real keys.

---

### Phase 2: Simplify Data Model

**Objective:** Reduce status/role enum complexity. Clean types.

**Why it matters:** Every form, filter, and query handles 7 statuses and 4 roles. Cutting to 4 statuses and 2 roles simplifies everything.

**Code areas:**
- `packages/shared/src/types/database.ts` — simplify `PlayerStatus` and `UserRole`
- `packages/shared/src/utils/constants.ts` — update labels
- `packages/shared/src/utils/helpers.ts` — remove `isAdminOrCoach`, `canModerate`
- `packages/shared/src/validators/schemas.ts` — update `adminPlayerUpdateSchema`
- `apps/admin/src/app/players/page.tsx` — simplify tabs (Competitive / Recreational / Pending)
- `apps/admin/src/app/players/[id]/page.tsx` — simplify edit form
- `apps/admin/src/lib/actions.ts:approvePlayer` — simplify to 2-param version
- Supabase migration — update enum values, migrate existing data

**Success:** TypeScript compiles. Player statuses make sense. Approval is one click.

---

### Phase 3: Remove Bloat Features

**Objective:** Delete deferred features. Fewer pages, less code, less to maintain.

**Why it matters:** Keeping dead features creates maintenance burden and slows builds.

**Code areas to remove/defer:**
- `apps/admin/src/app/varsity/` — delete
- `apps/admin/src/app/sessions/` — delete
- `apps/admin/src/app/announcements/` — delete
- `apps/player/src/app/sessions/` — delete
- `apps/player/src/app/announcements/` — delete
- `DrawSheetPDF.tsx` — delete
- `actions.ts` — remove varsity/session functions
- `sidebar.tsx` — remove Sessions, Varsity, Announcements from nav
- Merge Disputes + Walkovers into Matches page

**Success:** Sidebar has 7 items. `turbo build` succeeds. No dead imports.

---

### Phase 4: Mobile Responsive Admin

**Objective:** Admin app works on phones and tablets.

**Why it matters:** Admins run tournaments in a gym with their phone.

**Code areas:**
- `apps/admin/src/components/sidebar.tsx` — add `mobileOpen` state, hamburger, overlay + backdrop, close on navigation
- `apps/admin/src/app/layout.tsx:32` — change `ml-64` to `md:ml-64`
- `apps/admin/src/app/login/page.tsx:45` — remove `-ml-64` hack
- Add user info + logout to sidebar footer

**Success:** Usable on 375px screens. Hamburger works. Login centered. Logout available.

---

### Phase 5: Player Approval UX

**Objective:** Streamline how admins approve new players.

**Why it matters:** Most frequent admin action. Should be fast and obvious.

**Code areas:**
- `apps/admin/src/app/dashboard/page.tsx` — add pending approval cards with one-click buttons
- `apps/admin/src/lib/actions.ts` — simplify `approvePlayer` signature
- `apps/admin/src/app/players/page.tsx` — simplify Pending tab

**Success:** Admin sees pending players on dashboard, taps "Approve as Competitive" or "Approve as Recreational", done.

---

### Phase 6: Vercel Deployment

**Objective:** Both apps deployed on Vercel, working in production.

**Why it matters:** Vercel is more reliable, faster, and simpler than Raspberry Pi.

**Code areas:**
- `apps/admin/next.config.js` — remove `output: 'standalone'`
- Vercel dashboard — create 2 projects, configure env vars, set root directories
- DNS — update Cloudflare records to point to Vercel
- Test full auth flow on deployed URLs

**Success:** Both apps live on Vercel with working auth and correct environment variables.

---

### Phase 7: Testing Foundation

**Objective:** Vitest configured, critical paths tested.

**Why it matters:** Zero tests means zero confidence in changes.

**Code areas:**
- Root: `vitest.config.ts`, `turbo.json` (add test task)
- `packages/shared/src/validators/schemas.test.ts` — test all 10 Zod schemas
- `packages/shared/src/elo/engine.test.ts` — test Elo calculations
- `apps/admin/src/lib/__tests__/auth.test.ts` — test `getAuthenticatedAdmin()`

**Success:** `turbo test` passes. Key business logic has coverage.

---

### Phase 8: Tournament Polish

**Objective:** Tournament flow is smooth and ready for a real event.

**Why it matters:** Flagship feature.

**Code areas:**
- Wire Zod validation into tournament server actions
- Add loading states to all tournament forms
- Test full lifecycle: create → register → check-in → bracket → scores → finalize
- Verify Elo changes after finalization
- Simplify ParticipantsTab.tsx (remove manual seed editing for MVP)

**Success:** Admin can run a full tournament on their phone without errors.

---

## 13. Highest-Risk Technical/Product Issues to Fix First

In order of severity:

1. **DEV MODE auth bypass** — `actions.ts:12-24` and 3 other files. Any logged-in user is admin. Every action executes as the wrong person. Audit logs record the wrong actor. **Fix in Phase 1.**

2. **Exposed credentials in git** — `.env.example` contains real Supabase service role key (full DB access) and Resend API key. Anyone with repo access can read/write all data. **Fix in Phase 1.**

3. **No admin role enforcement** — Middleware only checks login, not role. Even after fixing `getAdminPlayer()`, server-rendered pages still show data to non-admin users via `createAdminClient()` in page components. **Fix in Phase 1.**

4. **Zero input validation in server actions** — All 57+ actions accept raw parameters without Zod validation despite schemas being defined. **Fix in Phase 5/8.**

5. **Admin app unusable on mobile** — Sidebar overlaps content on <768px. Admins running tournaments on their phone see a broken layout. **Fix in Phase 4.**

6. **`inactive` as stored status vs derived state** — No automatic mechanism to restore "inactive" players. Better to derive from `last_active_at`. **Fix in Phase 2.**

7. **`tournament-actions.ts` is 1,993 lines** — Single file with 31 functions. A change to any function risks breaking unrelated logic. **Split later.**

8. **Duplicate action definitions** — Functions like `resolveDispute`, `voidMatch`, `confirmWalkover` exist in both `/lib/actions.ts` AND inline `actions.tsx` files. **Fix in Phase 3.**
