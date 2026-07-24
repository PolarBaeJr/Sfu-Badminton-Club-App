# Remaining-bug fix plan (3-hour window)

Ordered for value-per-risk. Everything above the "STRETCH" line fits comfortably
in ~3h with verification and is low-risk. The traps are called out explicitly.

Deploy reminders: code fixes → commit to `deploy/docker-prod` → CI rebuild → Pi
auto-update. DB fixes → new numbered migration, dry-run (`BEGIN…ROLLBACK`) then
apply via `ssh pi "docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1" < <file>`.
Edge-fn fixes → `supabase functions deploy <name>` (separate path).

---

## Recommended order

### 1. H3 — real error messages everywhere else  ·  ~40 min  ·  LOW risk  ·  HIGH beta value
Testers hit validation constantly ("Event is full", "Already registered", "Only an
active tournament can be suspended"); in prod these are currently the generic
redacted digest. Extend the `runAction` / `ActionResult` pattern already used in
`challenges.ts`/`matches.ts`/`sessions.ts(check-in)`.

- **Pattern (repeat per action):** rename `export async function X(args)` →
  `async function XImpl(args)` (body unchanged), add
  `export async function X(args): Promise<ActionResult<T>> { return runAction(() => XImpl(args)); }`.
  Then in the client caller: `const res = await X(...); if (!res.ok) { toast(res.error,'error'); return; }`.
- **Player modules:** `lib/actions/sessions.ts` (setSessionIntent, cancel…),
  `lib/tournament-actions.ts` (registerForEvent, withdraw…), `lib/actions/profile.ts`,
  `lib/actions/feedback.ts`, `lib/actions/notifications.ts`, `lib/actions/calendar.ts`.
- **Admin modules:** `lib/actions/{players,fees,matches,tournaments,sessions,disputes,
  walkovers,seasons,reinstatement}.ts` + their client callers under `app/**`.
- **How to run it fast:** delegate to coder subagents, ONE per module (they don't
  overlap), each given this exact pattern + "update the client callers, keep outer
  try/catch, typecheck". Then `tsc` both apps.
- **Verify:** trigger one known validation error per app (e.g. 4th active challenge,
  double check-in) and confirm the real message toasts.
- **Trap:** never wrap an action that calls `redirect()`/`notFound()` without letting
  those through — `runAction` already rethrows `NEXT_*` digests, so it's safe, but
  don't hand-roll a different wrapper.

### 2. H4 — stop matches wedging on partial submit  ·  ~15 min  ·  LOW risk  ·  HIGH value
`submitMatchResult` (`lib/actions/matches.ts:66-143`) inserts match → participants →
games as 3 independent writes. A failure after the match insert leaves an orphan
`pending_confirmation` match with a UNIQUE `challenge_id`: can't resubmit, can't
confirm ("No decisive games"). Permanent wedge.

- **Fix (compensating delete — not a full RPC):** after the `match` insert, if the
  `match_participants` OR `match_games` insert returns an error, `await
  adminClient/​supabase.from('matches').delete().eq('id', match.id)` before throwing.
  Use the service-role client for the delete (matches RLS). This unblocks resubmit.
- **Verify:** hard to force a mid-failure; instead code-review that both error paths
  delete the match, and `tsc`.
- **Later (not now):** the clean version is a single `create_match_result` SECURITY
  DEFINER RPC doing all three inserts in one tx. Skip tonight — the pre-rating/points
  math (matches.ts:91-127) is non-trivial to port to plpgsql and is easy to get wrong.

### 3. M6 — block force-confirming someone else's match  ·  ~20 min  ·  LOW-MED risk  ·  security
`apply_match_result` has no in-function participant check, so any authed user can
`rpc('apply_match_result', {p_match_id:<any pending>, p_confirmed_by:<anyone>})` and
force-apply Elo / forge `confirmed_by`.

- **Key fact that makes this safe:** `SECURITY DEFINER` switches the *privilege* role
  but NOT the JWT — `auth.uid()` inside the function is still the caller's. So a guard
  keyed on `auth.uid()` correctly lets legit confirms through and blocks non-participants.
- **Migration 00019 — CREATE OR REPLACE `apply_match_result`** with this guard inserted
  right after the two existing status checks (near line 322):
  ```sql
  IF auth.uid() IS NOT NULL
     AND NOT is_admin(auth.uid())
     AND get_player_id(auth.uid()) NOT IN (
       SELECT player_id FROM match_participants WHERE match_id = p_match_id)
  THEN RAISE EXCEPTION 'Only a participant can confirm this match'; END IF;
  ```
  Service-role (auth.uid() NULL → dispute/admin paths) and admins bypass; participants
  pass; everyone else is rejected.
- **Trap:** you must copy the WHOLE current function body verbatim from
  `00003_functions.sql:290-475` into the CREATE OR REPLACE and only insert the guard —
  a transcription slip corrupts Elo. Dry-run, then **immediately test a real
  player confirm** end-to-end after applying.

---

## STRETCH (only if time AND you'll test it) — do NOT rush these before sleep

### 4. H2 — participant can't bypass Elo via direct matches UPDATE  ·  ~45 min  ·  MED risk
`matches_update` RLS lets a participant `update matches set result_status='confirmed'`
directly, skipping `apply_match_result` (no Elo) while firing the stats trigger.

- **Correct approach (Option A):** the only legit participant write to `matches` is the
  dispute setting `result_status='disputed'`. Move that into a SECURITY DEFINER
  `dispute_match_result(p_match_id, p_category, p_description)` RPC (participant check +
  set disputed + insert dispute row), switch `disputeMatchResult` to call it, then
  **restrict `matches_update` RLS to admin/service only** (drop the participant clause).
  `apply_match_result` runs as owner → bypasses RLS, so confirmation still works.
- **Trap / ordering:** the RLS restriction breaks the CURRENT app's dispute path, so the
  app change (RPC call) must be LIVE before you apply the migration. Since app deploys
  via CI and migrations by hand, apply the migration only after the new image is up.
- **Do NOT** use a BEFORE UPDATE trigger keyed on `auth.uid()` — `apply_match_result`'s
  own UPDATE runs with the player's `auth.uid()`, so the trigger would block legit
  confirms. This is the trap I flagged.

### 5. M5 — tournament registration cap race  ·  ~20 min  ·  MED risk
`registerForEvent` count-then-insert lets two concurrent registrations exceed
`max_participants`. Fix with a BEFORE INSERT trigger on `tournament_participants` that
`SELECT … FOR UPDATE`s the event row and rejects when full (atomic). Verify a normal
registration still works.

### 6. M4 — doubles accept race  ·  ~25 min  ·  MED risk
`acceptChallenge` recomputes status from a stale snapshot. Fix with a SECURITY DEFINER
`respond_to_challenge(p_challenge_id, p_accept)` RPC that updates the participant and
recomputes aggregate status under `SELECT … FOR UPDATE` on the challenge. Replaces the
service-role dance in `challenges.ts:149-167`.

### 7. M9 — schema refinements  ·  ~15 min  ·  LOW risk
`packages/shared/src/validators/schemas.ts`: add `superRefine` to
`adminMatchCreateSchema` (no player on both sides / type↔side-size / format↔games) and
`challengeCreateSchema` (partners required iff doubles). Pure validation, safe.

---

## Defer past tonight (documented in bug-audit.md)
M8 (admin non-atomic — compensating deletes, admin-only so low blast radius),
L2 (session-reminder UTC — edge fn), L3 (push rethrow), L4 (dispute status guard),
L5–L8, L10–L12. All low severity.

---

## Suggested 3-hour cut
Do **1 (H3) → 2 (H4) → 3 (M6)**, commit + push after each, apply the 00019 migration,
and **test one match confirm + one check-in** live. That clears the highest
user-facing pain (error messages), the worst data-integrity trap (wedged matches),
and one real security gap — all low-risk — and leaves you time to actually sleep.
Leave H2/M4/M5 for a rested, tested session.
