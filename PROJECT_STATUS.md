# Badminton Platform - Comprehensive Project Status

**Last Updated:** April 8, 2026
**Project Status:** Pre-Production (Auth fixed, Mobile done, Player app features complete, security hardened, DB migrations current, Vercel deploy pending)
**Live Deployment:** `admin.badminton.polardev.org:3010`

---

## 📊 QUICK STATS

| Metric | Count | Status |
|--------|-------|--------|
| Admin Pages | 19 | ✅ All Built |
| Server Actions | 30+ | ✅ All Built |
| Database Tables | 18+ | ✅ All Built + Security Hardened |
| Migrations | 18 | ✅ All Applied |
| Components | 25+ | ✅ All Built |
| Test Files | 2+ | 🟡 In Progress |
| UI Library | 1 | ✅ Shared Package |
| Deployed Instances | 1 | ✅ Raspberry Pi |

---

## 🆕 RECENT CHANGES (April 7–8, 2026)

### Security Hardening — Full Audit (2026-04-07, commits `3c26f9f`, `630cbe7`)

A comprehensive security audit (`CLAUDE-SECURITY.md`) and resulting hardening pass covered the entire request path: frontend → middleware → server action → database/RLS.

#### Secrets & Server Isolation
- ✅ `server-only` import added to `supabase-server.ts` in both admin and player apps — any accidental client-bundle import now **fails the build**
- ✅ `SUPABASE_SERVICE_ROLE_KEY` confirmed absent from all `NEXT_PUBLIC_*` slots; env files gitignored and untracked

#### `toClientError` / Safe Error Helper (`packages/shared/src/utils/safe-error.ts`)
- ✅ New `toClientError(err, context)` helper sanitizes raw DB/system errors before they reach the client
- ✅ Raw error routed to Sentry; client receives only a generic safe message
- ✅ Adopted across all server actions in both apps

#### Rate Limiting (`packages/shared/src/utils/rate-limit.ts`)
- ✅ In-memory rate limiter added (sliding window, configurable limit/window)
- ✅ Applied to: `submitMatchResult`, `createChallenge`, `checkInToSession`, `reportWalkover`, `joinTournamentEvent`, `updateAvatar`
- ✅ Limits enforced per `user_id` server-side; counters not client-controllable

#### Avatar Update — Server Action Migration
- ✅ Avatar URL update moved from direct client write → validated server action
- ✅ URL allowlist enforced (only Supabase Storage URLs accepted)
- ✅ Ownership check: caller must own the player row

#### CSP & Security Headers
- ✅ `Content-Security-Policy` header added to both `apps/admin/next.config.js` and `apps/player/next.config.js`
- ✅ Existing headers retained: `Strict-Transport-Security`, `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`

#### RLS Hardening Migrations
- ✅ **`00016_rls_with_check_hardening.sql`** — Tightened `WITH CHECK` on: `matches_insert` (submitter only), `mp_insert`/`mg_insert` (must own parent match), `cp_insert` (own player_id), `matches_update` (WITH CHECK mirrors USING), `notifications_update`, `challenges_update_own`, `audit_insert` (admin only)
- ✅ **`00017_security_hardening.sql`** — `audit_logs` made append-only via policy + trigger (blocks UPDATE/DELETE for all roles, including SECURITY DEFINER paths); `UNIQUE(match_id, player_id)` constraint on `match_participants`; `search_path` pinned on all `SECURITY DEFINER` functions to block schema-hijack attacks

#### Unbounded Query Fixes
- ✅ Sessions page: query now bounded (no full-table scan)
- ✅ Announcements page: query now bounded

---

### Vibe-Security Audit Follow-Up (2026-04-08)
- ✅ **`00018_matches_update_column_guard.sql`** — BEFORE UPDATE trigger `enforce_matches_update_scope()` added on `matches`; service_role/admin/submitter have full update rights; non-privileged participants may only flip `result_status → 'disputed'` (the one legitimate player-side write); all other column mutations by participants are rejected at the DB level

---

### Tournament System Hardening (2026-04-07, commit `630cbe7`)

#### Revalidation Fixes
- ✅ New `revalidateEventPaths()` helper revalidates both `/tournaments` list and `/tournaments/[id]/events/[eventId]` — fixes stale UI after mutations (add player, open check-in, enter results)
- ✅ `checkInParticipant` / `checkInPair` now revalidate event paths
- ✅ `addPairToEvent` was revalidating wrong path — fixed
- ✅ `removeParticipantFromEvent`, `removePairFromEvent`, `autoSeedEventByElo`, `generateSingleEliminationBracket`, `generateRoundRobinMatches`, `enterMatchResult`, `voidMatch`, `setEventStatus` all revalidate event detail

#### Walkover Elo Gap
- ✅ `enterWalkover` now calls `applyTournamentMatchElo` — walkovers were previously not applying Elo at all

#### New Migrations Applied
- ✅ **`00013_tournament_match_elo_snapshot.sql`** — ELO snapshot stored per tournament match
- ✅ **`00014_tournament_draw_locked_and_points.sql`** — Draw lock flag + tournament points columns
- ✅ **`00015_tournament_perf_indexes.sql`** — Performance indexes for tournament queries

#### Loading States Added
- ✅ `apps/admin/src/app/dashboard/loading.tsx`
- ✅ `apps/admin/src/app/tournaments/loading.tsx`
- ✅ `apps/admin/src/app/tournaments/[id]/loading.tsx`
- ✅ `apps/player/src/app/leaderboard/loading.tsx`
- ✅ `apps/player/src/app/my-stats/loading.tsx`
- ✅ `apps/player/src/app/tournaments/loading.tsx`
- ✅ `apps/admin/src/app/tournaments/error.tsx`
- ✅ `apps/player/src/app/tournaments/error.tsx`

#### Auth Callback Hardened
- ✅ Both `apps/admin/src/app/auth/callback/route.ts` and `apps/player/src/app/auth/callback/route.ts` hardened

---

### Player App — UI/UX Consistency Pass (2026-04-07, commits `98a8b73`, `be992b7`, `c066b48`)

A major visual overhaul brought all player-facing pages to a consistent design language:

#### Pages Updated
- ✅ `challenges/page.tsx` — consistent card layout, badge colors fixed
- ✅ `challenges/[id]/page.tsx` — **UI color bugs resolved**: `accepted` → green, positive `rating_delta` → green, `confirmed` result distinct from `disputed`, win Elo preview green; `cancelled`/`expired`/`walkover_confirmed`/`walkover_pending` status styles added
- ✅ `challenges/new/page.tsx` — Elo delta preview colors fixed
- ✅ `feed/page.tsx` — redesigned feed cards
- ✅ `leaderboard/page.tsx` + `leaderboard/[playerId]/page.tsx` — unified leaderboard appearance
- ✅ `my-stats/page.tsx` — stat cards redesigned; build error fixed (dashboard query)
- ✅ `notifications/page.tsx` + `notifications/actions.tsx` — consistent notification item design
- ✅ `sessions/page.tsx` — updated session cards; check-in button + add-to-calendar polished
- ✅ `settings/page.tsx` — settings layout updated
- ✅ `tournaments/page.tsx` + `tournaments/[id]/page.tsx` + `tournaments/[id]/events/[eventId]/page.tsx` — tournament pages fully redesigned; event actions, self check-in, registration button updated
- ✅ `announcements/page.tsx` + `announcement-item.tsx` — consistent announcement style
- ✅ `onboarding/page.tsx` — onboarding flow updated
- ✅ `login/page.tsx` — login page polished

#### Components Updated
- ✅ `bottom-nav.tsx` — consistent active/inactive state styling
- ✅ `top-bar.tsx` — polished top bar appearance
- ✅ `AvatarUpload.tsx` — styling update
- ✅ `OfflineBanner.tsx` — styling update

#### Shared UI Package Updates
- ✅ `Avatar.tsx`, `Badge.tsx`, `Dialog.tsx`, `Input.tsx`, `Switch.tsx`, `Tabs.tsx` — minor consistency fixes
- ✅ `button.tsx` (player app local) — updated
- ✅ `globals.css` — major CSS variable expansion; consistent color tokens across all pages
- ✅ `tailwind.config.ts` — updated color palette references

---

---

# ✅ FULLY IMPLEMENTED FEATURES

## Admin Pages (19 Total)

### Dashboard
- ✅ Main overview with stat cards (players, approvals, disputes, walkovers)
- ✅ Alert banner for items needing attention
- ✅ Current session display
- ✅ Active challenges count
- ✅ Recent matches list with scores and status

### Player Management
- ✅ `players/page.tsx` - List all players with tabs (competitive, recreational, needs attention)
- ✅ Player search/filter by name
- ✅ Status badges (eligible_competitive, suspended, inactive, etc.)
- ✅ Player action buttons (edit, delete)
- ✅ Count badges on tabs
- ✅ `players/[id]/page.tsx` - Individual player detail page
- ✅ Player stats (singles ELO, doubles ELO, W/L records)
- ✅ Reliability metrics (challenges issued, no-shows, disputes)
- ✅ Varsity notes section
- ✅ Recent matches history
- ✅ Edit player form with status/eligibility updates

### Match Management
- ✅ `matches/page.tsx` - List all matches
- ✅ Match players display (side A vs side B)
- ✅ Score summary
- ✅ Match type (rated/casual)
- ✅ ELO delta display (green for win, red for loss)
- ✅ Result status badges (confirmed, disputed, voided, pending)
- ✅ Inline dispute/walkover indicators
- ✅ Create match dialog with player selection
- ✅ Match action buttons (edit scores, record results)

### Tournament Management
- ✅ `tournaments/page.tsx` - List tournaments
- ✅ Tournament filters by status (draft, active, completed)
- ✅ Event count per tournament
- ✅ Format/scope/multiplier display
- ✅ Create tournament form
- ✅ `tournaments/[id]/page.tsx` - Tournament detail view
- ✅ Event list with participant counts
- ✅ Event status display
- ✅ Create event button (draft tournaments only)
- ✅ `tournaments/[id]/events/[eventId]/page.tsx` - Event control center with 8 tabs:
  - ✅ **Bracket Tab** - Tournament bracket visualization
  - ✅ **Participants Tab** - Player/pair registration list
  - ✅ **CheckIn Tab** - Player check-in management
  - ✅ **Results Tab** - Match results entry
  - ✅ **Leaderboard Tab** - Rankings/standings
  - ✅ **Draw Sheet Tab** - PDF export functionality
  - ✅ **Round Robin Tab** - Round robin standings (if applicable)
  - ✅ **Settings Tab** - Event configuration

### Challenge Management
- ✅ `challenges/page.tsx` - List all challenges
- ✅ Challenge creator display
- ✅ Participants list
- ✅ Challenge type (singles/doubles)
- ✅ Challenge format
- ✅ Status badges with icons (proposed, accepted, completed, disputed, etc.)
- ✅ Created date display
- ✅ Create challenge form with player selection
- ✅ Challenge action buttons

### Dispute Resolution
- ✅ `disputes/page.tsx` - Dispute resolution center
- ✅ Dispute status (open, resolved)
- ✅ Reason categories
- ✅ Description of dispute
- ✅ Opened by player display
- ✅ Match info reference
- ✅ Resolution notes (if resolved)
- ✅ Resolve dispute button and form
- ✅ Color-coded status borders

### Walkover Management
- ✅ `walkovers/page.tsx` - Walkover requests list
- ✅ Status display (pending, confirmed, rejected)
- ✅ Walkover type (no_show, late_cancellation)
- ✅ Reporter display
- ✅ Forfeiting player
- ✅ Notice hours (advance cancellation notice)
- ✅ Admin notes field
- ✅ Approve/reject actions
- ✅ Pending badge on header

### Session Management
- ✅ `sessions/page.tsx` - Practice session scheduling
- ✅ Session list with date, location, status
- ✅ Host player display
- ✅ Attendance count
- ✅ Create session form
- ✅ Session action buttons (close, delete)

### Season/Calendar
- ✅ `seasons/page.tsx` - Season management
- ✅ Season list (start date, end date)
- ✅ Active/inactive/ended status
- ✅ Create season form
- ✅ Set active season button
- ✅ CSS variables properly defined

### Announcements
- ✅ `announcements/page.tsx` - Announcement management
- ✅ Announcement list with composer
- ✅ Rich text editor
- ✅ Type selection (info, warning, urgent, event)
- ✅ Pinned announcements
- ✅ Status (published, draft, expired)
- ✅ Target audience selection
- ✅ Create/delete functionality
- ✅ Author display
- ✅ Created date

### Varsity Management
- ✅ `varsity/page.tsx` - Varsity team evaluation
- ✅ Eligible competitive players ranked by varsity index
- ✅ Singles/doubles ELO display
- ✅ Win/loss records
- ✅ Varsity index calculation
- ✅ Reliability status (good/flagged for no-shows)
- ✅ Add varsity notes functionality
- ✅ Notes section with author and date

### Settings & Configuration
- ✅ `settings/page.tsx` - Admin settings
- ✅ Profile section showing current admin
- ✅ Platform settings form (if admin)
- ✅ About section with app version
- ✅ Supabase URL display

### Audit Log
- ✅ `audit/page.tsx` - Audit trail viewer
- ✅ All admin actions logged
- ✅ Actor (admin who performed action)
- ✅ Action type (tournament_created, player_approved, etc.)
- ✅ Target type and ID
- ✅ Timestamp display
- ✅ Colored badges by action type

### Authentication
- ✅ `login/page.tsx` - Login page with OAuth2
- ✅ Google OAuth sign-in button
- ✅ Magic link email option
- ✅ Redirect after successful auth

---

## Server Actions (Core Business Logic)

### Player Operations
- ✅ `approvePlayer()` - Approve pending registrations with status/eligibility
- ✅ `updatePlayer()` - Update player profile, status, role, eligibility
- ✅ `removePlayer()` - Soft delete player
- ✅ `createPlayer()` - Create new player with initial ratings
- ✅ `createAdminPlayer()` - Add player directly by admin

### Match Operations
- ✅ `createMatch()` - Create new match with participants
- ✅ `recordScore()` - Record match score and result
- ✅ `updateMatchScore()` - Update existing match score
- ✅ `voidMatch()` - Void/cancel match results
- ✅ ELO rating delta calculations

### Challenge Operations
- ✅ `createChallenge()` - Create head-to-head challenge
- ✅ `acceptChallenge()` - Accept challenge request
- ✅ `rejectChallenge()` - Reject challenge
- ✅ Challenge status transitions

### Dispute Operations
- ✅ `resolveDispute()` - Resolve contested result
- ✅ Dispute creation and tracking
- ✅ Resolution type selection (confirmed, voided, other)
- ✅ Resolution note recording

### Walkover Operations
- ✅ `approveWalkover()` - Approve no-show/cancellation
- ✅ `rejectWalkover()` - Reject walkover claim
- ✅ Notice hours recording

### Session Operations
- ✅ `createSession()` - Create practice session
- ✅ `closeSession()` - Close session for check-in
- ✅ `deleteSession()` - Remove session

### Season Operations
- ✅ `createSeason()` - Create new season/period
- ✅ `setActiveSeason()` - Mark season as active
- ✅ `closeSeason()` - End season

### Tournament Operations
- ✅ `createTournament()` - Create tournament with config
- ✅ `updateTournament()` - Update tournament details
- ✅ `createTournamentEvent()` - Add event to tournament
- ✅ `updateTournamentEvent()` - Modify event
- ✅ `registerTournamentParticipant()` - Register player/pair
- ✅ `unregisterParticipant()` - Withdraw registration
- ✅ `checkInParticipant()` - Self check-in at event
- ✅ `updateSeedNumber()` - Set tournament seeding
- ✅ `generateBracket()` - Auto-generate bracket
- ✅ `updateTournamentMatch()` - Record match result in bracket
- ✅ `publishTournament()` - Transition from draft to active

### Announcement Operations
- ✅ `publishAnnouncement()` - Create and publish announcement
- ✅ `saveDraftAnnouncement()` - Save draft announcement
- ✅ `deleteAnnouncement()` - Remove announcement

### All Actions Include
- ✅ Audit logging (actor_id, action_type, target_type, target_id, new_value)
- ✅ Sentry error tracking
- ✅ Try-catch error handling
- ✅ revalidatePath for cache invalidation
- ✅ Proper error messages thrown

---

## Database Schema (12 Tables)

### Players
- ✅ `id` (UUID primary key)
- ✅ `full_name` (string)
- ✅ `email` (unique string)
- ✅ `display_name` (string, optional — shown instead of full_name if set)
- ✅ `status` (enum: **competitive, recreational, pending_approval, suspended** — simplified from 7 in Phase 2)
- ✅ `role` (enum: **player, admin** — simplified from 4 in Phase 2)
- ✅ `hide_from_leaderboard` (boolean)
- ✅ `show_activity_status` (boolean)
- ✅ `eligibility_flag` (boolean)
- ✅ `active_flag` (boolean)
- ✅ `avatar_url` (string, optional)
- ✅ `user_id` (foreign key to auth.users)
- ✅ Relationships: has many ratings, matches, challenges, sessions, etc.

### Ratings
- ✅ `player_id` (foreign key)
- ✅ `singles_elo` (integer, default 1200)
- ✅ `doubles_elo` (integer, default 1200)
- ✅ `singles_provisional` (boolean)
- ✅ `doubles_provisional` (boolean)
- ✅ `singles_wins`, `singles_losses` (integers)
- ✅ `doubles_wins`, `doubles_losses` (integers)
- ✅ `singles_points_scored`, `singles_points_allowed` (integers)
- ✅ `doubles_points_scored`, `doubles_points_allowed` (integers)
- ✅ `current_singles_streak`, `best_singles_streak` (integers)
- ✅ Updated after each match

### Matches
- ✅ `id` (UUID)
- ✅ `challenge_id` (foreign key, optional)
- ✅ `format` (enum: singles, doubles)
- ✅ `score_summary` (string e.g., "21-19, 21-17")
- ✅ `result_status` (enum: pending, confirmed, disputed, voided)
- ✅ `match_type` (string: rated, casual)
- ✅ `rated_flag` (boolean)
- ✅ `winner_side` (enum: a, b)
- ✅ `played_at` (timestamp)
- ✅ `created_at` (timestamp)

### Match_Participants
- ✅ `player_id` (foreign key)
- ✅ `match_id` (foreign key)
- ✅ `team_side` (enum: a, b)
- ✅ `rating_delta` (integer, ELO change)
- ✅ `win_flag` (boolean)

### Match_Games
- ✅ `match_id` (foreign key)
- ✅ `game_number` (integer: 1, 2, 3)
- ✅ `side_a_score`, `side_b_score` (integers)

### Challenges
- ✅ `id` (UUID)
- ✅ `created_by` (player_id)
- ✅ `type` (enum: singles, doubles)
- ✅ `format` (enum: best_of_3, best_of_1)
- ✅ `status` (enum: proposed, partially_confirmed, accepted, completed, rejected, expired, cancelled, disputed, walkover_pending)
- ✅ `rated_flag` (boolean)
- ✅ `created_at`, `expires_at` (timestamps)

### Challenge_Participants
- ✅ `challenge_id` (foreign key)
- ✅ `player_id` (foreign key)
- ✅ `confirmed_flag` (boolean)

### Disputes
- ✅ `id` (UUID)
- ✅ `match_id` (foreign key)
- ✅ `opened_by` (player_id)
- ✅ `status` (enum: open, resolved)
- ✅ `reason_category` (string)
- ✅ `description` (text)
- ✅ `resolution_type` (string)
- ✅ `resolution_note` (text)
- ✅ `created_at` (timestamp)

### Walkovers
- ✅ `id` (UUID)
- ✅ `challenge_id` (foreign key)
- ✅ `reported_by` (player_id)
- ✅ `forfeit_player_id` (player_id)
- ✅ `status` (enum: pending, confirmed, rejected)
- ✅ `walkover_type` (enum: no_show, late_cancellation, injury)
- ✅ `notice_hours` (integer)
- ✅ `admin_notes` (text)
- ✅ `reported_at` (timestamp)

### Sessions
- ✅ `id` (UUID)
- ✅ `name` (string)
- ✅ `date` (date)
- ✅ `location` (string)
- ✅ `host_player_id` (foreign key)
- ✅ `status` (enum: open, closed)
- ✅ `created_at` (timestamp)

### Session_Attendance
- ✅ `player_id` (foreign key)
- ✅ `session_id` (foreign key)
- ✅ `checked_in_at` (timestamp)

### Seasons
- ✅ `id` (UUID)
- ✅ `name` (string)
- ✅ `start_date`, `end_date` (dates)
- ✅ `active_flag` (boolean)

### Tournaments
- ✅ `id` (UUID)
- ✅ `name` (string)
- ✅ `scope` (enum: eligible_only, open)
- ✅ `type` (string)
- ✅ `format` (string)
- ✅ `start_date`, `end_date` (dates)
- ✅ `bracket_size` (integer: 8, 16, 32)
- ✅ `event_multiplier` (float)
- ✅ `placement_bonus_enabled` (boolean)
- ✅ `status` (enum: draft, active, completed)
- ✅ `season_id` (foreign key)
- ✅ `created_by` (player_id)

### Tournament_Events
- ✅ `id` (UUID)
- ✅ `tournament_id` (foreign key)
- ✅ `event_type` (enum: mens_singles, womens_singles, mixed_doubles, etc.)
- ✅ `format` (enum: single_elimination, round_robin, pools)
- ✅ `match_format` (enum: best_of_1, best_of_3)
- ✅ `status` (enum: open, closed, completed)
- ✅ `max_participants` (integer)

### Tournament_Participants
- ✅ `id` (UUID)
- ✅ `event_id` (foreign key)
- ✅ `player_id` (foreign key)
- ✅ `seed_number` (integer)
- ✅ `status` (enum: registered, checked_in, withdrawn)
- ✅ `registration_date` (timestamp)

### Tournament_Pairs (for doubles)
- ✅ `id` (UUID)
- ✅ `event_id` (foreign key)
- ✅ `player1_id`, `player2_id` (foreign keys)
- ✅ `seed_number` (integer)
- ✅ `status` (enum: registered, checked_in, withdrawn)

### Tournament_Matches
- ✅ `id` (UUID)
- ✅ `event_id` (foreign key)
- ✅ `round_number` (integer)
- ✅ `bracket_position` (integer)
- ✅ `participant1_id`, `participant2_id` (foreign keys)
- ✅ `winner_id` (foreign key, nullable)
- ✅ `status` (enum: pending, completed, bye, abandoned)
- ✅ `score_summary` (string)

### Announcements
- ✅ `id` (UUID)
- ✅ `author_id` (player_id)
- ✅ `title` (string)
- ✅ `body` (text)
- ✅ `type` (enum: info, warning, urgent, event)
- ✅ `status` (enum: published, draft, expired)
- ✅ `pinned` (boolean)
- ✅ `send_push` (boolean)
- ✅ `target_audience` (string)
- ✅ `created_at`, `expires_at` (timestamps)

### Audit_Logs
- ✅ `id` (UUID)
- ✅ `actor_id` (player_id)
- ✅ `action_type` (string)
- ✅ `target_type` (string)
- ✅ `target_id` (string)
- ✅ `old_value`, `new_value` (JSON)
- ✅ `reason` (string, optional)
- ✅ `created_at` (timestamp)

### Varsity_Notes
- ✅ `id` (UUID)
- ✅ `player_id` (foreign key)
- ✅ `author_id` (player_id)
- ✅ `note` (text)
- ✅ `created_at` (timestamp)

### Reliability_Metrics
- ✅ `player_id` (foreign key)
- ✅ `challenges_issued` (integer)
- ✅ `matches_completed` (integer)
- ✅ `no_shows` (integer)
- ✅ `late_cancellations` (integer)
- ✅ `dispute_involvement_count` (integer)
- ✅ `walkover_flag` (boolean)

### Platform_Settings
- ✅ `key` (string, primary key)
- ✅ `value` (JSON)
- ✅ `updated_by` (player_id)
- ✅ `updated_at` (timestamp)

---

## UI Components (25+ Components)

### Layout & Providers
- ✅ `layout.tsx` - Root layout with providers
- ✅ `sidebar.tsx` - Main navigation sidebar
- ✅ `error.tsx` - Global error boundary
- ✅ `toast-provider.tsx` - Toast notifications
- ✅ `sentry-user-init.tsx` - Error tracking init

### Shared from @badminton/ui
- ✅ Card - Container component
- ✅ Badge - Status/type badges
- ✅ Avatar - Player avatar with initials fallback
- ✅ Button - Primary, secondary, ghost, danger variants
- ✅ Input - Text input field
- ✅ Select - Dropdown selection
- ✅ Textarea - Multi-line text
- ✅ Dialog - Modal dialogs
- ✅ Tabs - Tab switching
- ✅ StatCard - Metric display cards

### Tournament Event Tabs (8 Components)
- ✅ BracketTab - Single/double elimination bracket visualization
- ✅ CheckInTab - Player registration and check-in
- ✅ DrawSheetTab - PDF export of draw sheet
- ✅ EventControlCenter - Main event interface
- ✅ EventHeader - Event title/status/metadata
- ✅ LeaderboardTab - Standings/rankings
- ✅ ParticipantsTab - Registered players/pairs
- ✅ ResultsTab - Match results display
- ✅ RoundRobinTab - Round robin standings (if applicable)

### Page-Specific Components
- ✅ announcements/composer.tsx - Rich text editor
- ✅ challenges/create-challenge.tsx - Challenge form
- ✅ disputes/actions.tsx - Dispute resolution form
- ✅ matches/create-match.tsx - Match creation form
- ✅ players/edit-form.tsx - Player edit dialog
- ✅ players/add-player-button.tsx - New player button
- ✅ sessions/actions.tsx - Session management
- ✅ settings/settings-form.tsx - Settings configuration
- ✅ tournaments/create-event.tsx - Event creation
- ✅ tournaments/[id]/participants.tsx - Participant management

---

## Styling & Theme

### CSS System
- ✅ Tailwind CSS configured
- ✅ Custom CSS variables for theme (`globals.css`)
- ✅ Dark theme as default
- ✅ Light theme variant available
- ✅ Theme persistence in localStorage
- ✅ Smooth theme transitions

### CSS Variables Defined
- ✅ `--bg-primary` - Main background
- ✅ `--bg-surface` - Surface background
- ✅ `--bg-card` - Card background
- ✅ `--bg-elevated` - Elevated surfaces
- ✅ `--text-primary` - Primary text
- ✅ `--text-secondary` - Secondary text
- ✅ `--text-muted` - Muted text
- ✅ `--border` - Border color
- ✅ `--border-hover` - Hover border
- ✅ `--color-accent` - Accent color (pink/red)
- ✅ `--color-success` - Success green
- ✅ `--color-warning` - Warning amber
- ✅ `--color-danger` - Danger red
- ✅ `--color-info` - Info blue

### Typography
- ✅ Font imports (Barlow Condensed, DM Sans, JetBrains Mono)
- ✅ Consistent font stack
- ✅ Display font for headings
- ✅ Mono font for numbers/codes

---

## Authentication & Security

### Implemented
- ✅ Supabase Authentication (OAuth2, Magic Link)
- ✅ Middleware auth checks on all routes
- ✅ Automatic redirect to /login for unauthenticated
- ✅ Session cookie management
- ✅ Google OAuth integration
- ✅ Callback handler at /auth/callback (hardened 2026-04-07)
- ✅ Logout via Supabase
- ✅ `server-only` guards on all Supabase server helpers (build fails if imported from client)
- ✅ `toClientError` helper sanitizes all server action errors before client delivery; raw errors sent to Sentry
- ✅ Rate limiting on all mutating server actions (challenge, match submission, check-in, walkover, tournament join, avatar update)
- ✅ CSP headers on both apps (admin + player `next.config.js`)
- ✅ HSTS, X-Frame-Options, Referrer-Policy, Permissions-Policy headers
- ✅ Avatar updates validated server-side: URL allowlist + ownership check enforced
- ✅ RLS `WITH CHECK` tightened across all tables (migrations 00016–00018)
- ✅ `audit_logs` append-only: UPDATE/DELETE blocked via RLS policy + BEFORE trigger for all roles
- ✅ All `SECURITY DEFINER` functions have `search_path = public, pg_temp` pinned (schema-hijack prevention)
- ✅ `UNIQUE(match_id, player_id)` constraint prevents duplicate participant injection
- ✅ `enforce_matches_update_scope` trigger: non-privileged participants may only transition `result_status → 'disputed'`

### Audit Trail
- ✅ All admin actions logged with actor_id
- ✅ Action types: player_approved, tournament_created, etc.
- ✅ Target type and ID tracked
- ✅ Old and new values stored (for updates)
- ✅ Timestamp on all logs
- ✅ Optional reason field
- ✅ Append-only at DB level — immutable once written (migration 00017 + 00018)

---

## Error Handling

### Implemented
- ✅ Global error boundary component
- ✅ Try-catch in all server actions
- ✅ Sentry error tracking integration
- ✅ Toast notifications for user feedback
- ✅ Error reset button on error page
- ✅ Server action error throwing
- ✅ notFound() for missing pages

### Error Cases Handled
- ✅ Player not found (notFound)
- ✅ Duplicate email on registration
- ✅ Invalid status transitions
- ✅ Audit log write failures (logged to Sentry)
- ✅ Missing required fields

---

## Validation

### Server-Side Validation
- ✅ Player email uniqueness check
- ✅ Enum validation for status fields
- ✅ Required field checks
- ✅ Audit log reason required (score disputes)

### Client-Side Validation
- ✅ Email format check in login
- ✅ Form submit disabled on empty required fields
- ✅ Numeric input for ELO ratings
- ✅ Character limits on text areas
- ✅ Reason field 2+ characters required

---

## Third-Party Integrations

### Supabase
- ✅ Authentication (OAuth2, Magic Link)
- ✅ PostgreSQL database
- ✅ Session/cookie management
- ✅ RLS security policies (implied)
- ✅ Real-time subscriptions (capability exists, not used)
- ✅ Service role admin client
- ✅ Public/anon key separation

### Sentry
- ✅ Error tracking configured
- ✅ Conditional init (checks for DSN)
- ✅ User context tracking
- ✅ Source maps hidden in production
- ✅ Tunnel route at /monitoring
- ✅ Audit error logging

### Google OAuth
- ✅ Primary auth method
- ✅ Redirect callback handler

### Libraries
- ✅ Lucide React - Icons
- ✅ jsPDF - PDF generation for draw sheets
- ✅ Next.js 14.2 - Framework
- ✅ React 18.3 - UI library
- ✅ TypeScript - Type safety
- ✅ Tailwind CSS - Styling

---

# ❌ NOT YET IMPLEMENTED

## Critical Gaps (Must Fix Before Production)

### Authentication & Security
- ✅ **Real authentication validation** — FIXED: `getAuthenticatedAdmin()` validates real sessions + admin role
- ✅ **Role-based access control (RBAC)** — FIXED: Middleware calls `is_admin` RPC, redirects non-admins to `/unauthorized`
- ✅ **Rate limiting** — FIXED: In-memory sliding-window rate limiter on all mutation endpoints
- ✅ **RLS WITH CHECK hardening** — FIXED: Migrations 00016–00018 close all permissive insert/update policies
- ✅ **Server-bundle secret exposure** — FIXED: `server-only` guards + confirmed no service_role in `NEXT_PUBLIC_*` slots
- ✅ **Audit log immutability** — FIXED: Append-only enforced at DB trigger level
- ✅ **Client error leakage** — FIXED: `toClientError` sanitizes all errors before they reach the browser

- ❌ **CSRF token protection** — Relies on Next.js Server Actions' built-in origin check (same-origin enforcement); no explicit CSRF token
- ❌ **Data encryption at rest** — Relies on Supabase/PostgreSQL default; no column-level encryption on sensitive fields

### Mobile Support
- ✅ **Mobile UI design** — FIXED: Mobile hamburger menu, `md:ml-64` layout, scrollable tabs, responsive stat cards
- ✅ **Touch optimization** — FIXED: Buttons stack vertically on mobile, icon-only labels on small screens
- ✅ **Mobile testing** — DONE: Admin sidebar, tournament event UI, bracket views all mobile-responsive

### Testing
- ❌ **Unit tests** - 0 test files (no .test.ts or .spec.ts)
- ❌ **Integration tests** - No DB query testing
- ❌ **E2E tests** - No critical flow testing
- ❌ **Component tests** - No component rendering tests
- ❌ **Server action tests** - No action logic testing

### Input Validation & Error Messages
- ❌ **Zod schemas** - No shared validation schemas
- ❌ **Form validation library** - No react-hook-form or similar
- ❌ **Input sanitization** - No text escaping visible
- ❌ **Specific error messages** - Generic "Error: message" in many places
  - Users don't know what went wrong
  - "Not authenticated" vs "Session expired" not distinguished

- ❌ **Field-level error display** - No error messages under form fields
- ❌ **Loading states** - Some components missing loading indicators
  - Dialog submission doesn't show loading state
  - Buttons don't disable during submission

### Performance Optimization
- ❌ **Pagination** - No pagination on large lists
  - All tournaments, matches, challenges load at once
  - May cause performance issues with 1000+ records

- ❌ **Infinite scroll/Load more** - No lazy loading implemented
- ❌ **Query caching** - No SWR or React Query
  - Only relies on Next.js revalidation
  - No client-side cache

- ❌ **Debouncing** - Search/filter inputs unbounced
  - Server called on every keystroke
  - Potential performance issue

- ❌ **Image optimization** - No WebP/AVIF formats
- ❌ **Bundle analysis** - No size reporting
- ❌ **Code splitting** - Next.js defaults only
- ❌ **PDF optimization** - jsPDF may be slow for large brackets

### Accessibility
- ❌ **ARIA labels** - Missing on icon buttons
  - Edit/delete buttons have no aria-label
  - Icon-only buttons not announced to screen readers

- ❌ **ARIA live regions** - Toast notifications not announced
  - Screen readers won't notify users of actions

- ❌ **Focus management** - Dialogs don't trap focus
  - Keyboard users can escape dialog focus

- ❌ **Heading hierarchy** - Only h1, h2 used
  - No proper h3-h6 structure
  - Content sections not semantically marked

- ❌ **Color contrast** - Not verified
  - May fail WCAG AA standards
  - Dark theme colors untested

- ❌ **Keyboard navigation** - Not fully tested
  - Tab order unknown
  - No skip links

- ❌ **Form labels** - Some inputs may lack proper labels
  - aria-invalid not set on error fields

### Real-Time Features
- ❌ **Supabase realtime** - Not utilized
  - Code imports realtime but doesn't use it
  - No live updates when data changes

- ❌ **WebSocket connections** - No persistent connections
- ❌ **Presence/activity** - No "user is editing" indicators
- ❌ **Conflict resolution** - No handling for concurrent edits
- ❌ **Live notifications** - Push configured but not implemented

### Player App Deployment
- ❌ **Player app not deployed** - `/apps/player` exists but no deployment
  - No separate domain
  - No build output
  - No Docker container

---

# ⚠️ PARTIALLY IMPLEMENTED

## Features Needing Work

### Player App — Known UI Color Bugs
- ✅ `challenges/[id]/page.tsx` — `accepted` status green, positive `rating_delta` green, `confirmed` result distinct from `disputed` — ALL FIXED (2026-04-07)
- ✅ `challenges/new/page.tsx` — Win Elo preview delta green — FIXED (2026-04-07)
- ✅ `challenges/[id]/page.tsx` — `cancelled`/`expired`/`walkover_confirmed`/`walkover_pending` status styles added — FIXED (2026-04-07)

### Admin — Disputes Page Style Inconsistency
- ❌ `disputes/page.tsx` uses `style={{...}}` inline props throughout; every other admin page uses Tailwind `className`

### Admin — Dispute "Edited" Resolution Not Implemented
- ✅ Schema supports `resolution_type = 'edited'`
- ❌ `resolveDispute()` has no branch for it — edited scores never applied or re-Elo'd

### Tournament Bracket
- ✅ Bracket data stored and fetched
- ✅ Visual bracket with CSS connecting lines (admin + player apps)
- ❌ Drag-and-drop seed editing not implemented
- ❌ Auto-bracket generation may need refinement

### Leaderboards
- ✅ Real-time updates via Supabase channel subscription (player app)
- ✅ Season tier colored dots per player
- ❌ No pagination (all players fetched client-side — will slow down at scale)
- ❌ No filter/sort on admin leaderboard

### Push Notifications
- ✅ Vapid keys configured
- ❌ Push sending not implemented
- ❌ Service worker setup incomplete

### Elo History
- ❌ No `ratings_history` table — current Elo snapshot only, chart not possible yet

### Responsive Design
- ✅ Grid system responsive (sm:, lg: breakpoints)
- ✅ Sidebar mobile hamburger menu with `md:ml-64` layout
- ✅ EventControlCenter tabs scrollable on mobile with icon-only labels
- ✅ EventHeader stat cards 2-col mobile, 4-col desktop
- ✅ Bracket views with CSS connecting lines on both admin and player apps

---

## Dev Mode Auth Issue — RESOLVED

**Status:** ✅ FIXED in Phase 1

- `getAuthenticatedAdmin()` created in `apps/admin/src/lib/supabase-server.ts` — validates real session + admin role
- All `getAdminPlayer()` calls now delegate to `getAuthenticatedAdmin()`
- Middleware calls `is_admin` RPC, redirects non-admins to `/unauthorized`
- `/unauthorized` page created at `apps/admin/src/app/unauthorized/page.tsx`
- Legacy `coach_executive` role removed — only `admin` role is valid

---

# 📊 DEPLOYMENT STATUS

## Current Deployment
- **Server:** Raspberry Pi (friend's server)
- **Domain:** `admin.badminton.polardev.org:3010`
- **Port:** 3010 (via Docker)
- **Reverse Proxy:** Nginx on port 80/443
- **SSL/HTTPS:** Enabled via Nginx
- **Process Manager:** PM2
- **Container:** Docker with Node 20
- **Database:** Supabase (cloud)

## Deployment Files
- **Docker Compose:** `~/docker/docker-compose.yml`
- **Dockerfile:** `~/docker/Dockerfile.badminton-admin`
- **Nginx Config:** `/etc/nginx/sites-enabled/default`
- **Environment:** `~/The-Badminton-Software/apps/admin/.env.local`
- **Next.js Config:** Uses `output: 'standalone'`

## Deployment Commands
```bash
# SSH into Pi
ssh -i ~/.ssh/polardev_key -p 2222 viraj@ssh.polardev.org

# Check running app
pm2 list

# View logs
pm2 logs badminton-admin

# Restart app
pm2 restart badminton-admin

# Update and redeploy
cd ~/The-Badminton-Software
git pull origin main
npm run build
pm2 restart badminton-admin
```

---

# 🔴 HIGH PRIORITY DEBUGGING CHECKLIST

**Run this before any new features are added:**

## Page Testing
- [ ] Test all 19 pages load with real data
- [ ] Verify dashboard stat counts match database
- [ ] Check player list filters work (competitive/recreational/attention)
- [ ] Test player detail page edit form
- [ ] Verify match list displays all matches
- [ ] Check tournament bracket renders correctly
- [ ] Test event tabs switch properly
- [ ] Verify announcement composer publishes
- [ ] Check audit log shows recent actions
- [ ] Test settings page loads and saves

## CRUD Operations
- [ ] Create player → verify in list
- [ ] Update player status → check in database
- [ ] Delete player → verify soft delete
- [ ] Create match → verify score entry works
- [ ] Create tournament → verify events can be added
- [ ] Register tournament participant → check check-in works
- [ ] Create announcement → verify appears in list
- [ ] Create season → verify can set active

## Server Actions
- [ ] Test approvePlayer with different statuses
- [ ] Test createMatch with invalid inputs
- [ ] Test resolveDispute error handling
- [ ] Test tournament registration limits (if max_participants set)
- [ ] Verify all actions log to audit_logs
- [ ] Check Sentry receives error logs

## Database Connectivity
- [ ] Verify Supabase connection on Vercel deployment
- [ ] Check admin Supabase client has access
- [ ] Verify RLS policies allow admin operations
- [ ] Test anon key restrictions (if used)
- [ ] Confirm service role key is not exposed

## UI/Theme
- [ ] Verify dark theme on all pages
- [ ] Check CSS variables are defined
- [ ] Test theme switching (if implemented)
- [ ] Verify sidebar navigation works
- [ ] Check responsive design on tablet (sm breakpoint)
- [ ] Test icons render correctly
- [ ] Verify color contrast is readable

## Error Handling
- [ ] Intentionally fail a server action, check error message
- [ ] Test invalid form inputs
- [ ] Check toast notifications appear
- [ ] Verify error page renders on 404
- [ ] Test Sentry captures errors
- [ ] Check console for warnings/errors

## Live Deployment
- [ ] Test `admin.badminton.polardev.org:3010` loads
- [ ] Verify data persists after refresh
- [ ] Test create/update operations work
- [ ] Check page load time (should be <3s)
- [ ] Verify SSL certificate valid
- [ ] Test redirect from http to https
- [ ] Check Nginx reverse proxy working

## Security
- [ ] Verify dev-mode auth comment visible (needs fixing)
- [ ] Check if user without account can access
- [ ] Verify middleware redirects to login
- [ ] Test logout functionality
- [ ] Check session persists on page reload
- [ ] Verify audit logs contain admin actions

## Performance
- [ ] Check Network tab - no unnecessary requests
- [ ] Verify images load (if any)
- [ ] Check bundle size in build output
- [ ] Test with slow 3G network (DevTools)
- [ ] Verify pagination not needed (< 100 items per page)

## Browser Compatibility
- [ ] Test in Chrome
- [ ] Test in Safari
- [ ] Test in Firefox
- [ ] Check console for polyfill errors
- [ ] Verify CSS custom properties work

---

# 📋 NEXT STEPS (Prioritized)

1. ~~**🔴 FIX AUTHENTICATION**~~ ✅ DONE (Phase 1)
2. ~~**🟠 IMPLEMENT MOBILE SUPPORT**~~ ✅ DONE (Phases 4, 12)
3. ~~**Player app core features**~~ ✅ DONE (cancel challenge, notifications, tier badges, best partners, scheduled date/time, security guards)
4. ~~**🔴 FIX UI COLOR BUGS**~~ ✅ DONE (2026-04-07) — all 6 badge/delta color issues resolved in player app
5. ~~**🔴 RUN DATABASE MIGRATIONS**~~ ✅ DONE (2026-04-07/08) — migrations 00013–00018 all applied
6. ~~**🔴 SECURITY HARDENING**~~ ✅ DONE (2026-04-07/08) — rate limits, toClientError, CSP, server-only, RLS tightened, audit immutability, match update guard
7. **🔴 DEPLOY PLAYER APP** — `/apps/player` built and tested locally; needs Vercel project, domain, and env vars configured
8. **🔴 DEPLOY ADMIN UPDATE** — Push latest security hardening + UI changes to Raspberry Pi (`git pull` + `npm run build` + `pm2 restart`)
9. **🟠 REFACTOR DISPUTES PAGE** — Convert `disputes/page.tsx` inline styles to Tailwind for consistency
10. **🟠 IMPLEMENT DISPUTE "EDITED" FLOW** — Add branch in `resolveDispute()` to apply edited scores + re-Elo
11. **🟠 ADD TESTS** — Vitest foundation exists; need integration tests for server actions and RLS policies
12. **🟡 OPTIMIZE PERFORMANCE** — Pagination for leaderboard + large match/challenge lists
13. **🟡 ADD MONITORING** — Configure Sentry DSN in both apps; add performance monitoring
14. **🟡 PUSH NOTIFICATIONS** — Complete service worker setup; implement push sending via Supabase Edge Function

---

# 📝 FILE STRUCTURE

```
badminton-platform/
├── apps/
│   ├── admin/
│   │   ├── src/
│   │   │   ├── app/                    # 19 pages (all dynamic)
│   │   │   │   ├── dashboard/
│   │   │   │   ├── players/
│   │   │   │   ├── matches/
│   │   │   │   ├── tournaments/        # With 8 event control tabs
│   │   │   │   ├── challenges/
│   │   │   │   ├── disputes/
│   │   │   │   ├── walkovers/
│   │   │   │   ├── seasons/
│   │   │   │   ├── settings/
│   │   │   │   ├── audit/
│   │   │   │   ├── unauthorized/    # NEW: non-admin redirect
│   │   │   │   └── login/
│   │   │   ├── lib/
│   │   │   │   ├── actions.ts           # 30+ server actions
│   │   │   │   ├── tournament-actions.ts
│   │   │   │   └── supabase-server.ts   # Admin client, SSR client
│   │   │   ├── components/              # 25+ components
│   │   │   │   ├── sidebar.tsx
│   │   │   │   ├── error.tsx
│   │   │   │   └── (page-specific)
│   │   │   └── app/globals.css          # Theme variables
│   │   └── next.config.js               # Vercel-ready (standalone removed)
│   │
│   ├── player/                          # BUILT, NOT YET DEPLOYED (Vercel pending)
│   │   └── (Same structure as admin)
│   │
│   ├── shared/                          # Types & utilities
│   │   └── src/
│   │       ├── types/
│   │       ├── constants/
│   │       └── utils/
│   │
│   └── ui/                              # Shared components
│       └── src/components/
│
├── DATABASE: Supabase (12 tables)
├── DEPLOYMENT: Raspberry Pi + Docker + Nginx
└── PROJECT_STATUS.md                    # This file

```

---

# 🔗 KEY ENVIRONMENT VARIABLES

```
NEXT_PUBLIC_SUPABASE_URL=https://jtajmqsuedmkyglagmpq.supabase.co
NEXT_PUBLIC_SUPABASE_ANON_KEY=eyJ...
SUPABASE_SERVICE_ROLE_KEY=eyJ...       # DO NOT EXPOSE
NEXT_PUBLIC_VAPID_PUBLIC_KEY=BF6...
VAPID_PRIVATE_KEY=H8J...               # DO NOT EXPOSE
VAPID_EMAIL=mailto:your@email.com
NEXT_PUBLIC_SENTRY_DSN=                # Empty (optional)
SENTRY_DSN=                            # Empty (optional)
```

---

**Last Updated:** April 23, 2026
**Test Status:** 🟡 Vitest foundation + 8 qr-token unit tests green; integration + E2E tests not yet written
**Production Ready:** 🟠 CLOSE — auth done, security hardened, DB migrations 00001–00019 (00019 QR columns pending remote apply), player app UI/UX complete, QR scan-to-submit shipped. Blockers: player app Vercel deploy, admin Pi redeploy, `supabase db push` + `supabase functions deploy verify-qr-token`.

---

## QR Result Submission — shipped 2026-04-23

**Database** (`supabase/migrations/00019_add_qr_to_challenges.sql`)
- Adds `qr_token` (unique partial index where not null), `qr_generated_at`, `qr_expires_at`, `submitted_via` ('manual'|'qr') to `challenges`.
- Deploy: `supabase db push`.

**Shared** (`packages/shared/src/lib/qr-token.ts`)
- HMAC-SHA256, keyed by `SUPABASE_SERVICE_ROLE_KEY`, format `base64url(payload).base64url(sig)` where payload is `{cid, exp}`.
- `generateQrToken(cid, days)` / `verifyQrToken(token, cid) -> {valid:true} | {valid:false, reason:'expired'|'tampered'|'mismatch'|'malformed'}`.
- 8 vitest cases passing (signed/tampered-sig/tampered-payload/wrong-cid/expired/malformed/empty/zero-days).

**Edge function** (`supabase/functions/verify-qr-token/index.ts`)
- Deno + Web Crypto HMAC. POST `{challengeId, token}` returns `200 {ok:true, challenge:{id,type,format,expiresAt,participants}}` or `400 {ok:false, code}` where code ∈ `INVALID_TOKEN | EXPIRED | WRONG_STATUS | ALREADY_SUBMITTED`.
- Deploy: `supabase functions deploy verify-qr-token`.

**Admin** (`apps/admin/src/`)
- `lib/actions.ts`: `generateQrForChallenge(id)` / `getExistingQrForChallenge(id)`. 14-day expiry. Audit-logged as `challenge_qr_generated`.
- `app/challenges/qr-modal.tsx`: `QrModalButton`, renders QR via `qrcode` npm package on a 280px canvas in a white 312px square, Download PNG + Print + Regenerate.
- `app/challenges/page.tsx`: QR button wired per row (only when status=accepted && no match), "QR Submissions (season)" stat card (`qr / total (pct%)`) from `submitted_via` column.

**Player** (`apps/player/src/`)
- `app/submit/page.tsx`: server component. Reads `cid`, `tok` from query, checks auth → else renders `AuthRedirect` client. Calls edge function server-side via fetch. Routes to `SubmitForm` on success, or the correct error screen.
- `app/submit/submit-form.tsx`: pre-filled player names, score inputs with BO3 toggle, `decideWinner` derived from sets, win-probability bar placeholder, DM Mono numerics.
- `app/submit/auth-redirect.tsx`: stashes `sessionStorage.qr_redirect`, also passes `?next=` so callback can redirect server-side when cookies persist across the round-trip.
- `app/submit/error-screens.tsx`: `WrongPlayerError`, `ExpiredError`, `AlreadySubmittedError`, `InvalidTokenError`, `WrongStatusError`.
- `lib/actions.ts`: `submitQrMatchResult(challengeId, {winner_side, games})` — rate-limited, double-checks token + expiry + no existing match, stamps `submitted_via='qr'`, notifies other participants.
- `components/qr-redirect-handler.tsx`: drains `sessionStorage.qr_redirect` on any authed page (mobile system-browser handoff fallback).
- `app/login/page.tsx`: reads `?next=`, stashes to sessionStorage, forwards via `redirectTo` to both OAuth and magic link.
- `app/auth/callback/route.ts`: honors `?next=` param for server-side redirect after code exchange.
- `app/globals.css`: `.submit-*` styles (card, score inputs, probability bar, error states).

**Typecheck:** both apps clean.

## Design system overhaul — partial, needs fresh session

**Shipped (non-breaking additive slice):**
- `apps/player/src/app/globals.css`: imported Syne + DM Mono; added `--text-xs..2xl` scale, `--font-display/body/mono`, `--ds-*` palette tokens (`#00E5A0` accent, `#0A0A0A` bg, `#F2F2F2` text, etc.) in `:root`. Legacy `[data-theme="dark"]` vars untouched — existing pages unaffected.
- `/submit` + error screens now use Syne headings and DM Mono scores.

**Remaining (blocker-free but large):**
1. Palette migration — replace every `var(--color-accent)` red reference with `var(--ds-accent)` teal. Grep hits ~80+ spots across player + admin + `packages/ui`.
2. `packages/ui` component restyle (cascades to both apps):
   - Card: 1px border, 8px radius, no shadow, hover = border-color to accent-30%.
   - Button: 40px h, 6px r, primary=accent bg+black text, secondary=transparent+border, destructive=danger@10% bg. No pills.
   - Input: 40px, 6px r, focus border=accent, labels above (font-size `--text-sm` secondary).
   - Table: no zebra, border-bottom only, row-hover=`--ds-bg-elevated`, rank numbers in DM Mono.
   - Sidebar (admin): 220px, right-border, active item = accent-dim bg + left-border accent.
   - Tier badges: 6px circle dot + label, no rounded pill backgrounds.
   - Loading: single horizontal shimmer (CSS keyframes) — replace every spinner.
   - Empty state: heading + one-line + one CTA, strip illustrations.
3. Screen redesigns per spec:
   - Leaderboard (player app): full-width table, sticky header, search/filter bar, own-row highlight.
   - Challenge flow: issue step shows Elo gap + win prob preview; detail shows expected outcome + QR section.
   - Player profile: Syne name top, DM Mono Elo large, stat row (W/L/Win%), initials-in-square if no avatar.
   - QR modal (admin): already 280px QR on white + DM Mono expiry — restyle container to 600px dark elevated, close top-right.
   - Error screens: already centered card + Syne + danger/warning label — confirm once new palette lands.

Recommended next-session order: migrate palette → `packages/ui` components → screen-level passes.

---

**Last Updated:** April 8, 2026 (initial)
**Test Status:** 🟡 Testing foundation in place (Vitest); integration + E2E tests not yet written
**Production Ready:** 🟠 CLOSE — auth done, security hardened, all DB migrations applied (00001–00018), player app UI/UX complete. Blockers: player app Vercel deploy, admin Pi redeploy with latest changes.
