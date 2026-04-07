# Player App — Improvements & Roadmap

This document tracks all known bugs, security gaps, missing features, UX issues, and planned feature additions for the player app (`apps/player`). Work through bugs and security fixes before implementing new features.

---

## Progress Snapshot (2026-04-06)

### DONE — confirmed in code
- **Bug: W/L color on feed** — `apps/player/src/app/feed/page.tsx`. Wins `bg-emerald-500/15 text-emerald-400`, losses red.
- **Bug: W/L color on my-stats** — `apps/player/src/app/my-stats/page.tsx:199-201`. W/L badges and `rating_delta` both correctly colored (emerald/red).
- **Bug: W/L color on leaderboard/[playerId]** — `apps/player/src/app/leaderboard/[playerId]/page.tsx:184-186`. W/L badges and `rating_delta` (line 193) correctly colored.
- **Feed cleanup** — removed deprecated `sessions` query + Open Sessions card. Unused imports dropped.
- **Privacy + display_name persistence** — `updateProfile` accepts `display_name`, `hide_from_leaderboard`, `show_activity_status`. Settings page saves all fields.
- **Security gaps** — participation asserts added to `submitMatchResult`, `confirmMatchResult`, `disputeMatchResult`. Creator guards in `acceptChallenge` / `rejectChallenge`. Atomic RPC `increment_challenges_issued` (migration `00012`).
- **cancelChallenge action + Cancel button** — creator-only server action, cancel button shown in `challenges/[id]/actions.tsx` for `proposed`/`partially_confirmed` status.
- **Score submission UX** — winner dropdown and per-game inputs show real team names.
- **Bug: Notification icon map** — `apps/player/src/app/notifications/page.tsx:9-35`. `NOTIFICATION_ICON_MAP` uses full enum keys (`challenge_received`, `challenge_accepted`, etc.) with prefix fallback. Already correct.
- **Actionable notifications** — `getNotificationHref` routes by type using `metadata.challenge_id`, `metadata.tournament_id`, etc. `NotificationLink` marks as read on click.
- **Scheduled date/time on challenge form** — `apps/player/src/app/challenges/new/page.tsx:242-265`. Date/time inputs wired to `createChallenge`. Done.
- **Season tier helper** — `getSeasonTier` in `packages/shared`. Imported and used on leaderboard (colored dot per rank) and player profile pages.
- **Tier badge on leaderboard rows** — colored dot with title tooltip shown inline with Elo value.
- **Tier badge + Challenge CTA on player profile** — `leaderboard/[playerId]/page.tsx` shows tier badge in header and a "Challenge" button linking to `/challenges/new?opponent=[id]`.
- **Best Partners section on my-stats** — `partnership_stats` queried (min 3 matches, top 5 by win rate), rendered in own section.

### NOT YET DONE — still in the backlog below
- **Bug: Participant confirmation colors wrong** — `apps/player/src/app/challenges/[id]/page.tsx:116-117`. `accepted` and `rejected` both show `bg-[#EF4444]/15 text-[#EF4444]`. `accepted` should be green.
- **Bug: Rating delta color in challenge detail** — `apps/player/src/app/challenges/[id]/page.tsx:161`. Both branches of the ternary are `text-[#EF4444]` — positive deltas should show green.
- **Bug: Confirmed match status shows red** — `apps/player/src/app/challenges/[id]/page.tsx:146`. `confirmed` result status uses same red as `disputed`. Should be `bg-emerald-500/15 text-emerald-400`.
- **Bug: Elo preview Win delta shows red** — `apps/player/src/app/challenges/new/page.tsx:232`. Win delta (`+N`) uses `text-[#EF4444]`. A positive outcome should be green.
- **Bug: Challenge `completed` status badge is red** — `challenges/[id]/page.tsx:50`. `completed` mapped to red; should be neutral (gray) since it's a terminal completed state, not an error.
- **Bug: Challenge `cancelled`/`expired` statuses have no style** — `challenges/[id]/page.tsx:46-52`. Fall through to default. Add gray styles.
- **Admin: Disputes page uses inline styles throughout** — `apps/admin/src/app/disputes/page.tsx`. Entire page uses `style={{...}}` props while every other admin page uses Tailwind. Should be refactored for consistency.
- **Infrastructure: Typecheck + turbo build verification across both apps**.

### Explicitly de-scoped (do not build)
- **Sessions pages** — deleted in Phase 3, stay deleted. Dead `/sessions` links removed from feed.
- **Announcements banner/page** — deprecated in Phase 3. DB tables remain but no UI.
- **Elo history migration + chart** — requires updating `apply_match_result` DB trigger; risky without testing. Tracked in section 3.

---

## 1. Bugs (fix first)

### Participant confirmation colors: accepted = red (wrong)
**File:** `apps/player/src/app/challenges/[id]/page.tsx:115-119`

`confirmColors` maps both `accepted` and `rejected` to `bg-[#EF4444]/15 text-[#EF4444]`. A player seeing "accepted" in red looks like an error.

**Fix:**
```ts
accepted: 'bg-emerald-500/15 text-emerald-400',
rejected: 'bg-[#EF4444]/15 text-[#EF4444]',
pending: 'bg-[#FFD700]/15 text-[#FFD700]',
```

---

### Rating delta in challenge detail always red
**File:** `apps/player/src/app/challenges/[id]/page.tsx:161`

Both branches of the ternary are `text-[#EF4444]`:
```ts
(mp.rating_delta ?? 0) >= 0 ? 'text-[#EF4444]' : 'text-[#EF4444]'
```
Positive ELO gains should show green.

**Fix:** `>= 0 ? 'text-emerald-400' : 'text-[#EF4444]'`

---

### Match result "confirmed" status shows red
**File:** `apps/player/src/app/challenges/[id]/page.tsx:146-148`

```ts
match.result_status === 'confirmed' ? 'bg-[#EF4444]/15 text-[#EF4444]' :
match.result_status === 'disputed'  ? 'bg-[#EF4444]/15 text-[#EF4444]' :
```
Both confirmed and disputed are red. Confirmed should be green.

**Fix:**
```ts
match.result_status === 'confirmed' ? 'bg-emerald-500/15 text-emerald-400' :
match.result_status === 'disputed'  ? 'bg-[#EF4444]/15 text-[#EF4444]' :
```

---

### Elo preview "Win" delta shows red on challenge form
**File:** `apps/player/src/app/challenges/new/page.tsx:231-234`

Win delta (`+N`) uses `text-[#EF4444]` — the same color as the loss delta. A positive outcome shown in red is confusing.

**Fix:** Change the win line to `text-emerald-400` and its icon to `text-emerald-400`.

---

### Challenge `completed` status badge is red; `cancelled`/`expired` have no style
**File:** `apps/player/src/app/challenges/[id]/page.tsx:46-52`

`completed` is mapped to red (error color). `cancelled` and `expired` statuses have no entry and fall through to the default gray — they should have explicit entries.

**Fix:**
```ts
completed: 'bg-white/[0.06] text-[#94A3B8] border-white/[0.06]',    // neutral
cancelled: 'bg-white/[0.06] text-[#64748B] border-white/[0.06]',    // muted
expired:   'bg-white/[0.06] text-[#64748B] border-white/[0.06]',    // muted
walkover_confirmed: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
walkover_pending:   'bg-[#FFD700]/10 text-[#FFD700] border-[#FFD700]/20',
```

---

## 2. Security Gaps (fix before launch/growth)

> All critical server-action security gaps from the previous batch have been fixed (participation asserts, creator guards, atomic RPC for reliability metrics). The items below are lower-priority remaining gaps.

### RLS policy allows unchecked `challenge_participants` inserts
**File:** `supabase/migrations/00005_rls.sql` (challenge_participants INSERT policy)

The INSERT policy uses `WITH CHECK (TRUE)` — app-level guards exist, but a direct API call bypasses them.

**Fix:** Change to `WITH CHECK (player_id = get_player_id(auth.uid()))` so the DB enforces the constraint independently.

---

### Admin middleware `options as any` type cast
**File:** `apps/admin/middleware.ts:21`

`supabaseResponse.cookies.set(name, value, options as any)` bypasses cookie option type safety.

**Fix:** Import `CookieOptions` from `@supabase/ssr` and type `options` accordingly instead of casting.

---

## 3. Missing Features

> Completed from this section: cancel challenge, scheduled date/time inputs, challenge CTA on profile, actionable notifications, best partners, tier badges. Sessions and announcements remain explicitly de-scoped (see below).

### Admin: Dispute "edited" resolution not implemented
**File:** `apps/admin/src/lib/actions.ts` — `resolveDispute()` function

The dispute schema has `resolution_type = 'edited'` but `resolveDispute()` has no branch for it — the edited scores are never applied.

**What's needed:**
- Add an `edited` case that updates `match_games` scores, recomputes `score_summary`, and re-applies Elo.
- Or add a dedicated `editDisputeAndResolve()` server action.

---

### Admin: Disputes page inline styles
**File:** `apps/admin/src/app/disputes/page.tsx`

The entire page uses `style={{...}}` props instead of Tailwind classes, unlike every other admin page. This is inconsistent and harder to maintain.

**Fix:** Refactor to use Tailwind `className` throughout (mirrors the pattern in `players/page.tsx`, `matches/page.tsx`, etc.).

---

### No Elo history
The `ratings` table only stores the current Elo snapshot. There is no `ratings_history` table, so a chart of Elo over time cannot be built from existing data.

**What's needed:**
- New migration: `ratings_history(player_id, singles_elo, doubles_elo, delta, match_id, recorded_at)`
- Append a row inside `apply_match_result` DB function every time Elo changes
- Line chart on `/my-stats` using this data (natural Pro feature gate — free: last 10 points, Pro: full history)

---

## 4. Ease of Use

### Score submission uses "Team A / Team B" not player names
**File:** `apps/player/src/app/challenges/[id]/actions.tsx:157-161`

The winner dropdown shows "Team A" and "Team B". Players don't know which team they are.

**Fix:** Derive actual player names from `participants` prop. Show "Your team (You + Partner)" vs "Opponent (Name + Partner)".

---

### Challenge expiry countdown not shown
Challenges expire 72 hours after creation (`expires_at` column) but there is no timer or warning shown anywhere — on the feed, challenges list, or challenge detail.

**Fix:** Show a relative time countdown ("Expires in 14 hours") on pending incoming challenges. Highlight in yellow when under 12 hours. Also add a cron/background job to mark challenges as `expired` when `expires_at` passes.

---

### Leaderboard fetches all players client-side
**File:** `apps/player/src/app/leaderboard/page.tsx`

All players are fetched inside a `useEffect` with no pagination. This will slow down as the club grows.

**Fix:** Move to a server component with server-side sorting and pagination (e.g., 25 per page). Keep the search client-side or move it to a server action with debounce.

---

### No "View my public profile" shortcut
You can view your own stats at `/my-stats` but you can't see your profile as other players see it. No link to `/leaderboard/[yourId]` exists anywhere.

**Fix:** Add a "View Public Profile" link on the settings page or my-stats page using the current player's ID.

---

### Partnership stats built but invisible
**DB table:** `partnership_stats` — tracks W/L, win rate, avg Elo delta per pair.

This is populated but never shown anywhere. It's genuinely useful for doubles players.

**Fix:** Add a "Best Partners" section to `/my-stats` showing top doubles partners by win rate (min 3 matches together).

---

## 5. New Features to Build (Prioritized)

### Tier 1 — High impact, builds daily retention

#### Achievement Badges
Badges that display on player profiles and unlock based on milestones. Examples:
- **Dragon Slayer** — beat someone 200+ Elo above you
- **Unbreakable** — 10-match win streak
- **Iron Man** — 50 matches played
- **Ace** — first win after 5+ consecutive losses
- **Veteran** — 100 matches played
- **Upset Artist** — beat top-10 player
- **Doubles Dynamo** — 20 doubles wins

**DB:** `player_badges(player_id, badge_key, unlocked_at)`. Award inside `apply_match_result` trigger or a post-confirm job.

---

#### Season Tiers with Visual Rank
Elo-based rank tiers displayed on leaderboard rows and profiles:

| Tier | Elo Range |
|------|-----------|
| Bronze | < 1100 |
| Silver | 1100–1299 |
| Gold | 1300–1499 |
| Platinum | 1500–1699 |
| Diamond | 1700–1899 |
| Elite | 1900+ |

Include tier icon/badge on leaderboard row and profile header. Tier resets each season with soft Elo decay (e.g., pull ratings 10% toward 1200 at season start).

---

### Tier 2 — Depth for serious/competitive players

#### Club Activity Feed
A global feed of all recent rated matches across the club. Each entry shows:
`Alex beat Jamie 21-15, 21-18 (+14 Elo) · 2h ago`

Helps players see who's active, surface rivalries, and give new players a feel for the competitive scene. Pull from `matches` + `match_participants` joined with player names.

---

#### Performance Insights
Pattern analysis surfaced as readable cards on `/my-stats`:
- Win rate by format (bo3 vs single game)
- Win rate vs players above/below your Elo
- Elo gain/loss over last 30 days vs previous 30 days
- Longest streak this season
- Best and worst performing opponents

All derivable from existing match data — no ML needed.

---

#### Elo History Chart *(see also: Missing Features #7)*
Line chart of Elo over time on `/my-stats`. Requires `ratings_history` table (see above). Show singles and doubles on the same chart with toggles. Gate full history behind Pro tier — free users see last 10 data points.

---

### Tier 3 — Communication & coordination

#### Session RSVP
Players can RSVP to upcoming sessions before showing up. The session detail page shows the RSVP list so players can pre-arrange doubles partners.

**DB:** Add `session_rsvps(session_id, player_id, rsvp_at)`.

---

#### Tournament Bracket Viewer
Players can currently register for tournament events but can't see the bracket. Build a read-only bracket visualization:
- Single elimination: tree diagram
- Round robin: standings table

Use existing `tournament_participants`, `tournament_pairs`, and `matches` data.

---

### Tier 4 — Polish

#### QR Code Check-in
Generate a QR code per session (admin side). Player scans it → calls `checkInToSession`. Faster than navigating the app at the courts. Use `qrcode` npm package client-side to render the code.

---

#### Score Photo Upload
Optional photo attachment when submitting a match result. Stored in Supabase Storage. Visible to both players and admins. Nearly eliminates disputes for competitive matches.

---

#### Shareable Match Card
After a confirmed result, generate a social share card (OG image via `@vercel/og` or canvas):
- Both player names
- Score
- Elo delta
- Date and tier badge

"Share to Stories" button. Free organic marketing.

---

#### Rivalry Tracker
A "Rivals" section on `/my-stats` surfacing your top recurring opponents — most matches played, current H2H record, last match date, and who has momentum. Pull from `head_to_head_stats` ordered by `total_matches desc`.

---

## 6. Monetization Gate (Pro Tier)

Features to gate behind a future Pro subscription:
- Full Elo history chart (free: last 10 points)
- Full match history (free: last 10 matches)
- Full H2H breakdown on other players' profiles (free: basic Elo + record only)
- Performance insights (full analytics)
- Priority tournament registration window (24h early)
- Custom profile badge

Keep free: leaderboard, challenges, tournaments, sessions, basic stats, match history (capped), notifications.

---

## Implementation Order

1. **Fix color bugs** (section 1, ~30 min) — all in `challenges/[id]/page.tsx` and `challenges/new/page.tsx`, small diffs
2. **Fix RLS gap** (section 2) — one SQL migration line change
3. **Admin disputes page refactor** (section 3) — replace inline styles with Tailwind
4. **Admin dispute "edited" flow** (section 3) — implement the missing resolution branch
5. **Tier 1 features** — achievement badges (highest retention impact)
6. **Tier 2 features** — activity feed, performance insights, Elo chart
7. **Tier 3 & 4** — QR check-in, share card, rivalry tracker
