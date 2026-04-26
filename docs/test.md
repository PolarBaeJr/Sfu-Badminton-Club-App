# Pre-Prod Test Plan

Walk these in order. Categories 1–3 cover the bugs caught/fixed this session
and ~90 % of what users will hit. 4–5 are nice-to-have edge cases.

Staging is at https://test.polardev.org and uses the **dev Supabase**
(`badminton_dev` on the Pi). It's seeded daily from prod by the cron at 4 AM —
manually re-snapshot any time with `~/ssd/Deploy/badminton-staging/scripts/prod-to-dev-snapshot.sh`.

---

## 1. Challenge lifecycle (most important — covers the RLS bugs)

- [ ] **Singles accept** — A challenges B → B accepts → status flips to `accepted`, Cancel button disappears for A.
- [ ] **Singles reject** — A challenges B → B rejects → status `rejected`, no further actions on the page.
- [ ] **Doubles accept** — A challenges B with partner C, opponent partner D. All three non-creator participants must accept before status flips to `accepted`. Rejecting any one terminates the challenge.
- [ ] **Match submit** — accepted challenge → A submits result → B confirms → ELO updates, win/loss writes, both players' streaks/W-L update.
- [ ] **Match dispute** — same flow but B disputes instead of confirms → admin sees the dispute → admin resolves with **Edit Result** (new path) → match_games rewritten, ELO applied against the corrected score.
- [ ] **Walkover** — A reports B as no-show → status `walkover_pending` → admin reviews + confirms → forfeit penalty applied.

## 2. Auth / authorization gates (regression check after middleware fix)

- [ ] Hit `/admin/dashboard`, `/admin/players`, `/admin/disputes` in incognito → land on `/admin/login`, never on the page itself.
- [ ] Sign in as a `role='player'` account on `/admin/...` → bounce to `/admin/unauthorized`.
- [ ] Magic link sign in (creates an unconfirmed user, lands on /onboarding for a brand-new account).
- [ ] Google OAuth sign in (after the test.polardev.org redirect URI is added to the Google Cloud OAuth client).
- [ ] Sign out from `/settings` → land on `/login`, session cookies cleared.
- [ ] Hit any player route while signed out → bounce to `/login`, not a 500.

## 3. Admin actions actually mutate state

- [ ] Approve a `pending_approval` player → status flips to `recreational`/`competitive`, that player can now sign in and use the app.
- [ ] Void a confirmed match → both players' ELO reverses, match flagged voided, stats decremented.
- [ ] Convert a confirmed match to casual → ELO reverses, match flagged casual, doesn't count for stats.
- [ ] Resolve a dispute with **Edit Result** → enter corrected scores, pick winner, save → match_games replaced, ELO applied with the corrected score.

## 4. Schema-vs-UI edge cases

- [ ] Bring a player to exactly 8 singles matches → `provisional` flag flips false, K-factor drops 40 → 24 in subsequent matches.
- [ ] **Race**: two accepts hitting the server within the same second on a doubles challenge → stale-snapshot bug in `acceptChallenge` (still open as P2-2; canonical fix is a SECURITY DEFINER RPC).
- [ ] BO3 match where game 3 wasn't played → submit form should accept 0–0 for game 3 and not include it in the score summary.
- [ ] Phone validator rejects non-numeric ("abc", emoji, very long strings) — server-side, not just client.
- [ ] Account with zero matches → feed, my-stats, leaderboard render cleanly without empty-state crashes.

## 5. Mobile (390 px wide)

- [ ] Bottom tab bar visible, desktop top-nav hidden, brand-mark + icon buttons only.
- [ ] Feed hero banner stacks; the 4 stat cells become a 2×2 grid.
- [ ] Leaderboard / match-history tables scroll horizontally with a sticky first column.
- [ ] Modals (challenge form, dispute form) slide up from the bottom and the footer buttons stack.
- [ ] `/login` and `/onboarding` split-screen collapses to stacked panels.

---

## Infra / observability checks (do once before merging to prod)

- [ ] **Snapshot manually**: `ssh pi-remote ~/ssd/Deploy/badminton-staging/scripts/prod-to-dev-snapshot.sh` — verify it completes and `~/ssd/Deploy/badminton-snapshots/cron.log` gets a new entry.
- [ ] **Sentry** receives staging errors — trigger a server error on staging (e.g. submit a match for a non-existent challenge ID) and confirm it shows up in Sentry.
- [ ] After prod merge, watch the first auth flow on `badminton.polardev.org` in incognito to confirm middleware fires there too — same misplaced-`middleware.ts` bug exists on prod's current `deploy/docker-prod` until the merge lands.

## Bugs known-fixed this session (do not need re-testing on staging — already verified)

- Admin auth bypass (`getAdminPlayer`)
- RLS WITH-CHECK-TRUE on `match_participants` / `challenge_participants`
- ELO function dedupe (00017)
- Self-onboarding RLS (00018)
- Missing participant verification on `acceptChallenge`/`rejectChallenge`/`reportWalkover`
- `submitMatchResult` duplicate-submit guard
- Validator hardening (phone/display_name/scheduled_date/scheduled_time)
- Hand-rolled cookie parser in admin auth callback
- Hero banner dark-mode unreadable text
- `permission denied for schema public` after snapshot (script now re-grants)
- Challenges/new opponent dropdown 400 (dead `inactive` enum value)
- Accept/reject silently no-op on `challenges.status` (RLS) → service-role client
- Misplaced `middleware.ts` (both apps) — auth gate never ran
- Dropdown clipped by table overflow → portal'd to `document.body`
