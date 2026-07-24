# Full-codebase bug audit

> ## Round-2 discovery (deep-dive agents: fees, tournaments, auth)
> **Fixed this session:** fee_exempt/active_flag self-escalation (migration `00020`) —
> the standout money hole (a player could self-set `fee_exempt=true`, owe $0, and
> vanish from the collection list).
>
> **Tournament system — NOT fixed (needs the tournament flow tested; likely not a
> day-1 beta path):**
> - **T1 (HIGH):** single-elim bracket advancement is fully broken —
>   `tournament-actions/brackets.ts:101` indexes `matchesByRound[round]` instead of
>   `[round+1]`, so `winner_to_match_id` is always null → no advancement, byes drop
>   players, and `finalizeEvent` places everyone at position 2. Single-elim is
>   non-functional end to end. **Fix = `round + 1` + re-test a full bracket.**
> - **T4 (MED, privacy):** `tournament_events/participants/pairs/matches` SELECT
>   policies omit `TO authenticated` → the anon key can enumerate all player_ids /
>   pairings / match history (`00005_rls.sql:426-429`). Confirm whether a public
>   bracket view is intended before locking to authenticated.
> - T2 self/duplicate pair, T3 registration race, T5 regenerate-mid-event wipes
>   scores, T6 walkover-edit drops Elo, T7 count includes withdrawn, T9 no state
>   guards on no-show/withdraw/DQ, T10 result-entry on half-populated match.
>
> **Fees — remaining (admin-gated, lower urgency):** reinstatement non-atomic,
> waiveFee overwrites a prior payment with no old-value audit, fee `amount_cents`
> unbounded (INTEGER overflow), markFeePaid suspended-competitive undercharge + silent
> null-amount.
>
> **Auth/security deep-dive:** passkey flow, redirects, service-role scoping, and
> gate-completeness all verified CLEAN. Findings:
> - **A1 (HIGH) — match forgery, now MITIGATED:** `mp_insert` lets a match's
>   `submitted_by` self-enroll ANY player (incl. a victim) as a participant, so the
>   00019 participant guard alone was bypassable (fabricate match w/ nullable
>   challenge_id → enroll self+victim → confirm). **Fixed** by also blocking
>   submitter=confirmer in `00019` (the forgery needs submitter to also confirm).
>   Residual: two colluding accounts can still forge a match *between themselves*
>   (self-harm only) — real fix is a create-match RPC that derives participants from
>   an accepted challenge; deferred.
> - **A3 (MED→fixed):** submitter could confirm their OWN result (skip the opponent's
>   attestation) — same `00019` self-confirm block closes it. TODO: also hide the
>   Confirm button from the submitter in `challenges/[id]/actions.tsx` (UX/defense).
> - **A2 (MED→fixed):** `adminCreateChallenge`/`forceExpireChallenge` were exec-gated
>   though `/challenges` is admin-only → switched to `getAdminPlayer`.



> ## Fix log (this session)
> **Fixed + deployed/applied:** S1–S5 + M7 (migration `00018`, applied & verified on prod) ·
> H1 dispute resolution · H5 compression baseline · L9 team-rating NaN · M1 recent-match
> ordering · M2 dashboard names · M3 announcement expiry/audience · L1 feed avatar ·
> #4 challenge/match + check-in error messages · #1 challenge RLS · #6 feed opponent.
> (Code fixes ride the CI rebuild; H5 is an edge function — deploy separately.)
>
> **Still open (recommend doing tested, not pre-beta):** H2/M6 matches_update ELO-dodge &
> apply_match_result participant guard (needs a matches trigger / dispute RPC — the
> definer-context `auth.uid()` makes a naive trigger break legit confirms, so do it
> carefully) · H4 submitMatchResult atomicity (needs a create-match RPC) · H3 remaining
> error-message modules · M4/M5 accept/register races · M8/M9 + LOW items.



Whole-codebase review (player app, admin app, shared packages, edge functions, DB
migrations) by 5 parallel review agents, then triaged by hand. Ordered by severity.
"Status" marks what's fixed vs pending as of this pass.

> ## ⚠️ Must-fix before beta (security — a tester can exploit these)
> **S1 self-promote to admin**, **S2 private feedback world-readable**,
> **S3/S4/S5 admin-only RPCs callable by any player** (void matches / reset the
> ladder / forge walkover suspensions). All fixed in migration **`00018`** below —
> **apply it to prod before letting real users in.**

---

## CRITICAL — security / privilege escalation (DB)

### S1. Any player can promote themselves to admin
`supabase/migrations/00005_rls.sql:54-56` (`players_update_own`)
`players_update_own` constrains only `user_id = auth.uid()`, not *which columns*
change (unlike `players_self_insert`, which pins role/status). No column GRANT or
trigger guards it.
**Exploit:** a normal user runs `supabase.from('players').update({ role: 'admin' }).eq('user_id', myUid)` → `is_admin()` now true → full read/write on every table. Same path sets `status='active'` (self-unsuspend), `is_banned=false`, `is_exec=true`, etc.
**Fix (00018):** BEFORE UPDATE trigger blocking non-admin changes to privileged columns.

### S2. `event_feedback` has RLS disabled — private feedback is world-readable/writable
`supabase/migrations/00001_schema.sql:327` (never enabled in `00005_rls.sql`)
Table comment says feedback is "private to the exec team." With RLS off, Supabase's
default `authenticated` grants are unchecked.
**Exploit:** any authenticated user `select('*')`s every member's attributed feedback, or inserts/updates/deletes arbitrary rows.
**Fix (00018):** enable RLS + insert-own / admin-read policies.

### S3. `reverse_match_result` — any player can void any match & reverse Elo
`00003_functions.sql:708`, made `SECURITY DEFINER` by `00017:28` (regression introduced this session)
Only ever called by the admin service-role client, so it never needed definer — but
`00017` made it definer and left the default `EXECUTE TO PUBLIC`, with no in-body
`is_admin` check.
**Exploit:** any player `rpc('reverse_match_result', { p_match_id })` → match voided, everyone's Elo from it reversed. Void every loss on the ladder.
**Fix (00018):** `REVOKE EXECUTE ... FROM public/anon/authenticated`, `GRANT ... TO service_role`.

### S4. `activate_season` — any player can reset the entire ladder
`00003_functions.sql:160` (`GRANT EXECUTE ... TO authenticated`, no admin check)
**Exploit:** any player `rpc('activate_season', { p_season_id, p_elo_policy:'full' })` → every `ratings` row reset to 400/provisional, `matches_played=0`, active-season flag flipped.
**Fix (00018):** revoke public/authenticated execute; service-role only.

### S5. `apply_walkover_result` — forge walkover penalties, auto-suspend a victim
`00003_functions.sql:485` (definer, default PUBLIC execute, `p_admin_id` is caller-supplied)
**Exploit:** attacker files a `no_show` walkover vs a victim (allowed by `walkovers_insert`), then `rpc('apply_walkover_result', { p_walkover_id, p_admin_id: self })` → Elo penalty + `no_shows++` on the victim; repeat to cross the threshold and trip `trigger_check_noshow_threshold` → **victim auto-suspended**.
**Fix (00018):** revoke public/authenticated execute; service-role only.

---

## HIGH

### H1. Admin dispute resolution is broken for 3 of 4 paths
`apps/admin/src/lib/actions/disputes.ts:25-40`, `matches.ts:19,49`
A disputed match has `result_status='disputed'`, but the void/convert branches call
`reverse_match_result` (requires `confirmed`) and the accept branch calls
`apply_match_result` (requires `pending_confirmation`) → all three RPCs raise. Only
the `edited` branch works (it first forces `pending_confirmation`).
**Effect:** admin picks Void / Convert-to-casual / Accept → throws, dispute stuck `disputed` forever. **Status: pending fix.**

### H2. Self-admin / ladder-reset via matches_update — participant can dodge an Elo loss
`00005_rls.sql:173` (`matches_update`)
Policy lets a participant UPDATE the match row with no column/state restriction.
**Exploit:** a losing participant `update('matches').set({ result_status:'confirmed', winner_side:<their side> })` → permanently blocks legit `apply_match_result` (Elo loss never applied) while firing `on_match_confirmed` which credits h2h/partnership stats in their favor.
**Status: pending** (needs a state-transition guard; the dispute flow also writes `result_status='disputed'` here, so the fix must still allow that).

### H3. Systemic thrown-error redaction outside the challenge/match flow
`apps/player/src/lib/actions/{sessions,profile,feedback,notifications,calendar}.ts`, `apps/player/src/lib/tournament-actions.ts`, and all `apps/admin/src/lib/actions/*`
These still `throw new Error(...)`; Next.js redacts thrown Server Action messages in
prod. So check-in ("Already checked in", "Check-in opens at 6:00 PM"), event
registration ("Event is full", "You must accept the event waiver"), and every admin
validation message become a generic digest.
**Status: check-in extended this pass (see below); the rest pending** — the `runAction`/`ActionResult` pattern from `challenges.ts` should be applied module-by-module.

### H4. `submitMatchResult` — 3 non-transactional writes can wedge a match forever
`apps/player/src/lib/actions/matches.ts:70-143`
Match row (UNIQUE `challenge_id`) inserts first; participants/games inserts follow with
no transaction/cleanup. If the games insert fails, an orphan `pending_confirmation`
match with 0 games exists: re-submit is blocked by the UNIQUE guard, and confirm fails
("No decisive games recorded"). No player recovery path.
**Status: pending** (fix = wrap in a SECURITY DEFINER RPC, single transaction).

### H5. Season compression pulls ratings toward 1200, not 400
`supabase/functions/_shared/constants.ts:2` (`DEFAULT_ELO=1200`) vs live 400-nominal ladder
Compression computes `elo + 0.15*(1200 - elo)` → ratings drift *upward* instead of
regressing to the mean; over seasons the whole distribution inflates.
**Status: pending** (one-line: 1200 → 400 in the Deno constant; edge fn, not in the app image).

---

## MEDIUM

### M1. "Recent matches" ordering is a silent no-op (feed / my-stats / profile)
`apps/player/src/app/feed/page.tsx:52`, `my-stats/page.tsx:24`, `leaderboard/[playerId]/page.tsx:24`
`.order('created_at', { referencedTable: 'matches' })` sorts a *to-one* embed → no-op.
Parent `match_participants` come back in physical order, then `.limit(N)` truncates an
arbitrary set → "recent" matches are neither recent nor ordered. **Status: fixing this pass.**

### M2. Admin dashboard "Recent Matches" shows blank names
`apps/admin/src/app/dashboard/page.tsx:36` vs `:210` — embed omits `team_side`, render filters on it → `sideA`/`sideB` always empty. **Status: fixing this pass.**

### M3. Announcements ignore `expires_at` and `target_audience`
`apps/player/src/app/announcements/page.tsx:32` — no expiry/audience filter (RLS doesn't enforce it either) → expired & off-division announcements leak to everyone. **Status: fixing this pass.**

### M4. `acceptChallenge` recomputes status from a stale snapshot (race)
`apps/player/src/lib/actions/challenges.ts:160` — concurrent doubles accepts both compute `allAccepted=false` → challenge stuck `partially_confirmed`, result submission refused. **Status: pending** (canonical fix = SECURITY DEFINER RPC recomputing under a row lock).

### M5. `registerForEvent` capacity check is a non-atomic count-then-insert (race)
`apps/player/src/lib/tournament-actions.ts:65` — two simultaneous registrations both pass the `count < max` guard → cap exceeded. **Status: pending** (needs a DB constraint or locked count).

### M6. `apply_match_result` has no in-function participant check
`00003_functions.sql:290` — any authenticated user can `rpc()` force-confirm a pending match they aren't in, and forge `confirmed_by`/`audit_logs.actor_id`. **Status: pending** (add in-body participant + `is_admin` guard).

### M7. `season_final_ratings` RLS disabled
`00001_schema.sql:236` — any authenticated user can tamper with archived season Elo history. **Status: fixing in 00018.**

### M8. `adminCreateMatch` / `resolveDispute(edited)` non-atomic multi-writes
`apps/admin/src/lib/actions/matches.ts:157,165`, `disputes.ts:47-80` — unchecked participant/games inserts; a mid-sequence failure leaves a corrupt/half-edited match then calls `apply_match_result` on it. **Status: pending.**

### M9. Schema validation gaps
`packages/shared/src/validators/schemas.ts` — `adminMatchCreateSchema` (:226) allows a player on both sides / singles-with-2-per-side / wrong games count; `challengeCreateSchema` (:36) doesn't link partners to `type`. (challengeCreate is re-validated server-side by `validate_challenge_creation`; adminMatchCreate's DB re-validation is partial.) **Status: pending.**

---

## LOW

- **L1.** Feed pending-challenge avatar reads unselected `creator.id` → wrong avatar color. `feed/page.tsx:39` vs `:243`. **Fixing this pass.**
- **L2.** Session reminders compute "tomorrow" in UTC not club time → can target the wrong day (evening PT). `send-session-reminders/index.ts:15`.
- **L3.** `send.ts:53` rethrows transient push errors inside `Promise.all` → one flaky endpoint aborts delivery + fails the action.
- **L4.** `disputeMatchResult` no status guard + non-atomic (`matches.ts:241`); can dispute an already-confirmed/voided match.
- **L5.** `deleteTournament` no state guard, incomplete cascade (`tournaments.ts:211`).
- **L6.** `updateTournamentStatus`/`updateTournament` accept unvalidated status/fields (`tournaments.ts:57,83`).
- **L7.** `increment_challenges_issued` accepts an arbitrary `p_player_id` → inflate another player's counter. `00003:817`.
- **L8.** `walkoverReportSchema.notice_hours` unbounded/negative; `sessionCreateSchema` dates skip the ISO regex. `schemas.ts:199,114`.
- **L9.** `calculateTeamRating([])` → NaN (empty array div-by-zero). `elo/engine.ts:88`.
- **L10.** No-show detection re-alerts every run + unchecked audit-log write on auto-suspend. `detect-noshow-patterns/index.ts:57`.
- **L11.** `reinstatePlayer` records a paid reinstatement then un-bans in a separate write; `endSeason` doesn't verify the season is active. `reinstatement.ts:55`, `seasons.ts:92`.
- **L12.** `markAnnouncementRead` read-then-insert race → unhandled unique-violation. `notifications.ts:33`.

---

## Cross-cutting patterns
1. **Admin-only RPCs gated only at the app layer** (service-role client) but left `EXECUTE TO PUBLIC` with no in-body `is_admin` check → S3/S4/S5/M6/L7. Blanket `REVOKE EXECUTE FROM public, anon, authenticated` on admin-only functions closes most.
2. **PostgREST embed field/alias mismatches hidden by `as unknown as` casts** → the original feed #6 bug, M2 dashboard, L1 avatar. Grep every `as unknown as`/`as Record<string,unknown>` over a Supabase embed.
3. **Non-atomic multi-write server actions** → H4, M8, M4/M5 races. Move to SECURITY DEFINER RPCs / transactions.
4. **Thrown-error redaction** → H3 everywhere outside the challenge/match flow.
5. **Cron jobs treat every write after the first select as fire-and-forget** → H5, L10 partial-apply.

---

## Recommended order for beta
1. **Apply `00018` (security criticals S1–S5, M7) — before real users.**
2. Ship the code fixes in this pass (M1/M2/M3/L1 + check-in error messages).
3. Next: H1 dispute resolution, H2/M6 matches_update guard, H4 submitMatchResult atomicity.
4. Then the MEDIUM races (M4/M5), validation (M9), and LOW items.
