# Session Handoff — SFU Badminton Platform

## What Was Completed (All Sessions Combined)

### Phase 1: Auth Fix + Credential Rotation
- Created `getAuthenticatedAdmin()` in `apps/admin/src/lib/supabase-server.ts` — validates real session + admin role
- Replaced all DEV MODE `getAdminPlayer()` calls — each now delegates to `getAuthenticatedAdmin()`
- Added admin role check in `apps/admin/middleware.ts` — calls `is_admin` RPC, redirects non-admins to `/unauthorized`
- Created `/unauthorized` page at `apps/admin/src/app/unauthorized/page.tsx`
- Fixed `settings/page.tsx` to use `getAuthenticatedAdmin()`
- Scrubbed real credentials from `.env.example`
- Removed legacy `coach_executive` role acceptance — now only `admin` role is valid

### Phase 2: Simplify Data Model
- `PlayerStatus` simplified from 7 to 4: `competitive`, `recreational`, `pending_approval`, `suspended`
- `UserRole` simplified from 4 to 2: `player`, `admin`
- Removed unused fields from `Player` interface
- Updated `constants.ts`, `helpers.ts`, `schemas.ts` accordingly
- `approvePlayer()` simplified to 3 params, `removePlayer()` sets `suspended`

### Phase 3: Remove Bloat Features
- Deleted: `varsity/`, `sessions/`, `announcements/` (both admin and player apps)
- Deleted `DrawSheetPDF.tsx`
- Sidebar simplified to 7 items in 2 groups

### Phase 4: Mobile Responsive Admin
- Rewrote `sidebar.tsx` with mobile hamburger menu
- Layout uses `md:ml-64` with mobile top padding
- User email display + logout button in sidebar footer

### Phase 5: Player Approval UX
- One-click "Competitive" / "Recreational" approval buttons on dashboard
- Pending players query + section on dashboard

### Phase 6: Tournament Three-Dot Overflow Menu
- `...` menu on every tournament card with Edit, Archive, Delete
- Shared `TournamentFormDialog` for create/edit
- `archiveTournament`, `updateTournament`, `deleteTournament` server actions with audit logging
- Active/archived section split on tournaments page

### Phase 7: Match Actions Fix
- Three-dot menu visible for all non-voided matches
- Conditional menu items based on result status

### Phase 8: Tournament Event System (Types + Server Actions)
- Full tournament event type system in `database.ts`: `TournamentEvent`, `TournamentEventParticipant`, `TournamentPair`, `TournamentMatch`, `TournamentAuditEntry`
- `draw_locked`, `points` fields added to relevant types
- Tournament notification types added to `NotificationType`
- ~25 server actions in `tournament-actions.ts`: CRUD for events/participants/pairs, bracket generation (single elimination + round robin), score entry, walkover, void, undo, Elo application, placement bonuses, finalization, bulk check-in, lock/unlock draw, clear seeds, compute RR standings

### Phase 9: Admin Tournament Event UI
- **EventControlCenter** — Tab-based UI (participants, check-in, bracket, round robin, results, leaderboard) with smart tab availability based on event status
- **EventHeader** — Status stepper, action buttons (Open Check-In → Generate Bracket → Start Tournament → Finalize), lock/unlock draw, responsive stat cards (2-col mobile, 4-col desktop)
- **ParticipantsTab** — Inline seed editing, auto-seed by Elo, clear seeds, add/remove participants and pairs, bye preview panel, draw-locked guards
- **CheckInTab** — Two-column layout (pending/checked-in), progress bar, bulk check-in, no-show tracking
- **BracketTab** — Horizontal bracket with connecting lines between rounds, proper vertical centering, score entry per match, seed display, walkover badges
- **RoundRobinTab** — Live standings table (W/L/PF/PA/+/-), matches grouped by round, inline score entry
- **ScoreEntryDialog** — Auto-winner detection, game-by-game score input, walkover/void with reasons
- **ResultsTab** — Champion card, final standings with Elo changes and placement bonuses, undo match result with confirmation
- **LeaderboardTab** — Sortable table, CSV export
- **CreateEventButton** — Dialog to create events for draft or active tournaments

### Phase 10: Player App Tournament System
- **Tournaments list** — Clean query using `tournament_events(count)`, status badges, event count display
- **Tournament detail** — Event cards with registration status, participant counts, event type labels
- **EventRegistrationButton** — Register/withdraw for singles events
- **Event detail page** — Full bracket view (single elimination with connecting lines + round robin), "Your Matches" section, final standings with points/Elo, participant list with seeds and avatars
- **Self check-in** — Dedicated page at `/checkin` with server-side validation, `SelfCheckInClient` component
- **EventActions** — Register/withdraw/check-in buttons based on event status
- **Leaderboard tournament points tab** — Aggregates points across all events per player

### Phase 11: Tournament Status Management
- **TournamentStatusControls** component — Draft→Active ("Activate Tournament") and Active→Completed ("Mark Completed") buttons
- Wired to existing `updateTournamentStatus` server action with audit logging
- Event creation now allowed for both draft and active tournaments

### Phase 12: Mobile + UI Polish
- EventControlCenter tabs horizontally scrollable on mobile, icon-only labels on small screens
- EventHeader stat cards responsive (2-col on mobile)
- EventHeader buttons stack vertically on small screens
- Bracket views (admin + player) have CSS connecting lines between rounds with proper vertical centering

### Infrastructure
- Error boundaries at: admin root, tournament `[id]`, event `[eventId]`; player root, tournament `[id]`, event `[eventId]`
- Loading skeletons at: admin event `[eventId]`; player tournament `[id]`, event `[eventId]`
- Next.js upgraded to 14.2.35 in both apps
- Removed `output: 'standalone'` from admin `next.config.js` (Vercel-ready)
- Sentry configured with `widenClientFileUpload`, `hideSourceMaps`, conditional DSN wrapping
- Dashboard "Current Session" card replaced with "Active Tournaments" card (sessions route was deleted)
- Cleaned up unused imports across dashboard (`StatCard`, `Card`, `CalendarDays`)

### Bug Fixes Applied
- `removePlayer()` uses `status: 'suspended'` (not deleted `'inactive'`)
- `getAuthenticatedAdmin()` no longer accepts `coach_executive`
- Unused `admin` variables in tournament-actions.ts fixed (auth-only calls use `await getAdminPlayer()` without storing)
- Player tournaments page removed fragile 3-tier schema fallback

---

## What Still Needs to Be Done

### ~~CRITICAL: Database Migration~~ DONE
Migrated via `supabase db query --linked` on 2026-04-06. Added `'competitive'` to `player_status` enum, then ran the UPDATEs below. Current state: statuses `recreational` (4), `suspended` (1); roles `player` (2), `admin` (3). Legacy values cleared.

<details><summary>SQL run</summary>
```sql
-- Migrate player statuses
UPDATE players SET status = 'competitive' WHERE status IN ('eligible_competitive', 'competitive_associate');
UPDATE players SET status = 'suspended' WHERE status IN ('alumni_external', 'inactive');

-- Migrate roles
UPDATE players SET role = 'player' WHERE role IN ('moderator', 'coach_executive');

-- Set admin
UPDATE players SET role = 'admin' WHERE email = 'virajveer@gmail.com';

-- Add 'archived' to tournament status enum if using a Postgres enum
-- (If using text column, no migration needed)
```
</details>

### ~~CRITICAL: Vercel Deployment~~ DONE
Both apps live on production (2026-04-06):
- Admin: https://admin-snowy-theta.vercel.app
- Player: https://player-jade-one.vercel.app

Projects configured via Vercel REST API (`installCommand: npm install`, `buildCommand: npx turbo run build --filter=<app>`, `outputDirectory: apps/<app>/.next`, `rootDirectory: null`). Env vars set: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`. Sentry DSN not yet set.

### ~~HIGH: Missing Error/Loading Boundaries~~ DONE
All missing error/loading boundaries added.

### ~~HIGH: Doubles Event Player UX~~ DONE
`EventRegistrationButton` and `EventActions` now show doubles status or "managed by admin" message.

### ~~HIGH: Withdrawal Confirmation~~ DONE
Both `EventRegistrationButton` and `EventActions` now show `confirm()` before withdrawal.

### ~~MEDIUM: Score Display Format~~ DONE
Admin `BracketTab` now formats scores as `21-19, 21-15` (each side shows their perspective).

### ~~MEDIUM: Seed Input Validation~~ DONE
SeedCell validates: `seed >= 1`, `seed <= participant count`, no duplicate seeds. Shows inline error.

### ~~MEDIUM: Check-in Page Error Handling~~ DONE
Uses `eventError` check and `maybeSingle()` for registration query (no crash on missing).

### ~~MEDIUM: N+1 Query in Admin Tournament Detail~~ DONE
Replaced per-event count queries with 2 batch queries (participants + pairs) using `Promise.all`.

### ~~MEDIUM: Partner Selection Validation (Doubles)~~ DONE
Player 2 dropdown filters out the player already selected as Player 1.

### ~~LOW: CSV Export Polish~~ DONE
CSV filename now includes event type (e.g., `leaderboard-mens_singles.csv`).

### ~~LOW: Accessibility~~ MOSTLY DONE
- ~~Missing `aria-label` on icon-only buttons~~ Added across admin players, matches, BracketTab, ScoreEntryDialog
- ~~Bracket display has no semantic structure~~ BracketTab now uses `role="grid"` / `role="row"` / `role="gridcell"` with round-name aria-labels
- ~~Status badges rely on color only~~ BracketTab adds visible winner glyphs and walkover/voided text markers
- ~~No visible `:focus-visible` indicators~~ Added `focus-visible:ring-2` on custom buttons in BracketTab and ScoreEntryDialog
- Remaining: deeper sweep of less-trafficked admin pages

### ~~LOW: Leaderboard Search/Filter~~ DONE
Search by player name already implemented in `apps/player/src/app/leaderboard/page.tsx`.

### ~~NOT STARTED: Testing Foundation~~ DONE
Vitest configured across monorepo. 218 tests passing: validator schemas, Elo engine, helpers, constants, `getAuthenticatedAdmin()`. Run with `npx turbo run test`.

---

## Files Changed (All Sessions Combined)

### Core Auth
- `apps/admin/src/lib/supabase-server.ts` — `getAuthenticatedAdmin()`, admin-only role check
- `apps/admin/middleware.ts` — admin role RPC check
- `apps/admin/src/app/unauthorized/page.tsx` — NEW

### Server Actions
- `apps/admin/src/lib/actions.ts` — auth, approvePlayer, createPlayer, removePlayer, updateTournament, archiveTournament, deleteTournament, updateTournamentStatus
- `apps/admin/src/lib/tournament-actions.ts` — ~25 tournament event server actions (1979 lines)
- `apps/admin/src/app/settings/actions.tsx` — auth import
- `apps/player/src/lib/tournament-actions.ts` — registerForEvent, withdrawFromEvent, selfCheckIn

### Shared Package
- `packages/shared/src/types/database.ts` — simplified enums, tournament event types, TournamentPair.points, draw_locked, notification types
- `packages/shared/src/utils/constants.ts` — simplified labels, added tournament event labels/colors
- `packages/shared/src/utils/helpers.ts` — removed isAdminOrCoach, canModerate; added isDoublesEvent, getRoundName, nextPowerOf2, getMaxGamesForFormat
- `packages/shared/src/validators/schemas.ts` — simplified adminPlayerUpdateSchema

### Admin UI
- `apps/admin/src/components/sidebar.tsx` — mobile responsive, 7 nav items, logout
- `apps/admin/src/app/layout.tsx` — `md:ml-64`
- `apps/admin/src/app/login/page.tsx` — removed `-ml-64` hack
- `apps/admin/src/app/dashboard/page.tsx` — pending players section, tournaments card (replaced sessions)
- `apps/admin/src/app/dashboard/approve-buttons.tsx` — NEW
- `apps/admin/src/app/settings/page.tsx` — uses getAuthenticatedAdmin()
- `apps/admin/src/app/players/page.tsx` — simplified status filters
- `apps/admin/src/app/players/player-actions.tsx` — simplified status/role options
- `apps/admin/src/app/players/add-player-button.tsx` — simplified options
- `apps/admin/src/app/players/[id]/page.tsx` — updated badge logic
- `apps/admin/src/app/players/[id]/edit-form.tsx` — removed eligibility, simplified roles
- `apps/admin/src/app/tournaments/page.tsx` — rewritten: active/archived split, TournamentCard, TournamentMenu
- `apps/admin/src/app/tournaments/actions.tsx` �� rewritten: TournamentFormDialog, CreateTournamentForm, TournamentMenu
- `apps/admin/src/app/tournaments/[id]/page.tsx` �� event list, TournamentStatusControls, CreateEventButton for draft+active
- `apps/admin/src/app/tournaments/[id]/tournament-status-controls.tsx` — NEW
- `apps/admin/src/app/tournaments/[id]/create-event.tsx` — NEW
- `apps/admin/src/app/tournaments/[id]/events/[eventId]/page.tsx` — NEW: event detail with EventControlCenter
- `apps/admin/src/app/tournaments/[id]/events/[eventId]/components/EventControlCenter.tsx` — NEW
- `apps/admin/src/app/tournaments/[id]/events/[eventId]/components/EventHeader.tsx` — NEW
- `apps/admin/src/app/tournaments/[id]/events/[eventId]/components/ParticipantsTab.tsx` — NEW
- `apps/admin/src/app/tournaments/[id]/events/[eventId]/components/CheckInTab.tsx` — NEW
- `apps/admin/src/app/tournaments/[id]/events/[eventId]/components/BracketTab.tsx` — NEW (with connector lines)
- `apps/admin/src/app/tournaments/[id]/events/[eventId]/components/RoundRobinTab.tsx` — NEW
- `apps/admin/src/app/tournaments/[id]/events/[eventId]/components/ScoreEntryDialog.tsx` — NEW
- `apps/admin/src/app/tournaments/[id]/events/[eventId]/components/ResultsTab.tsx` — NEW
- `apps/admin/src/app/tournaments/[id]/events/[eventId]/components/LeaderboardTab.tsx` — NEW
- `apps/admin/src/app/tournaments/[id]/events/[eventId]/error.tsx` — NEW
- `apps/admin/src/app/tournaments/[id]/events/[eventId]/loading.tsx` — NEW
- `apps/admin/src/app/tournaments/[id]/error.tsx` — NEW
- `apps/admin/src/app/matches/page.tsx` — three-dot menu for all non-voided
- `apps/admin/src/app/matches/actions.tsx` — rewritten: MoreVertical icon trigger
- `apps/admin/next.config.js` — removed `output: 'standalone'`

### Player App
- `apps/player/src/app/tournaments/page.tsx` — clean tournament_events(count) query
- `apps/player/src/app/tournaments/[id]/page.tsx` — event cards with registration buttons
- `apps/player/src/app/tournaments/[id]/EventRegistrationButton.tsx` — NEW
- `apps/player/src/app/tournaments/[id]/error.tsx` — NEW
- `apps/player/src/app/tournaments/[id]/loading.tsx` — NEW
- `apps/player/src/app/tournaments/[id]/events/[eventId]/page.tsx` — NEW: bracket, your matches, standings (with connector lines)
- `apps/player/src/app/tournaments/[id]/events/[eventId]/EventActions.tsx` — NEW
- `apps/player/src/app/tournaments/[id]/events/[eventId]/error.tsx` — NEW
- `apps/player/src/app/tournaments/[id]/events/[eventId]/loading.tsx` — NEW
- `apps/player/src/app/tournaments/[id]/events/[eventId]/checkin/page.tsx` — NEW
- `apps/player/src/app/tournaments/[id]/events/[eventId]/checkin/SelfCheckInClient.tsx` — NEW
- `apps/player/src/app/leaderboard/page.tsx` — added tournament points tab
- `apps/player/src/app/leaderboard/[playerId]/page.tsx` — updated badge
- `apps/player/src/app/settings/page.tsx` — removed hide_from_leaderboard references

### Deleted
- `apps/admin/src/app/varsity/`
- `apps/admin/src/app/sessions/`
- `apps/admin/src/app/announcements/`
- `apps/player/src/app/sessions/`
- `apps/player/src/app/announcements/`
- `DrawSheetPDF.tsx`

### Other
- `.env.example` — scrubbed real credentials
- `supabase/functions/mark-inactive-players/index.ts` — updated status filter
- `supabase/functions/refresh-leaderboards/index.ts` — updated to status='competitive'

---

## Build Status
- TypeScript: both apps pass `tsc --noEmit` cleanly
- Build: `turbo build` succeeds (both apps, ~15s)
- Next.js: 14.2.35 in both apps

---

## Session: Tournament Bug Investigation & Fixes (2026-04-06)

### Context

A deep audit of the tournament system was performed. Three categories of issues were found and partially fixed:
1. **UI-visible bugs** (player added but doesn't appear, Open Check-In causes server render error, player check-in not reflected in admin)
2. **Critical Elo correctness bugs** (placement bonus formula wrong, edit result doesn't recalculate Elo, undo doesn't handle doubles)
3. **Missing workflow** (no player-facing tournament registration/check-in flow)

---

### Root Cause: Stale Revalidation

Every mutation in `apps/admin/src/lib/tournament-actions.ts` calls `revalidatePath()` to tell Next.js to re-fetch the page. The bug was that most called:

```typescript
revalidatePath(`/tournaments/${tournamentId}`);
```

…which revalidates the **tournament list page**, not the **event detail page** the admin is actually viewing. The admin event detail page lives at:

```
/tournaments/[id]/events/[eventId]
```

So the UI never refreshed after mutations — player added but list stays empty, check-in count stays 0, status bar doesn't update.

Additionally, `checkInParticipant` and `checkInPair` had **zero** `revalidatePath` calls at all.

---

### Fixes Applied (Commit `e2bebf6`)

**File:** `apps/admin/src/lib/tournament-actions.ts`

Added a helper at the top of the file (after `getAdminPlayer`):

```typescript
function revalidateEventPaths(tournamentId: string, eventId?: string) {
  revalidatePath(`/tournaments/${tournamentId}`);
  if (eventId) revalidatePath(`/tournaments/${tournamentId}/events/${eventId}`);
}
```

Replaced all `revalidatePath(...)` calls with `revalidateEventPaths(...)` in:

| Function | What was wrong | Fix |
|---|---|---|
| `setEventStatus` | Only revalidated tournament page | Now revalidates event detail page too — fixes "Open Check-In" stale UI |
| `addParticipantToEvent` | Had event path but not tournament parent | Now revalidates both |
| `removeParticipantFromEvent` | Wrong path | Fixed |
| `autoSeedEventByElo` | Wrong path | Fixed |
| `checkInParticipant` | No revalidation at all | Added — now fetches `event.tournament_id` from participant join and revalidates both paths |
| `addPairToEvent` | Was revalidating `/tournaments/${id}` not the event page | Fixed |
| `removePairFromEvent` | Wrong path | Fixed |
| `checkInPair` | No revalidation at all | Added — same join pattern as checkInParticipant |
| `generateSingleEliminationBracket` | Wrong path | Fixed |
| `generateRoundRobinMatches` | Wrong path | Fixed |
| `enterMatchResult` | Wrong path | Fixed |
| `enterWalkover` | Wrong path + **Elo never applied** | Fixed path + added `applyTournamentMatchElo(matchId)` call |
| `voidMatch` | Wrong path | Fixed |

**Note:** `enterWalkover` was missing an `applyTournamentMatchElo` call entirely — walkovers were not applying any Elo changes. This was also fixed in this commit.

---

### Bugs NOT Yet Fixed

The following bugs are confirmed in the code and need to be fixed. They are organized by priority.

---

#### CRITICAL: Remaining Admin Revalidation Fixes

**File:** `apps/admin/src/lib/tournament-actions.ts`

The following functions still call the old `revalidatePath(...)` directly instead of `revalidateEventPaths(...)`. They need to be updated the same way as the functions above.

| Function | Approx. line | Fix needed |
|---|---|---|
| `editMatchResult` | ~1275 | Replace `revalidatePath(...)` with `revalidateEventPaths(event.tournament_id, match.event_id)` |
| `applyPlacementBonuses` | ~1497 | Same fix |
| `finalizeEvent` | ~1660 | Same fix |
| `bulkCheckIn` | ~1783 | Same fix |
| `lockDraw` | ~1813 | Same fix |
| `unlockDraw` | ~1839 | Same fix |
| `clearSeeds` | ~1873 | Same fix |
| `undoMatchResult` | ~1991 | Same fix |

Pattern to apply everywhere:
```typescript
// OLD
revalidatePath(`/tournaments/${event.tournament_id}`);

// NEW
revalidateEventPaths(event.tournament_id, eventId); // or match.event_id, pair.event_id depending on what's in scope
```

---

#### CRITICAL: Player App Revalidation Fixes

**File:** `apps/player/src/lib/tournament-actions.ts`

All three player actions revalidate the wrong path:

```typescript
// CURRENT (wrong — revalidates the player's tournament LIST, not the event page)
revalidatePath('/tournaments');

// NEEDED — revalidate the specific event detail page
revalidatePath(`/tournaments/${tournamentId}`);
revalidatePath(`/tournaments/${tournamentId}/events/${eventId}`);
```

Functions affected:
- `registerForEvent(eventId)` — line 47
- `withdrawFromEvent(eventId)` — line 65
- `selfCheckIn(eventId)` — line 84

To fix: fetch `tournament_id` from the event at the start of each function (it already fetches the event), then call both revalidatePath calls.

Example for `selfCheckIn`:
```typescript
// Already fetches the event:
const { data: event } = await service.from('tournament_events').select('status, tournament_id').eq('id', eventId).single();

// After update, add:
revalidatePath(`/tournaments/${event.tournament_id}`);
revalidatePath(`/tournaments/${event.tournament_id}/events/${eventId}`);
```

---

#### CRITICAL: Placement Bonus Operator Precedence Bug

**File:** `apps/admin/src/lib/tournament-actions.ts`, line ~1484

```typescript
// BUG — JavaScript evaluates `0 + bonus` before `??` due to precedence
// So `elo_change` is ALWAYS set to just `bonus`, never including the existing elo_change
await adminClient.from('tournament_participants')
  .update({ elo_change: (p as Record<string, unknown>).elo_change as number ?? 0 + bonus })
  .eq('id', p.id);

// FIX — add parentheses
await adminClient.from('tournament_participants')
  .update({ elo_change: (((p as Record<string, unknown>).elo_change as number) ?? 0) + bonus })
  .eq('id', p.id);
```

This means every tournament that applied placement bonuses has incorrect `elo_change` values in `tournament_participants`. The `ratings` table Elo is correct (bonus is added correctly there), but the tracking column is wrong.

---

#### CRITICAL: editMatchResult Does Not Recalculate Elo

**File:** `apps/admin/src/lib/tournament-actions.ts`, function `editMatchResult` (~line 1206)

When an admin edits a match result (changes who won), the function updates the winner/loser IDs and scores but **never touches Elo**. The old Elo from the original result remains. If player A beat player B and Elo was applied (+12/-12), then an admin edits it so B won, Elo still shows A gained +12.

**Fix needed:**

Before updating the match, reverse the old Elo. After updating, apply the new Elo.

Add a `reverseTournamentMatchElo(matchId)` helper (or inline the logic):

```typescript
// Step 1: reverse old Elo before editing
// For singles — use elo_before stored in tournament_participants:
const { data: winnerP } = await adminClient.from('tournament_participants')
  .select('player_id, elo_before').eq('id', match.winner_participant_id).single();
const { data: loserP } = await adminClient.from('tournament_participants')
  .select('player_id, elo_before').eq('id', match.loser_participant_id).single();
// Reset ratings to elo_before
await adminClient.from('ratings').update({ singles_elo: winnerP.elo_before }).eq('player_id', winnerP.player_id);
await adminClient.from('ratings').update({ singles_elo: loserP.elo_before }).eq('player_id', loserP.player_id);
await adminClient.from('tournament_participants').update({ elo_after: null, elo_change: null }).eq('id', match.winner_participant_id);
await adminClient.from('tournament_participants').update({ elo_after: null, elo_change: null }).eq('id', match.loser_participant_id);

// Step 2: update match with new scores/winner (existing code)

// Step 3: re-apply Elo using new winner
await applyTournamentMatchElo(matchId);
```

For doubles, `elo_before` is not stored per-player on the pair. The workaround is to recompute the delta from match parameters and subtract it. See the undoMatchResult doubles fix below — same approach applies.

---

#### CRITICAL: undoMatchResult Does Not Reverse Elo for Doubles

**File:** `apps/admin/src/lib/tournament-actions.ts`, function `undoMatchResult` (~line 1880)

The function correctly reverses Elo for singles (uses `elo_before` stored in `tournament_participants`). But for doubles it skips Elo reversal entirely — there's an `if (!doubles)` block with no `else`.

**Why it's hard:** Doubles doesn't store `elo_before` per-player on `tournament_pairs`. The only stored value is `combined_elo` on the pair (which is the average of both players' doubles_elo at registration time, and doesn't change).

**Fix approach — recompute and reverse:**

```typescript
if (doubles) {
  const winnerId = match.winner_pair_id;
  const loserId = match.loser_pair_id;
  if (winnerId && loserId) {
    const { data: winnerPair } = await adminClient.from('tournament_pairs')
      .select('player1_id, player2_id, combined_elo').eq('id', winnerId).single();
    const { data: loserPair } = await adminClient.from('tournament_pairs')
      .select('player1_id, player2_id, combined_elo').eq('id', loserId).single();

    const allPlayerIds = [winnerPair.player1_id, winnerPair.player2_id, loserPair.player1_id, loserPair.player2_id];
    const { data: ratings } = await adminClient.from('ratings')
      .select('player_id, doubles_elo, doubles_provisional, doubles_matches_played')
      .in('player_id', allPlayerIds);

    const matchFormat = (match.event as Record<string,unknown>).match_format as TournamentMatchFormat;
    const eloMultiplier = Number((match.event as Record<string,unknown>).elo_multiplier) || 1.25;
    const formatWeight = getFormatWeight(toEloFormat(matchFormat));

    // For each winner player: re-derive the delta using their current rating and reverse it
    for (const playerId of [winnerPair.player1_id, winnerPair.player2_id]) {
      const rating = ratings?.find(r => r.player_id === playerId);
      const k = getKFactor('doubles', rating?.doubles_provisional ?? true, rating?.doubles_matches_played);
      const delta = calculateEloUpdate({
        playerRating: rating?.doubles_elo ?? 1200,
        opponentRating: loserPair.combined_elo ?? 1200,
        kFactor: k, formatWeight, eventMultiplier: eloMultiplier, won: true,
      }).delta;
      await adminClient.from('ratings')
        .update({ doubles_elo: (rating?.doubles_elo ?? 1200) - delta })
        .eq('player_id', playerId);
    }

    // Same for loser players (they lost, so delta is negative — subtract it to restore)
    for (const playerId of [loserPair.player1_id, loserPair.player2_id]) {
      const rating = ratings?.find(r => r.player_id === playerId);
      const k = getKFactor('doubles', rating?.doubles_provisional ?? true, rating?.doubles_matches_played);
      const delta = calculateEloUpdate({
        playerRating: rating?.doubles_elo ?? 1200,
        opponentRating: winnerPair.combined_elo ?? 1200,
        kFactor: k, formatWeight, eventMultiplier: eloMultiplier, won: false,
      }).delta;
      await adminClient.from('ratings')
        .update({ doubles_elo: (rating?.doubles_elo ?? 1200) - delta })
        .eq('player_id', playerId);
    }
  }
}
```

Note: `toEloFormat` and `getFormatWeight` are already defined in the file. `calculateEloUpdate` is imported from `@badminton/shared`.

---

#### HIGH: Missing Player-Facing Tournament Registration & Check-In Flow

This is a full UI feature gap, not a bug in existing code. Currently:

1. **Players cannot discover which tournaments are open for registration** — `apps/player/src/app/tournaments/page.tsx` shows all tournaments but doesn't highlight which events are accepting registrations
2. **The Register button disappears** when status moves from `registration` to `checkin` — players who didn't register during registration phase can't register late
3. **There is no in-app check-in UI visible to players** — `selfCheckIn()` server action exists but is only accessible via `/tournaments/[id]/events/[eventId]/checkin` (a URL players have to know)
4. **Player check-in on player app is not reflected on admin app** — fixed partially via revalidation changes above, but the player needs a clear UI button

**Files to modify/create:**

- `apps/player/src/app/tournaments/[id]/page.tsx` — add "Open for Registration" / "Check-In Open" banners per event
- `apps/player/src/app/tournaments/[id]/events/[eventId]/EventActions.tsx` — this file already exists; ensure the Register / Check-In buttons are always visible during the appropriate event statuses, not hidden
- `apps/player/src/app/tournaments/[id]/events/[eventId]/checkin/page.tsx` — already exists; ensure it's linked from the event detail page clearly
- `apps/player/src/lib/tournament-actions.ts` — fix revalidation paths (see above)

**The `EventActions.tsx` component needs to show:**
- When status = `registration`: "Register" button (if not registered), "Withdraw" button (if registered)
- When status = `checkin`: "Check In" button (if registered but not checked in), "Checked In ✓" badge (if checked in)
- When status = `bracket_generated` / `live` / `completed`: read-only status

---

#### MEDIUM: markParticipantNoShow, markPairNoShow, withdrawParticipant, disqualifyParticipant Missing Revalidation

**File:** `apps/admin/src/lib/tournament-actions.ts`

These four functions have no `revalidatePath` at all. They update the DB but the UI won't refresh.

```typescript
export async function markParticipantNoShow(participantId: string) { ... /* no revalidation */ }
export async function markPairNoShow(pairId: string) { ... /* no revalidation */ }
export async function withdrawParticipant(participantId: string, reason?: string) { ... /* no revalidation */ }
export async function disqualifyParticipant(participantId: string, reason?: string) { ... /* no revalidation */ }
```

Fix: same pattern as `checkInParticipant` — fetch `event_id` and `tournament_id` from the participant/pair, then call `revalidateEventPaths`.

---

#### MEDIUM: updateParticipantSeed and updatePairSeed Missing Revalidation

**File:** `apps/admin/src/lib/tournament-actions.ts`, ~lines 338–364

Both seed update functions have no `revalidatePath` call. Inline seed editing in the admin ParticipantsTab will appear to silently succeed.

Fix: fetch the participant's `event_id` and the event's `tournament_id`, then call `revalidateEventPaths`.

---

#### MEDIUM: setEventStatus Does Not Validate Bracket Exists Before Allowing `bracket_generated`

**File:** `apps/admin/src/lib/tournament-actions.ts`, function `setEventStatus`

The function allows direct status jump to `bracket_generated` without checking if bracket matches exist. Admin can set status to `bracket_generated` without calling the bracket generation function. When the event page then renders the BracketTab, it will find zero matches and may render incorrectly.

```typescript
// Add this check before the status update when transitioning to bracket_generated:
if (status === 'bracket_generated') {
  const { count } = await adminClient.from('tournament_matches')
    .select('*', { count: 'exact', head: true })
    .eq('event_id', eventId);
  if (!count || count === 0) {
    throw new Error('Generate the bracket before changing status to bracket_generated');
  }
}
```

---

#### LOW: Notifications Missing Error Handling

**File:** `apps/admin/src/lib/tournament-actions.ts`

All `await notifyPlayers(...)` calls have no try/catch. If the notifications insert fails (e.g. RLS issue, table full), it crashes the entire action (bracket generation, finalization, etc.).

Fix: wrap each call:
```typescript
try {
  await notifyPlayers(adminClient, playerIds, title, body, metadata, type);
} catch (err) {
  Sentry.captureException(err);
  // Don't rethrow — notification failure should not block the main action
}
```

Affected call sites: inside `generateSingleEliminationBracket`, `enterMatchResult`, `finalizeEvent`.

---

#### LOW: Round Robin Tiebreaker Incomplete

**File:** `apps/admin/src/lib/tournament-actions.ts`, function `computeRoundRobinStandings` (~line 1749)

When two players have equal wins AND equal point differential AND equal points-for, they are considered tied with no further resolution. The sort is:
1. Wins (desc)
2. Point differential (desc)
3. Points-for (desc)
4. **Nothing** — effectively random if all three are equal

Should add head-to-head result as the final tiebreaker. Head-to-head can be computed from the `matches` array already available in the function.

---

#### LOW: Elo_before Never Set for Admin-Added Singles Participants

**File:** `apps/admin/src/lib/tournament-actions.ts`, function `addParticipantToEvent`

The code already sets `elo_before` for admin-added participants (line ~283):
```typescript
elo_before: rating?.singles_elo ?? 1200,
```

✅ This is actually **already correct**. The earlier gap analysis flagged this but on re-reading the code, `addParticipantToEvent` does set `elo_before`. Only the player self-registration path (`apps/player/src/lib/tournament-actions.ts`) sets it too. No fix needed here.

---

### Summary: What To Do First in the Next Session

**Priority order:**

1. **Apply remaining revalidation fixes** in `tournament-actions.ts` (admin) — `editMatchResult`, `applyPlacementBonuses`, `finalizeEvent`, `bulkCheckIn`, `lockDraw`, `unlockDraw`, `clearSeeds`, `undoMatchResult`, `markParticipantNoShow`, `markPairNoShow`, `withdrawParticipant`, `disqualifyParticipant`, `updateParticipantSeed`, `updatePairSeed` — just replace `revalidatePath(...)` with `revalidateEventPaths(...)` and add the event detail revalidation

2. **Fix player app revalidation** in `apps/player/src/lib/tournament-actions.ts` — `registerForEvent`, `withdrawFromEvent`, `selfCheckIn` — fetch tournament_id and revalidate the event page

3. **Fix placement bonus operator precedence** — 2-line fix at line ~1484 in tournament-actions.ts (admin)

4. **Fix undoMatchResult for doubles Elo** — code snippet provided above

5. **Fix editMatchResult to reverse+reapply Elo** — code snippet provided above

6. **Wrap notifyPlayers in try/catch** across the file

7. **Build player registration/check-in UI** — update `EventActions.tsx` in player app to surface correct buttons per status, link to the check-in page, fix the player app revalidation so admin sees player check-ins in real time

8. **setEventStatus bracket validation** — add guard before allowing `bracket_generated` transition without matches

---

### Key File Locations

| Purpose | File |
|---|---|
| Admin tournament server actions (~2000 lines) | `apps/admin/src/lib/tournament-actions.ts` |
| Player tournament server actions | `apps/player/src/lib/tournament-actions.ts` |
| Admin event detail page | `apps/admin/src/app/tournaments/[id]/events/[eventId]/page.tsx` |
| Admin event components | `apps/admin/src/app/tournaments/[id]/events/[eventId]/components/` |
| Player tournament detail | `apps/player/src/app/tournaments/[id]/page.tsx` |
| Player event actions component | `apps/player/src/app/tournaments/[id]/events/[eventId]/EventActions.tsx` |
| Player self check-in page | `apps/player/src/app/tournaments/[id]/events/[eventId]/checkin/page.tsx` |
| Shared Elo engine | `packages/shared/src/elo/engine.ts` |
| Shared types | `packages/shared/src/types/database.ts` |
