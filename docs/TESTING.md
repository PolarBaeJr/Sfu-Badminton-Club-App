# Testing Plan

The plan for verifying the app before and during the exec beta. Two layers:
**automated** (fast, runs on every change) and **manual QA** (role- and
device-based walkthroughs of real flows). Work top-down: keep the automated
suite green, then walk the manual checklists — **P0** items gate the beta, **P1**
are important, **P2** are edge cases.

> Roles used throughout: **Player** (member), **Exec** (day-to-day management),
> **Admin** (execs + sensitive areas). Test each gate from the *lowest* role that
> should be denied, not just the one that's allowed.

---

## 0. Environments & setup

| | |
|---|---|
| **Production** | `badminton.polardev.org` (player) · `/admin` (console). Self-hosted Supabase on the Pi. |
| **Deploy** | push `deploy/docker-prod` → CI builds → dashboard **auto-update** recreates the containers. |
| **Test data** | Prod is now live data — do **not** create junk that pollutes the ladder. Use a small set of throwaway member accounts you can delete, or a dedicated "QA" season. |
| **Emails** | Never send test mail to fake addresses (hurts Resend reputation). Use a real inbox you control (e.g. `wkc10@sfu.ca`). |
| **Devices** | At minimum: one desktop browser, one iOS Safari (PWA), one Android Chrome (PWA). |

Before a beta round: snapshot the DB (`backup/backup-db.sh`) so you can restore if a test corrupts data.

---

## 1. Automated tests (run first, keep green)

Current suite (vitest) — pure logic, no DB:

```
npm test                              # all workspaces via turbo
npm run test --workspace=@badminton/shared
npm run test --workspace=apps/admin
```

Covers: ELO engine, Zod validators, session-window math, legal/waiver expiry
logic, ICS generation, push payloads, passkey cookie signing, admin
supabase-server guards.

**Added 2026-07-23 (suite now 301 passing):**
- [x] `eventWaiverHash` — determinism, trim, edit-invalidation, hex shape, known vector (`event-waiver.test.ts`; helper extracted to `packages/shared/src/utils/event-waiver.ts`).
- [x] `getMissingLegalDocuments` — combined global `reacceptance_required_since` + per-player `waiver_reset_at` threshold (`Math.max`) and empty-docs edge (extended `legal.test.ts`; annual-expiry + version cases were already covered).
- [x] `sessionIntentSchema` — accepts going/declined, rejects invalid (`schemas.test.ts`).

**Still to add (P1):**
- [ ] RSVP intent *transitions* (going ↔ declined ↔ cleared) + the "N going" count — DB/component logic, not pure; covered by the e2e layer below (or extract a pure count helper to unit-test).
- [ ] A lightweight **e2e** layer (Playwright) for the P0 flows — none exists yet.

> ⚠️ CI (`build-images.yml`) does **not** run tests — it only builds images. Run `npm test` locally before every push, or add a test job to CI (recommended).

---

## 2. Auth, access & navigation  — **P0**

- [ ] **Signed-out public bar** — in a private window, `/` and `/leaderboard` show only the public nav (brand, Leaderboard, Execs placeholder, Sign in). **No** Feed/Challenges/Schedule/Tournaments/My Stats. *(regression: this session)*
- [ ] **Signed-in member bar** — after login, full member nav appears; brand → `/feed`.
- [ ] **Landing not hijacked** — a logged-in, onboarded user visiting `/` sees the landing (no bounce to `/feed`); its CTAs read "Enter the app".
- [ ] **Exec Panel button** — exec/admin sees the "Exec Panel" button in the member bar → opens `/admin`. A plain player does **not** see it.
- [ ] **Player route while signed out** → bounces to `/login` (not a 500).
- [ ] **Onboarding** — a brand-new account lands on `/onboarding`, must accept legal docs (see §3) before reaching the app.
- [ ] **Passkey admin gate** *(P0, this session)* — an admin/exec who has **not** enrolled a passkey hitting `/admin/*` → redirected to `/unavailable` with a "log in with passkey" button. After enrolling a passkey → full admin access.
- [ ] **Exec gated too** — confirm execs are subject to the passkey gate, not just admins.
- [ ] **Sign out** from `/settings` → `/login`, cookies cleared, back-button doesn't restore the session.

---

## 3. Legal documents & waivers  — **P0**

- [ ] **Onboarding acceptance** — new member must accept all four docs (terms, privacy, waiver, code of conduct) before playing; acceptances recorded.
- [ ] **Public reading** — `/legal/terms` and `/legal/privacy` load without login.
- [ ] **Version bump** — Admin edits a doc with **Save & require re-acceptance** → every member is prompted to re-accept on next visit before they can act.
- [ ] **Global force re-sign** — Admin → Settings → Legal → **Require re-signature now** → the themed confirm dialog (not a browser popup) → all members must re-sign on next visit. *(regression: dialog is now themed)*
- [ ] **Per-player force re-sign** — on a member's page, **Require waiver re-signature** → only that player is prompted next visit.
- [ ] **Annual waiver renewal** — a member whose waiver acceptance is >365 days old is prompted to re-sign (verify with a back-dated acceptance in a test row).
- [ ] **Event-specific waiver** — add `waiver_text` to a tournament event → a player registering must read + accept it before registration completes; editing the text re-requires acceptance.

---

## 4. Ladder, challenges & matches  — **P0**

- [ ] **Singles accept/reject** — A challenges B → B accepts → `accepted`, A's Cancel disappears. Reject path ends cleanly.
- [ ] **Doubles** — A + partner C vs D + partner; all three non-creators must accept; any rejection terminates.
- [ ] **Cancel challenge** — themed confirm dialog → opponent notified. *(regression: dialog)*
- [ ] **Match submit → confirm** — ELO updates for both, W/L + streaks + points write, and the *same* numbers show in app and DB.
- [ ] **Dispute** — B disputes → admin resolves via **Edit Result** → games rewritten, ELO applied against the corrected score.
- [ ] **Walkover** — A reports B no-show → admin confirms → forfeit penalty applied.
- [ ] **Provisional** — a new player's first 8 matches per format move faster, then settle; provisional flag clears.
- [ ] **Rating bounds** — ratings never exceed the cap or crash to zero across a long sequence.

---

## 5. Sessions, attendance & RSVP  — **P0/P1**

- [ ] **Create session** *(exec)* — date, venue, track (comp/rec/all); attaches to active season.
- [ ] **Recurring sessions** *(P1)* — "repeat for the semester" creates the series; **date exclusions** ("repeat until except this") omit the right dates.
- [ ] **Check-in window** — self check-in works during the window and is **rejected after** the session ends (enforced by the DB, not just UI). Verify the "Opens at …" state before the window.
- [ ] **RSVP** *(P0, this session)* — on Schedule, **Going / Can't make it** toggles set intent; clicking the active choice clears it; the **"N going"** count updates. RSVP works any time the session is open (independent of the check-in window).
- [ ] **Admin RSVP visibility** — admin session view lists Going (N) / Can't make it (N) with names.
- [ ] **Attendance marking** *(exec)* — mark present / no-show / excused, add a walk-in; every mark is audit-logged; no-shows don't inflate the "attending" count.
- [ ] **Reliability** — a player's My Stats reflects late/missed marks accurately (was previously a wrong-column bug — verify the numbers are real).

---

## 6. Calendar feed  — **P1**

- [ ] **Subscribe** — Settings → copy the webcal/ICS link → add to Google/Apple Calendar → future sessions appear; times are correct (America/Vancouver, DST-safe).
- [ ] **Deep-link** — tapping a calendar event opens `/sessions?s=<id>` and scrolls/flashes that session.
- [ ] **Reset token** — themed confirm → old link stops updating, new link works. *(regression: dialog)*
- [ ] **Bad/invalid token** → 404, not a stack trace. Rate-limit holds under rapid requests.
- [ ] **Suspended player** — feed still returns their track-appropriate sessions only.

---

## 7. Tournaments  — **P1**

- [ ] **Lifecycle** — draft → active → completed → archived.
- [ ] **Events** — multiple events per tournament, each: registration → check-in → bracket → live → completed.
- [ ] **Registration + check-in** — player self-registers (with event waiver if set); admin bulk check-in works.
- [ ] **Bracket + results** — seeding, bracket generation, entering results, finalize → placement points applied.
- [ ] **Withdraw** — themed confirm → removed from the event. *(regression: dialog)*
- [ ] **Suspension** *(P1)* — a suspended player can't register/participate.

---

## 8. Seasons & fees  — **P1**

- [ ] **Create + activate** a season with comp/rec fee amounts; only one active at a time.
- [ ] **Reset policy** — keep / soft-compress / full-reset, each behind a confirm; previous season snapshotted.
- [ ] **Fees** — per-member tracking; **waive** a fee (themed confirm) → excluded from outstanding count; **fee-exempt** flag; **one-time semester skip**.

---

## 9. Accounts, privacy & members  — **P0**

- [ ] **Delete account** *(player)* — Settings → Danger zone → **Delete account** (themed confirm) → 30-day grace; the deletion gate shows on next login with a restore option.
- [ ] **Self-restore** within 30 days → account fully active again.
- [ ] **Admin restore** — admin clears a pending deletion within the window.
- [ ] **Purge** — after 30 days the purge edge function anonymizes the row (match/rating history retained, PII gone). *(verify function is scheduled + ran.)*
- [ ] **Member tabs** — Active / **Suspended** / **Inactive** tabs each show the right set.
- [ ] **Roles** — role dropdown includes Executive; **Add Player cannot create an Admin** account (only Player/Executive).
- [ ] **Sign-out placement** — sign-out is **not** in the danger zone; Delete account **is**.

---

## 10. Admin console  — **P1**

- [ ] **Audit log** — sort by **operator** (A–Z / Z–A, System sorts last) and by **time** (newest/oldest); category filter narrows correctly. *(regression: this session)*
- [ ] **Settings editors** — platform settings edit as one row per value (not raw JSON); saving persists.
- [ ] **Every mutating admin action** writes an audit row (spot-check 3–4: approve player, mark attendance, edit result, waive fee).
- [ ] **Mobile admin** — the settings rail doesn't overlap/stack; the players page doesn't overflow horizontally on a phone. *(regression: this session)*

---

## 11. Notifications & reminders  — **P1**

- [ ] **Web push** — subscribe from a member device (HTTPS/PWA) → receive a challenge/announcement push.
- [ ] **Email** — challenge received/accepted, result pending, session reminder land (to a real inbox).
- [ ] **Session reminder cron** — fires on schedule (check the edge-function logs / an actual reminder).
- [ ] **Announcement** — posting an announcement badges the feed nav and can auto-expand a long draft in the composer.

---

## 12. UI, design & PWA  — **P1**

- [ ] **Themed confirms everywhere** — no native browser `confirm()` remains anywhere (challenge cancel, event withdraw, passkey/note/session delete, fee waive, waiver re-sign, calendar reset, attendance remove, session archive). All use the black/red Dialog with a red **danger** button on destructive actions. *(regression: this session)*
- [ ] **Success toast** — reads as a dark toast with a green left-accent (not a candy-green slab); error stays solid red. *(regression: this session)*
- [ ] **Design consistency** — true-black `#0a0a0a`, pure-red `#C00`, Barlow fonts, hairlines, square corners (dialogs rounded) across both apps.
- [ ] **PWA install** — installs on iOS + Android; manifest, service worker, icons load; toasts sit above the mobile tab bar.
- [ ] **Responsive** — no horizontal body scroll on a phone; tap targets ≥ 44px.
- [ ] **Theme** — light/dark both legible.

---

## 13. Observability — verify it's actually recording  — **P1**

- [ ] **Sentry client error** — trigger a client render error (e.g. a bad route action in a test build) → an issue appears in Sentry, tagged with the player id, **readable stack** (source maps uploaded).
- [ ] **Sentry server error** — force a server-action failure (e.g. a bad input to a mutation) → captured server-side with the `action` extra. Confirm server Sentry works from the **baked** DSN (no runtime env needed).
- [ ] **global-error** — an error thrown in the root layout renders the fallback and reports.
- [ ] **PostHog events** — as a member, do a pageview, view the leaderboard, create a challenge, RSVP → those events (`leaderboard_viewed`, `challenge_created`, `session_rsvp`, pageview) show in PostHog, attributed to the player. Confirm **no** session replay / no cookies.

---

## 14. Security & RLS spot-checks  — **P0**

- [ ] **RLS on the browser client** — as Player A, attempt to read/modify Player B's private rows (via devtools/network) → denied by RLS.
- [ ] **Self-only writes** — a player can only set their own RSVP / check-in / calendar token; not another's.
- [ ] **Admin-only mutations** — a player-role session can't reach admin server actions (they run service-role behind role checks).
- [ ] **No secrets client-side** — grep the shipped bundle for service-role key / auth tokens (should be absent; only the public anon key + public Sentry/PostHog keys).
- [ ] **Legal/waiver enforcement** — a member missing a required acceptance is blocked from the gated actions server-side (not just hidden in the UI).

---

## 15. Beta exit criteria (sign-off)

Ship/continue the beta when:
- [ ] Automated suite green (`npm test`).
- [ ] **All P0** items above pass on prod with a real account per role.
- [ ] No unresolved Sentry issue at error level from the P0 walkthrough.
- [ ] A fresh member can go signup → onboarding (legal) → check-in/RSVP → challenge → result **without help**.
- [ ] An exec can run a session end-to-end (create → attendance → close) **without help**.
- [ ] A DB backup was taken immediately before the round.

---

## Bug reporting

For each bug: **what you did → what you expected → what happened**, plus role,
device/browser, timestamp, and the Sentry link if it errored. File in the
project tracker; tag P0/P1/P2 to match this plan. P0s block; batch P1/P2 for
the next deploy.
