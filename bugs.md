# Beta Test — Bug Log

> ## Observability added (flame graphs)
> Full-stack Sentry tracing so slow portions are visible:
> - **Supabase DB spans** — `@supabase/sentry-js-integration` wired into all 6 Sentry configs (player+admin × client/server/edge). Every query/RPC is a named span in the trace waterfall.
> - **Node CPU profiling** — `@sentry/profiling-node` in both server configs (`profileLifecycle: 'trace'`), loaded defensively so a missing ARM binary never breaks init.
> - View: Sentry → Performance → transaction → span/flame view; Insights → Queries. Needs a CI rebuild to reach prod; works now in local dev.
>
> ## Session status (updated)
> - **Flame-graph instrumentation** — ✅ done, typechecks, smoke-tested (edge+server+DB pages 200, no init errors).
> - **#4 error messages** — ✅ done. `ActionResult` return-value contract (`runAction` in `_shared.ts`) on all 8 challenge/match actions + both client callers; typechecks + smoke-tested. Real messages now reach the client instead of the redacted digest.
> - **Dead-code audit** — ✅ done → see `dead-code.md` (tiered: safe / review / do-not-touch).
> - **#6 feed labels** — cannot repro from current data (3 players, all active, joins resolve); needs a screenshot/route.
> - **#8 provisionals** — same root cause as #2; fixed by `00017`.
> - **#1 challenge create RLS** — ✅ fixed in working tree (service-role participant insert), uncommitted.
> - **#2 confirm/dispute (audit_logs RLS)** — migration `00017` written + **dry-run passed on prod**; **awaiting manual apply** (prod write blocked for the agent). Fix = `apply_match_result`/`reverse_match_result` → `SECURITY DEFINER`.
> - **#3 pfp bucket** — same migration `00017` (creates `avatars` bucket + policies); awaiting apply.
> - **#5 eb17fca0** — **NOT an orphan** (status `accepted`, 2 participants). Its 500 was a POST server-action throw (submit/confirm result) = #2 surfacing as 500 + redacted message (#4). BUT 3 real orphans exist → `scripts/cleanup-orphan-challenges.sql`.
> - **#8 provisionals didn't update** — same root cause as #2 (whole `apply_match_result` tx rolled back). Fixed by `00017`.
> - **#7 hide check-in when unavailable** — ✅ done. **#9 remove Quick Actions from feed** — ✅ done.
> - **#4 error messages / #6 feed labels** — still open.
>
> **To apply DB fixes on the Pi:**
> ```
> ssh pi "docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1" < supabase/migrations/00017_selfhost_rls_storage_fixes.sql
> ssh pi "docker exec -i supabase-db psql -U postgres -d postgres -v ON_ERROR_STOP=1" < scripts/cleanup-orphan-challenges.sql
> ```
> Prod DB container = `supabase-db`. No migration runner exists; apply manually.

---


Found during live beta testing on `badminton.polardev.org` (self-hosted). Ordered
by severity. Evidence pulled from `docker logs goproxy-badminton-player-2` on the Pi
and from source inspection.

> **Deploy note:** code fixes ship via the normal push → CI build → Pi image
> auto-update path. The **DB fixes below (#2, #3, and the create_challenge RPC /
> orphan cleanup in #5) require SQL applied to the live self-hosted Postgres** — no
> migration runner was found in the repo (only `scripts/prod-to-dev-snapshot.sh`).
> **Open question: confirm how migrations reach prod before shipping DB changes.**

---

## 1. Sending a challenge fails — RLS on `challenge_participants` 🔴 CONFIRMED

- **Symptom:** "Send Challenge" errors for a new/non-admin account (and, per the
  user, on an admin account too).
- **Evidence (logs):** `Error: new row violates row-level security policy for table "challenge_participants"` (digest `2975411646`, seen repeatedly).
- **Root cause:** `createChallenge` inserts the whole participant set (self +
  opponent + partners) in one batch using the **user's** Supabase client. Policy
  `cp_insert` (`00005_rls.sql:147`) only permits rows where
  `player_id = get_player_id(auth.uid()) OR is_admin(auth.uid())`. Postgres checks
  `WITH CHECK` per row, so the **opponent's row** (different `player_id`) fails and
  the whole statement is rejected. A player-app session is not `is_admin()`, so this
  hits **everyone** — that's why it fails "even on admin".
- **Location:** `apps/player/src/lib/actions/challenges.ts:76`
- **Fix (APPLIED in working tree, uncommitted):** route the participant insert
  through `createServiceRoleClient()`. Data is server-constructed and already gated
  by `validate_challenge_creation`, so bypassing RLS there is safe.
- **Better long-term fix:** a `SECURITY DEFINER create_challenge` RPC that inserts
  the challenge + participants in **one transaction** — fixes RLS *and* the
  non-atomic orphan problem in #5. See #5.

---

## 2. Cannot confirm / dispute match results as a normal user — RLS on `audit_logs` 🔴 CONFIRMED

- **Symptom:** normal user cannot confirm or dispute a match result.
- **Evidence (logs):** `Error: new row violates row-level security policy for table "audit_logs"`.
- **Root cause:** `confirmMatchResult` (`apps/player/src/lib/actions/matches.ts:190`)
  calls `supabase.rpc('apply_match_result', …)` with the **user client**. But
  `apply_match_result` (`00003_functions.sql:290`) is **NOT `SECURITY DEFINER`**
  (ends `$$ LANGUAGE plpgsql;`). Its final statement inserts into `audit_logs`
  (`:472`), and `audit_insert` RLS (`00005_rls.sql:297`) requires
  `is_admin(auth.uid())`. So a normal player's confirmation reaches the audit
  insert, fails RLS, and the **entire transaction rolls back** (Elo never applies).
- **Fix:** add `SECURITY DEFINER SET search_path = public, pg_temp` to
  `apply_match_result`. Apply the same to `reverse_match_result`
  (`00003_functions.sql:~730`, also inserts `audit_logs`, also non-definer).
- **Also verify (dispute path):** `disputeMatchResult`
  (`matches.ts:221`) does user-client writes to `matches` + `disputes`. Confirm the
  `disputes` INSERT RLS allows a participant, or the "cannot dispute" is the same
  rollback vs. a separate policy. **Needs check.**
- **Requires a new migration to prod DB.**

---

## 3. Profile picture upload — "Bucket not found" 🔴 CONFIRMED

- **Symptom:** uploading a pfp errors with "Bucket not found".
- **Root cause:** the `avatars` storage bucket does **not exist** on the self-hosted
  Supabase — no migration or setup script creates it. `AvatarUpload` uploads to
  bucket `avatars`.
- **Location:** `apps/player/src/components/AvatarUpload.tsx:43`
- **Fix:** create the `avatars` bucket (public read) + storage RLS policies
  (authenticated users can upload/overwrite their own object) via SQL/migration on
  the live DB.
- **Minor:** the upload path is `avatars/${playerId}.${ext}` *inside* the `avatars`
  bucket → a redundant `avatars/` folder. Cosmetic; can drop the prefix
  (`${playerId}.${ext}`) when fixing.
- **Requires DB/storage setup on prod.**

---

## 4. Errors show a generic "server render error", not the real message 🟠 CONFIRMED

- **Symptom:** user-facing errors are generic ("server render error or whatever")
  instead of the actual reason.
- **Root cause:** all player server actions `throw new Error(...)` (~65 sites).
  **Next.js redacts thrown Server Action error messages in production**, replacing
  them with a generic string + a `digest`. The client `toast(err.message)` therefore
  shows the redacted text, not the real cause.
- **Evidence:** server logs hold the real messages behind those digests —
  `Maximum 3 active challenges reached`, `winner_side does not match game scores`,
  `description: Description must be at least 10 characters`, plus the RLS messages
  above. All were invisible to the user.
- **Fix:** have actions **return** errors as values (e.g.
  `{ ok: false, error: string }`) instead of throwing, and toast `result.error`.
  Blast radius is the **client call sites** (handlers already `try/catch/toast`),
  not all 65 throws — a shared helper keeps it uniform. Start with the
  challenge/match flows; **decide with user** whether to sweep the whole app now or
  as follow-up.
- **Locations:** `apps/player/src/app/challenges/new/page.tsx:114`,
  `apps/player/src/app/challenges/[id]/actions.tsx` (handlers), action bodies in
  `apps/player/src/lib/actions/*.ts`.

---

## 5. `/challenges/[id]` returns 500 + likely orphaned challenges 🟠 PARTIAL

- **Symptom:** navigating to `/challenges/eb17fca0-3788-451c-9d12-c29743cd3a24`
  returns HTTP 500 (screenshot); service worker then logs a FetchEvent network error.
- **Analysis:** the detail page GET (`challenges/[id]/page.tsx`) can't 500 by
  inspection — empty participants render "No players yet"; `status`/`created_at` are
  always present. So the 500 is most likely **(a)** a POST server action
  (accept/reject/cancel/submit) throwing, surfaced in devtools as a 500 on that URL,
  and/or **(b)** an **orphaned challenge**: pre-fix, the challenge row committed
  (`:39`) but the participant insert failed on RLS (#1), leaving a zero-participant
  challenge. The create is **non-atomic** (challenge via user client, participants
  via service role), so partial failure can still orphan.
- **Fix:** a `SECURITY DEFINER create_challenge` RPC (challenge + participants in one
  transaction) fixes RLS **and** atomicity and matches existing definer RPCs. Then
  **clean up existing orphan challenges** (zero participants).
- **TODO:** reproduce `eb17fca0` (check its DB row: does it exist? how many
  participants?) to confirm which branch it is before building the fix.

---

## 6. Feed match card shows generic labels ("me vs Opponents") 🟡 NEEDS REPRO

- **Symptom:** feed showed generic "me vs Opponents" instead of real player names.
- **Analysis:** in `apps/player/src/app/feed/page.tsx:274-360` the viewer's side is
  hardcoded to **"You"** (`:325`) and the other side falls back to **"Opponent"**
  (`:353`) whenever `opponent.player` (the joined player row) is null. Generic labels
  therefore appear when the `match_participants → players` join returns null (missing
  player, or a match the viewer isn't actually part of). No literal "Opponents"
  string exists in the code — the user is paraphrasing the fallback labels.
- **TODO:** inspect a real recent match's `match_participants` to see why the player
  join is empty; likely related to the same match-flow breakage (#2) producing
  incomplete match data, or an orphan.

---

## Lower priority / infra (from console screenshot)

- **Realtime WebSocket failures:** repeated `WebSocket connection to
  'wss://badminton.polardev.org/supabase/realtime/v1/websocket…' failed`. Separate
  infra/proxy issue — realtime endpoint not reachable through the reverse proxy.
  Investigate proxy routing for `/supabase/realtime`.
- **Deprecated meta tag (cosmetic):** `<meta name="apple-mobile-web-app-capable">`
  is deprecated; add `<meta name="mobile-web-app-capable" content="yes">` alongside
  it. Player app `layout.tsx` / head.

---

## Suggested fix order

1. **#2** (`apply_match_result` / `reverse_match_result` → `SECURITY DEFINER`) —
   unblocks match confirm/dispute. DB migration.
2. **#1** (challenge participant insert) — already fixed in working tree; consider
   folding into the `create_challenge` RPC from #5 instead.
3. **#3** (create `avatars` bucket + policies) — DB/storage setup.
4. **#5** (`create_challenge` RPC + orphan cleanup) — after repro of `eb17fca0`.
5. **#4** (return-value error contract) — quality; scope with user.
6. **#6** (feed labels) — after repro.
7. Infra: realtime WS, meta tag.
