-- ============================================================
-- 00132 — a members row exists from first sign-in, and a claim
--         stops taking privileges away in silence
-- ============================================================
-- TWO CHANGES, ONE FILE, because they are the same event. The `players` row is
-- written at the END of onboarding today, by completeOnboarding, and that same
-- function is where an unclaimed roster row gets CLAIMED. Move the row earlier
-- and the claim has to move with it, or first sign-in would insert a second row
-- for somebody an exec had already pre-added. So both live here.
--
-- ------------------------------------------------------------
-- PART ONE — WHY THE ROW MOVES
-- ------------------------------------------------------------
-- `auth.users` has ZERO triggers on production (verified 2026-08-16), and
-- nothing creates a `players` row until completeOnboarding runs. Between
-- pressing "sign up" and finishing setup a person therefore exists in auth and
-- not in the app: invisible to the roster, to Needs Attention, to the merge
-- picker, to every chart — because all of those read `players`.
--
-- Production carries 17 such accounts. Sixteen are the owner's own test debris.
-- One is real: aniyit_saran@sfu.ca signed up 2026-08-12, confirmed, signed in
-- four minutes later and never came back. Nobody can see them, chase them, or
-- clean them up. Once the semester starts and people sign up on a phone at a
-- club night, a steady fraction will land in exactly that state.
--
-- The owner's instruction was "create player row on first signin".
--
-- WHY AN RPC AND NOT A TRIGGER ON auth.users. A trigger is airtight — it cannot
-- be skipped — but it runs inside GoTrue's own transaction, where a failure
-- breaks SIGNUP ITSELF, and it has no access to the claim logic that has to run
-- at the same moment. auth.users has never had a trigger on this deployment, so
-- the first one is a step change in blast radius on the one path nobody can
-- afford to break. This function is called by the app instead, from the three
-- places a first sign-in can land (see apps/player/src/lib/first-signin.ts),
-- with the service-role key. It is idempotent, so calling it from three places
-- is the safety, not a cost.
--
-- WHY THE DECISION IS IN SQL RATHER THAN TypeScript. The claim-or-create choice
-- must be race-safe: two requests for the same person arriving together must
-- produce ONE row, and two people must never claim the same roster row. That is
-- the rule profile.ts:178 already states for handles — "never a read followed by
-- a write". Here it means a single UPDATE whose WHERE clause is the lock, and a
-- single INSERT ... ON CONFLICT DO NOTHING. Both are statements, not sequences,
-- and only the database can offer them.
--
-- ------------------------------------------------------------
-- PART TWO — WHY THE CLAIM CHANGES
-- ------------------------------------------------------------
-- roster-claim.ts strips role, is_exec and is_trainer from EVERY claim, on the
-- rule "a claim links an identity, it never confers privilege". The escalation
-- it guards against is real: a roster row carrying role='admin' would hand admin
-- to whoever can receive mail at that address.
--
-- But the file names its example — lsa139@sfu.ca — as the trap. That address is
-- Steven Sun, and Steven Sun is this club's admin. On 2026-08-15 he signed in,
-- the claim fired, and it took role='admin' and is_exec away from him. The one
-- production instance of the guard firing was a false positive against the
-- person it was protecting.
--
--   badminton=# select actor_id, target_id, old_value from audit_logs
--                where action_type = 'roster_row_claimed_privileges_stripped';
--    f4d388d5-…  | f4d388d5-…  | {"role": "admin", "is_exec": true}
--
-- The row IS written, so "nothing recorded it" is not literally true — but it
-- may as well be. `roster_row_claimed_privileges_stripped` is not in
-- ACCESS_CHANGE_ACTION_TYPES, so /accounts' "last access change" card filters it
-- out before it is even examined; the dashboard band does not know about it; no
-- /players tab shows it, because a claim never touches `status` and Needs
-- Attention is `status = 'pending_approval'` alone. It lands in /audit's OTHER
-- tab, in a neutral badge, attributed to the member themselves — because
-- actor_id is set to the claimed row. The only way to find out was to notice
-- admin had gone.
--
-- The owner asked for a combination: keep the strip but make it loud, keep the
-- privileges when the claim is trustworthy, and hold the rest for approval.
--
-- WHAT MAKES A CLAIM TRUSTWORTHY, AND THE EVIDENCE FOR IT. A `players` row
-- carries NO provenance. There is no added_by, created_by, invited_by or source
-- column and there never has been; `banned_by` is the only who-column on the
-- table. So the row itself cannot say who put it there.
--
-- The audit log can. createPlayer (apps/admin/src/lib/actions/players.ts:163)
-- writes a `player_created` entry whose actor_id is the officer who clicked and
-- whose new_value carries `is_exec` and `is_trainer` verbatim; updatePlayer and
-- setConsoleAccess write `player_updated` with the changed columns; the roster
-- dialog's is_exec toggle writes `player_flags_updated`. A privilege that an
-- exec deliberately conferred through the console therefore has an attributable
-- record, and one that appeared any other way — a seed, a hand-written UPDATE,
-- a restore from backup — does not.
--
--   ATTRIBUTABLE = the most recent audit entry that mentions this privilege was
--                  written by SOMEBODY ELSE and agrees with what the row now
--                  carries.
--
-- "Most recent that mentions it", not "any": otherwise a privilege granted in
-- the console, revoked, and then re-added by hand in SQL would inherit the old
-- entry's blessing. "Somebody else" because actor_id = target_id is what the
-- self-service paths write, and a row cannot vouch for itself.
--
-- HOW MUCH THIS KEEPS, HONESTLY. Production today has ZERO unclaimed rows
-- carrying any privilege:
--
--   badminton=# select count(*) from players
--                where user_id is null and (role <> 'player' or is_exec or is_trainer);
--    0
--
-- So this branch keeps nothing at all right now. It is entirely forward-looking:
-- it is what happens the next time an exec pre-adds an incoming officer before
-- they sign up, which is the case the owner says is the usual one for this club.
-- The strip-and-hold branch is what carries the feature until then, and the
-- backfill in section 6 is what recovers the one case that already happened.
--
-- THE lsa139 SHAPE IS NOT WEAKENED. An unclaimed privileged row that nobody can
-- be shown to have created deliberately still confers nothing. It is now HELD
-- rather than silently discarded — the member gets in as an ordinary member, the
-- privilege waits on the row where an admin can see it and restore it in one
-- action — but it is not granted unasked, which is the whole point of the guard.
--
-- ------------------------------------------------------------
-- HOW TO APPLY IT (NOT RUN BY THIS BRANCH — hand it to whoever owns the DB)
-- ------------------------------------------------------------
--   cat supabase/migrations/00132_player_row_at_first_signin.sql \
--     | ssh <pi-host> "docker exec -i supabase-db psql -U postgres -d postgres \
--                        -v ON_ERROR_STOP=1 --single-transaction"
--
-- IDEMPOTENT end to end: ADD COLUMN IF NOT EXISTS, CREATE OR REPLACE for every
-- function, and a backfill whose WHERE clause excludes every row it has already
-- written.
--
-- ORDER AGAINST THE APP DEPLOY: THIS FILE FIRST. The deploy calls
-- ensure_player_for_user() on every sign-in and reads privilege_claim_review on
-- /players. Ship the app against a database without this and the first sign-in
-- of the day gets `function public.ensure_player_for_user(uuid) does not exist`
-- — which is swallowed to Sentry rather than shown (see first-signin.ts), so
-- signup would quietly go back to today's behaviour rather than break — while
-- /players would fail its WHOLE PostgREST select on the missing column and
-- render an EMPTY ROSTER. That second one is the reason for the ordering.
-- Applying this early costs nothing: until the deploy, the function has no
-- caller and the column no reader.
-- ============================================================


-- ---- 1. the durable mark a claim leaves ---------------------
-- An audit row is where you look once you already suspect something. This is
-- the thing that is still there next week when somebody asks why Steven cannot
-- get into the console — the owner's words were "ensure that there is a
-- permission flag there".
--
-- ONE JSONB COLUMN RATHER THAN FOUR SCALARS. What has to be answerable from the
-- row alone is: were privileges withheld or kept by a claim (as opposed to never
-- having existed), WHICH ones so that restoring is one action and not
-- archaeology, and is it still unresolved. That is a small record, it is written
-- once and read by one screen, and splitting it across columns would mean four
-- ALTERs the next time the shape moves. NULL means there is nothing to review —
-- which is every row today and every row that never claimed anything — so the
-- flag is filterable with a plain IS NOT NULL and costs nothing to skip.
--
-- SHAPE (see packages/shared/src/utils/privilege-claim.ts, which parses it):
--   {
--     "state":      "held" | "kept" | "mixed",
--     "at":         "2026-08-16T…Z",
--     "withheld":   { "role": "admin", "is_exec": true },   -- may be absent
--     "kept":       { "is_trainer": true },                 -- may be absent
--     "player_id":  "…"                                     -- the claimed row
--   }
--
-- state is derived, not independent: "held" = something was withheld and
-- nothing kept, "kept" = the reverse, "mixed" = both. It is stored rather than
-- recomputed so the console can sort and label without unpacking the objects.
ALTER TABLE players ADD COLUMN IF NOT EXISTS privilege_claim_review jsonb;

COMMENT ON COLUMN players.privilege_claim_review IS
  'Set when a roster claim withheld or kept console privileges, and cleared '
  'when an admin resolves it. NULL means there is nothing to review. Carries '
  'the privileges themselves so a restore is one action — see 00132 section 1 '
  'for the shape. Read by the console through the service role; deliberately '
  'NOT granted to `authenticated` (00132 section 7).';

-- Filterable without scanning the roster. Partial, because the interesting set
-- is tiny and permanent-zero most of the time.
CREATE INDEX IF NOT EXISTS players_privilege_claim_review_idx
  ON public.players (id)
  WHERE privilege_claim_review IS NOT NULL;


-- ---- 2. is this privilege attributable to an exec? ----------
-- Returns the subset of role / is_exec / is_trainer that the row CURRENTLY
-- carries and that some other member can be shown to have conferred through the
-- console, as {"is_exec": true, "role": "admin"}. Absent key = not attributable
-- (either the row does not carry it, or nothing in the audit log accounts for
-- it).
--
-- THE ACTION TYPES ARE THE FOUR CONSOLE WRITE PATHS, and all four are needed:
--   player_created            createPlayer — new_value carries is_exec/is_trainer
--   player_updated            updatePlayer and setConsoleAccess
--   player_flags_updated      the roster dialog's is_exec toggle (fees.ts:43)
--   player_permissions_changed the /permissions editor
-- Missing one would make a genuinely deliberate grant look unattributable, and
-- the failure mode of that is a false hold — annoying, and it argues for
-- listing all four rather than the obvious two.
--
-- actor_id <> p_player_id is doing real work. The self-service paths write
-- actor_id = the member themselves (reactivate.ts, and the strip entry this
-- migration exists because of), and a row must not be able to vouch for its own
-- privileges. actor_id IS NOT NULL for the same reason: audit_logs.actor_id is
-- ON DELETE SET NULL, and a NULL actor renders as "System" — a deleted officer's
-- grant is no longer attributable to anybody, so it is not honoured.
CREATE OR REPLACE FUNCTION public.claim_privilege_attribution(p_player_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_row     players%ROWTYPE;
  v_out     jsonb := '{}'::jsonb;
  v_key     text;
  v_current jsonb;
  v_logged  jsonb;
BEGIN
  SELECT * INTO v_row FROM players WHERE id = p_player_id;
  IF NOT FOUND THEN
    RETURN v_out;
  END IF;

  FOREACH v_key IN ARRAY ARRAY['role', 'is_exec', 'is_trainer'] LOOP
    v_current := CASE v_key
                   WHEN 'role'       THEN to_jsonb(v_row.role::text)
                   WHEN 'is_exec'    THEN to_jsonb(COALESCE(v_row.is_exec, FALSE))
                   WHEN 'is_trainer' THEN to_jsonb(COALESCE(v_row.is_trainer, FALSE))
                 END;

    -- Nothing to attribute: an ordinary member carries no privilege here.
    CONTINUE WHEN v_current IS NULL
                  OR v_current = to_jsonb(FALSE)
                  OR v_current = to_jsonb('player'::text);

    -- The MOST RECENT entry that mentions this column, not any entry. A
    -- privilege granted in the console, revoked, then re-added by hand in SQL
    -- would otherwise inherit the blessing of the first grant.
    SELECT a.new_value -> v_key
      INTO v_logged
      FROM audit_logs a
     WHERE a.target_type = 'player'
       AND a.target_id = p_player_id
       AND a.action_type IN (
             'player_created', 'player_updated',
             'player_flags_updated', 'player_permissions_changed')
       AND a.actor_id IS NOT NULL
       AND a.actor_id <> p_player_id
       AND a.new_value ? v_key
     ORDER BY a.created_at DESC
     LIMIT 1;

    IF v_logged IS NOT NULL AND v_logged = v_current THEN
      v_out := v_out || jsonb_build_object(v_key, v_current);
    END IF;
  END LOOP;

  RETURN v_out;
END;
$$;

COMMENT ON FUNCTION public.claim_privilege_attribution(uuid) IS
  'The subset of role/is_exec/is_trainer a player row carries that some other '
  'member can be shown, from audit_logs, to have conferred through the console. '
  'The trust test a roster claim applies — see 00132 section 2.';


-- ---- 3. the row itself --------------------------------------
-- ensure_player_for_user(p_user_id) — idempotent, returns the players.id, or
-- NULL when it deliberately declined to act.
--
-- IT TAKES NO EMAIL, ON PURPOSE. An earlier draft took the address from the
-- caller, which would have let a bug (or a compromised service key) claim any
-- roster row by naming its address. The address is read from auth.users here,
-- which is the same place GoTrue proved it, and there is nothing for the caller
-- to get wrong. NULL email — a phone-only account, which this deployment does
-- not issue — declines rather than inventing one, because players.email is NOT
-- NULL and unique.
--
-- THE THREE OUTCOMES:
--   already linked  → return the existing id, touch nothing. This is the common
--                     case: it runs on every sign-in, not only the first.
--   roster row      → CLAIM it (section 4)
--   nothing         → CREATE a stub (section 5)
--
-- AMBIGUITY DECLINES RATHER THAN GUESSES. Two unclaimed rows for one address
-- cannot both be right, and picking one would attach a member to an arbitrary
-- history. It returns NULL and creates nothing, which leaves the member exactly
-- where they were: the middleware sends them to /onboarding, completeOnboarding
-- finds no row, and throws the sentence it already has ("There is more than one
-- club record for your email address…"). That message needs a screen to land on
-- and sign-in has none, which is the whole reason this refuses quietly instead
-- of raising.
--
-- players_email_lower_key (00066) makes two such rows impossible going forward,
-- so this is the same defensive branch profile.ts:437 already carries, for the
-- same reason: this function deploys independently of that index.
CREATE OR REPLACE FUNCTION public.ensure_player_for_user(p_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_email     text;
  v_confirmed boolean;
  v_id        uuid;
  v_role      text;
  v_exec      boolean;
  v_trainer   boolean;
  v_attr      jsonb;
  v_withheld  jsonb := '{}'::jsonb;
  v_kept      jsonb := '{}'::jsonb;
  v_state     text;
  v_update    jsonb;
  v_ambiguous integer;
BEGIN
  IF p_user_id IS NULL THEN
    RETURN NULL;
  END IF;

  -- Already linked. Cheapest path and by far the most travelled — this runs on
  -- every sign-in, and after the first one it is a single indexed lookup
  -- (idx_players_user_id) and a return.
  SELECT id INTO v_id FROM players WHERE user_id = p_user_id;
  IF FOUND THEN
    RETURN v_id;
  END IF;

  SELECT lower(btrim(u.email)), (u.email_confirmed_at IS NOT NULL)
    INTO v_email, v_confirmed
    FROM auth.users u
   WHERE u.id = p_user_id;

  IF v_email IS NULL OR v_email = '' THEN
    RETURN NULL;
  END IF;

  SELECT count(*) INTO v_ambiguous
    FROM players
   WHERE user_id IS NULL
     AND lower(email) = v_email;

  IF v_ambiguous > 1 THEN
    RETURN NULL;
  END IF;

  -- ---- 4. claim ------------------------------------------------
  -- THE RACE IS HANDLED BY THIS ONE STATEMENT AND NOTHING ELSE. Two sign-ins
  -- arriving together both aim at the same roster row; the second blocks on the
  -- row lock the first takes, and when it is released re-evaluates
  -- `user_id IS NULL` against the committed row — which is now false — so it
  -- matches nothing and falls through to the insert below, where the unique
  -- index catches it. That is the READ COMMITTED guarantee, and it is the exact
  -- reason this is an UPDATE ... WHERE rather than a SELECT followed by an
  -- UPDATE.
  --
  -- RETURNING gives the NEW row, but the only column being written is user_id,
  -- so role/is_exec/is_trainer come back as they were. That is what the
  -- privilege decision below is made against, and reading them in the same
  -- statement is what stops anything changing between the read and the decision.
  --
  -- onboarding_completed is NOT touched. The claim now happens at SIGN-IN, and
  -- this person has given no name and signed no waiver — buildRosterClaim used
  -- to set it TRUE because it ran at the END of onboarding, when it was true.
  -- Setting it here would walk the member straight past the gate.
  UPDATE players
     SET user_id    = p_user_id,
         updated_at = NOW()
   WHERE user_id IS NULL
     AND lower(email) = v_email
   RETURNING id, role::text, COALESCE(is_exec, FALSE), COALESCE(is_trainer, FALSE)
        INTO v_id, v_role, v_exec, v_trainer;

  IF FOUND THEN
    IF v_role = 'player' AND NOT v_exec AND NOT v_trainer THEN
      -- Nothing privileged on the row. The overwhelming majority of pre-adds,
      -- and there is nothing to decide, record or surface.
      RETURN v_id;
    END IF;

    -- v_confirmed is an ASSERTION, not a filter. Every account that can reach a
    -- first sign-in has email_confirmed_at set — on production all 9 signed-in
    -- users do and only the 15 who never signed in do not — so this rejects
    -- nothing in practice. It is here so that if that ever stops being true,
    -- privileges stop being inherited rather than quietly continuing to be.
    v_attr := CASE WHEN v_confirmed
                   THEN claim_privilege_attribution(v_id)
                   ELSE '{}'::jsonb END;

    -- Split what the row carries into kept and withheld. Written per column
    -- rather than "leave it alone if trusted": the bug this whole file exists
    -- because of was inheritance by omission, and every claim must state the
    -- value it lands on.
    v_update := '{}'::jsonb;
    IF v_role <> 'player' THEN
      IF v_attr ? 'role' THEN v_kept := v_kept || jsonb_build_object('role', v_role);
      ELSE
        v_withheld := v_withheld || jsonb_build_object('role', v_role);
        v_update := v_update || jsonb_build_object('role', 'player');
      END IF;
    END IF;
    IF v_exec THEN
      IF v_attr ? 'is_exec' THEN v_kept := v_kept || jsonb_build_object('is_exec', TRUE);
      ELSE
        v_withheld := v_withheld || jsonb_build_object('is_exec', TRUE);
        v_update := v_update || jsonb_build_object('is_exec', FALSE);
      END IF;
    END IF;
    IF v_trainer THEN
      IF v_attr ? 'is_trainer' THEN v_kept := v_kept || jsonb_build_object('is_trainer', TRUE);
      ELSE
        v_withheld := v_withheld || jsonb_build_object('is_trainer', TRUE);
        v_update := v_update || jsonb_build_object('is_trainer', FALSE);
      END IF;
    END IF;

    v_state := CASE
                 WHEN v_withheld <> '{}'::jsonb AND v_kept <> '{}'::jsonb THEN 'mixed'
                 WHEN v_withheld <> '{}'::jsonb THEN 'held'
                 ELSE 'kept'
               END;

    UPDATE players
       SET role       = COALESCE((v_update ->> 'role')::user_role, role),
           is_exec    = COALESCE((v_update ->> 'is_exec')::boolean, is_exec),
           is_trainer = COALESCE((v_update ->> 'is_trainer')::boolean, is_trainer),
           privilege_claim_review = jsonb_strip_nulls(jsonb_build_object(
             'state',     v_state,
             'at',        to_char(NOW() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
             'player_id', v_id,
             'withheld',  NULLIF(v_withheld, '{}'::jsonb),
             'kept',      NULLIF(v_kept, '{}'::jsonb)
           )),
           updated_at = NOW()
     WHERE id = v_id;

    -- BOTH DIRECTIONS ARE AUDITED, and under an action_type the console's
    -- access-change view actually matches (officer-access.ts). The old
    -- `roster_row_claimed_privileges_stripped` was filtered out of that view
    -- before it was examined, which is most of why the incident went unnoticed.
    -- actor_id is NULL — "the system did this" — rather than the member, which
    -- is what the old entry said and what made it read as somebody downgrading
    -- themselves.
    INSERT INTO audit_logs (actor_id, action_type, target_type, target_id,
                            old_value, new_value, reason)
    VALUES (
      NULL,
      'roster_claim_privileges_reviewed',
      'player',
      v_id,
      jsonb_build_object('role', v_role, 'is_exec', v_exec, 'is_trainer', v_trainer),
      jsonb_strip_nulls(jsonb_build_object(
        'state', v_state,
        'withheld', NULLIF(v_withheld, '{}'::jsonb),
        'kept', NULLIF(v_kept, '{}'::jsonb))),
      CASE v_state
        WHEN 'kept' THEN 'Roster row claimed at sign-in. The privileges on it were conferred deliberately through the console, so they were kept. Review and clear this from Players → Permission review.'
        ELSE 'Roster row claimed at sign-in. Privileges nobody can be shown to have granted deliberately are held, not conferred — the member is in as an ordinary member. Restore or dismiss from Players → Permission review.'
      END
    );

    RETURN v_id;
  END IF;

  -- ---- 5. create the stub --------------------------------------
  -- WHAT A STUB IS: a real person who has proved an address and given nothing
  -- else. No name, no waiver, no skill tier.
  --
  --   first_name = ''    first_name is NOT NULL (00023:37) and full_name is
  --                      GENERATED from it and NOT NULL too, so the row cannot
  --                      exist without one. An empty string is legal (verified:
  --                      full_name generates as '') and it is the honest value —
  --                      we do not know their name. The alternative considered
  --                      and rejected was the email's local part, which
  --                      manufactures something the roster and the merge picker
  --                      would then treat as a real name. The console renders
  --                      the blank deliberately (see the Incomplete tab) rather
  --                      than papering over it.
  --   status             LEFT AT THE DEFAULT, 'pending_approval', and this is
  --                      the single most load-bearing choice in the file. It is
  --                      what keeps a stub out of get_leaderboard (00092:751),
  --                      out of the ladder spread, out of the fee ledger, out of
  --                      every opponent and attendee picker that filters status,
  --                      and invisible to other members under players_select
  --                      (00005:51). requirePlayer() already refuses it
  --                      ("Account pending approval"), so a stub can take no
  --                      gameplay action, and admin_access_level already returns
  --                      NULL for it, so it can hold no console level. A new
  --                      enum value would have bought nothing and forced every
  --                      status switch in both apps to change.
  --   onboarding_completed  FALSE (the default). The middleware gate reads it
  --                      through players_self and still sends them to
  --                      /onboarding. This is why the stub does not let anybody
  --                      skip setup.
  --   active_flag        TRUE (the default). See the note in the report about
  --                      mark-inactive-players, which only sweeps
  --                      competitive/recreational and therefore never lapses a
  --                      stub.
  --
  -- ON CONFLICT DO NOTHING WITH NO INFERENCE TARGET, deliberately. There are two
  -- unique keys that can fire here — players_email_lower_key, which is an
  -- EXPRESSION index on lower(email) and which `ON CONFLICT (email)` would not
  -- match at all, and players_user_id_key. A bare DO NOTHING covers every unique
  -- constraint on the table, which is exactly what is wanted: whichever of the
  -- two a concurrent request trips, this one stands down and reads the winner's
  -- row below.
  INSERT INTO players (user_id, email, first_name, last_name, status, role, onboarding_completed)
  VALUES (p_user_id, v_email, '', NULL, 'pending_approval', 'player', FALSE)
  ON CONFLICT DO NOTHING
  RETURNING id INTO v_id;

  IF v_id IS NOT NULL THEN
    -- THE RATING IS SEEDED WITH THE SAME LITERALS create_player_with_rating USES
    -- (00023:84-89), not with the column defaults, and they must not drift
    -- apart. apply_skill_tier_seed (00127) only seeds a rating that is still
    -- untouched, and the way it tests "untouched" is singles_elo = default_elo
    -- AND doubles_elo = default_elo with no matches and no season snapshot. A
    -- stub whose rating differed from what the ordinary signup path produces
    -- would look to that guard like a rating an exec had set by hand, and the
    -- member's skill tier would silently fail to seed at the end of onboarding.
    INSERT INTO ratings (
      player_id, singles_elo, doubles_elo,
      singles_provisional, doubles_provisional,
      singles_k_factor, doubles_k_factor
    ) VALUES (v_id, 400, 400, TRUE, TRUE, 80, 64);

    RETURN v_id;
  END IF;

  -- The insert conflicted. Either a concurrent request for this same person got
  -- there first — in which case its row is committed by now and this finds it,
  -- which is the whole point of standing down above — or the address belongs to
  -- a row this call could not claim, and returning NULL hands the decision back
  -- to onboarding rather than inventing one.
  SELECT id INTO v_id FROM players WHERE user_id = p_user_id;
  RETURN v_id;
END;
$$;

COMMENT ON FUNCTION public.ensure_player_for_user(uuid) IS
  'Idempotently gives a signed-in auth user a players row: claims an unclaimed '
  'roster row matching their address if one exists, otherwise creates a stub '
  'with no name and onboarding_completed FALSE. Returns the players.id, or NULL '
  'when it declined (no address, or an ambiguous roster match). Called on every '
  'sign-in — see 00132.';


-- ---- 6. what happens to the claim that already fired --------
-- Steven's strip is on the record and recoverable, so recover it. Without this
-- the one incident that prompted the whole change is the one case the new flag
-- cannot explain, and somebody would have to reconstruct it from /audit's Other
-- tab by hand.
--
-- Read out of the old audit rows and written as if the new code had produced
-- them, with state 'held': at the time these were written nothing was kept.
--
-- ONLY WHERE THE PRIVILEGE IS STILL MISSING. Steven's admin has since been
-- re-granted by hand — he is role='admin', is_exec=true today — and flagging a
-- resolved case would open a review with nothing to do in it. The WHERE clause
-- asks whether the row still lacks what was taken, so this backfills a live
-- problem and stays silent about one somebody already fixed. It is also what
-- makes the section idempotent: run it twice and the second run matches the
-- same rows, writes the same value, and changes nothing.
UPDATE players p
   SET privilege_claim_review = jsonb_build_object(
         'state',     'held',
         'at',        to_char(a.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
         'player_id', p.id,
         'withheld',  a.old_value,
         'backfilled', TRUE
       )
  FROM (
    SELECT DISTINCT ON (target_id) target_id, old_value, created_at
      FROM audit_logs
     WHERE action_type = 'roster_row_claimed_privileges_stripped'
       AND target_type = 'player'
       AND old_value IS NOT NULL
       AND old_value <> '{}'::jsonb
     ORDER BY target_id, created_at DESC
  ) a
 WHERE p.id = a.target_id
   AND p.privilege_claim_review IS NULL
   -- Still missing at least one of the privileges that were taken.
   AND (
     (a.old_value ? 'role'       AND p.role::text <> (a.old_value ->> 'role'))
     OR (a.old_value ? 'is_exec'    AND COALESCE(p.is_exec, FALSE) IS DISTINCT FROM TRUE)
     OR (a.old_value ? 'is_trainer' AND COALESCE(p.is_trainer, FALSE) IS DISTINCT FROM TRUE)
   );


-- ---- 7. grants ----------------------------------------------
-- NO COLUMN GRANT ON privilege_claim_review, and this is not an oversight. The
-- lesson of 00092/00115, restated by 00121 and 00127: a column granted to
-- `authenticated` is granted on EVERY row, and a column NOT granted makes
-- PostgREST refuse the WHOLE request with a 403 that supabase-js resolves rather
-- than rejects — so the app renders it as empty data with no error anywhere.
-- Four screens have been lost here to exactly that. The only reader is the admin
-- console, and the console reads `players` through the service-role client
-- (apps/admin/src/lib/supabase-server.ts:52), which bypasses column grants
-- entirely. Nothing in the player app selects it. So the grant would buy nothing
-- and could only cost.
--
-- BOTH FUNCTIONS ARE SERVICE-ROLE ONLY, and PUBLIC MUST BE NAMED as well as the
-- roles — this is 00126's lesson and 00127 reproduced the trap the same day it
-- was written up. Supabase's ALTER DEFAULT PRIVILEGES grants EXECUTE to anon and
-- authenticated as EXPLICIT entries on every function created in this schema,
-- and REVOKE ... FROM PUBLIC does not touch an explicit grant. Left alone,
-- ensure_player_for_user — a SECURITY DEFINER function that takes an ARBITRARY
-- user id and can claim a roster row — would be callable by anyone holding the
-- anon key, which ships in the browser bundle.
--
-- There is no auth.uid() check inside either function because there is no path
-- by which a member reaches them: the grant IS the authorization. The callers
-- are first-signin.ts and completeOnboarding, both of which already hold a
-- service-role client for exactly this class of write.
REVOKE ALL ON FUNCTION public.ensure_player_for_user(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.claim_privilege_attribution(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.ensure_player_for_user(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.claim_privilege_attribution(uuid) TO service_role;


-- ---- 8. the console needs a finished account ----------------
-- A CONSEQUENCE OF MOVING THE CLAIM, and the one place where "keep the
-- privileges" and "the row exists earlier" genuinely conflict.
--
-- Today the claim runs at the END of onboarding, so a claimed exec's privileges
-- and their waiver arrive in the same breath. From now on the claim runs at
-- SIGN-IN, and a claim that KEEPS is_exec would otherwise hand somebody the
-- console before they have given a name or signed anything.
--
-- The standing gate already covers a stub — a stub is 'pending_approval', which
-- this function has excluded since 00057 — but NOT a claimed roster row, because
-- a claim deliberately leaves `status` alone (it is the admin's decision about
-- who this person is) and createPlayer defaults it to 'recreational'.
--
-- LOCKS NOBODY OUT. Every row on production that holds any console level has
-- onboarding_completed = true:
--
--   badminton=# select full_name, role, is_exec, onboarding_completed from players
--                where role <> 'player' or is_exec or is_trainer;
--    Gloria Gao    | player | t | t
--    Matthew Cheng | admin  | t | t
--    Steven Sun    | admin  | t | t
--    wui KI Cheng  | player | t | t
--    Wui ki Cheng  | player | t | t
--
-- and there is no row anywhere with onboarding_completed = false, because
-- nothing has ever created one. So this tightens a door that is currently
-- standing open on a room nobody is in.
--
-- Body is otherwise 00057_console_requires_good_standing.sql:26-58 verbatim.
CREATE OR REPLACE FUNCTION public.admin_access_level(p_user_id uuid)
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $$
DECLARE
  v_ok BOOLEAN;
BEGIN
  -- Standing gate, evaluated once. A row failing this holds no level at all,
  -- rather than holding one the caller has to remember to re-check.
  SELECT EXISTS (
    SELECT 1 FROM players
     WHERE user_id = p_user_id
       AND COALESCE(is_banned, FALSE) = FALSE
       AND status NOT IN ('suspended', 'pending_approval')
       AND COALESCE(active_flag, TRUE) = TRUE
       -- 00132: an unfinished account holds no console level. A claimed roster
       -- row can now be linked to a login before its owner has given a name or
       -- signed a waiver, and console access must not arrive first.
       AND COALESCE(onboarding_completed, FALSE) = TRUE
  ) INTO v_ok;

  IF NOT v_ok THEN
    RETURN NULL;
  END IF;

  IF EXISTS (SELECT 1 FROM players WHERE user_id = p_user_id AND role = 'admin') THEN
    RETURN 'admin';
  ELSIF EXISTS (SELECT 1 FROM players WHERE user_id = p_user_id AND is_exec = TRUE) THEN
    RETURN 'exec';
  ELSIF EXISTS (SELECT 1 FROM players WHERE user_id = p_user_id AND is_trainer = TRUE) THEN
    RETURN 'trainer';
  ELSE
    RETURN NULL;
  END IF;
END;
$$;

COMMENT ON FUNCTION public.admin_access_level(uuid) IS
  'The console level a signed-in user holds — admin, exec, trainer or NULL — '
  'gated on good standing AND a finished onboarding (00057, 00132).';


-- ---- 9. the member cannot erase their own review ------------
-- WITHHOLDING THE SELECT GRANT IS NOT ENOUGH, and section 7 would have been a
-- false sense of security on its own. `authenticated` holds a TABLE-LEVEL
-- UPDATE on players — verified, not assumed:
--
--   =# select privilege_type from information_schema.table_privileges
--       where table_name='players' and grantee='authenticated';
--    DELETE
--    UPDATE
--
-- A table-level grant covers columns added later automatically, so
-- privilege_claim_review became member-writable the moment section 1 ran, and
-- players_update_own (00005:54) lets a member update their own row. Somebody
-- whose privileges had just been held could therefore have sent
-- `PATCH /players?id=eq.<self>` with `privilege_claim_review: null` and erased
-- the only durable prompt an admin had to look at it. They could not have
-- granted themselves anything — role, is_exec and is_trainer are all guarded
-- below already — but making the flag disappear is most of the damage, because
-- the flag is the whole answer to "why can Steven not get into the console".
--
-- Guarded in the trigger rather than by revoking the column, because a REVOKE
-- of one column against a table-wide grant does not subtract from it, and
-- because this is where every other privileged column on this table is
-- protected. Body is otherwise the live definition verbatim.
--
-- The console is unaffected: it writes through the service-role client, where
-- auth.uid() IS NULL and the function returns at the first branch.
CREATE OR REPLACE FUNCTION public.guard_player_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  -- auth.uid() IS NULL covers the service-role console, which has already
  -- checked the caller's level in a server action.
  IF auth.uid() IS NULL OR is_admin(auth.uid()) THEN
    RETURN NEW;
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- A self-created row may only ever be an ordinary, unapproved member.
    IF COALESCE(NEW.is_exec, FALSE)
       OR COALESCE(NEW.is_trainer, FALSE)
       OR COALESCE(NEW.fee_exempt, FALSE)
       OR COALESCE(NEW.is_banned, FALSE)
       OR NEW.role IS DISTINCT FROM 'player'
       OR NEW.status IS DISTINCT FROM 'pending_approval'
       -- Added: a self-created row claiming an office is the same escalation as
       -- editing one in, and get_executives() would publish it.
       OR NEW.exec_title IS NOT NULL
       -- REPLACES 00086's portfolio line, for the same reason it existed: a
       -- self-created row cannot be an exec at all (is_exec is refused above),
       -- so permissions on one are meaningless — but they must not be a way to
       -- pre-stage values that come into force the moment an admin grants
       -- is_exec. cardinality(), not IS NOT NULL: see the note above.
       OR NEW.permission_role IS NOT NULL
       OR cardinality(COALESCE(NEW.permission_grants, '{}')) > 0
       OR cardinality(COALESCE(NEW.permission_revokes, '{}')) > 0
       -- Added by 00092: signing up is not the club letting you in, so a signup
       -- that arrives already numbered is claiming a membership nobody granted.
       OR NEW.member_code IS NOT NULL
       -- Added by 00132. Written only by ensure_player_for_user and cleared
       -- only by an admin resolving it; a row that arrives carrying one is
       -- inventing a claim decision nobody made.
       OR NEW.privilege_claim_review IS NOT NULL THEN
      RAISE EXCEPTION 'Not authorized to create a privileged player row';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.role            IS DISTINCT FROM OLD.role
     OR NEW.status       IS DISTINCT FROM OLD.status
     OR NEW.is_banned    IS DISTINCT FROM OLD.is_banned
     OR NEW.is_exec      IS DISTINCT FROM OLD.is_exec
     OR NEW.eligibility_flag IS DISTINCT FROM OLD.eligibility_flag
     OR NEW.fee_exempt   IS DISTINCT FROM OLD.fee_exempt
     OR NEW.active_flag  IS DISTINCT FROM OLD.active_flag
     OR NEW.waiver_reset_at IS DISTINCT FROM OLD.waiver_reset_at
     OR NEW.deletion_requested_at IS DISTINCT FROM OLD.deletion_requested_at
     OR NEW.membership_type IS DISTINCT FROM OLD.membership_type
     OR NEW.exec_photo_url IS DISTINCT FROM OLD.exec_photo_url
     -- Published to anonymous visitors by get_executives(), so an unguarded
     -- write is a public claim to an office the member does not hold, not a
     -- cosmetic field on their own profile.
     OR NEW.exec_title   IS DISTINCT FROM OLD.exec_title
     -- THE 00087 REPLACEMENT for 00086's portfolio line. All three, because
     -- omitting any one of them leaves a complete escalation path: the role
     -- alone chooses the base, a grant alone adds to it, and clearing a revoke
     -- alone hands back whatever the club took away.
     OR NEW.permission_role IS DISTINCT FROM OLD.permission_role
     OR NEW.permission_grants IS DISTINCT FROM OLD.permission_grants
     OR NEW.permission_revokes IS DISTINCT FROM OLD.permission_revokes
     -- Added by 00092. Assigned once by assign_member_code() and permanent;
     -- there is no legitimate self-edit, including clearing it.
     OR NEW.member_code IS DISTINCT FROM OLD.member_code
     -- Added by 00132. Setting it is meaningless and clearing it erases an
     -- admin's only durable prompt to review a privilege the member did not
     -- get — see the section header.
     OR NEW.privilege_claim_review IS DISTINCT FROM OLD.privilege_claim_review
     OR NEW.is_trainer   IS DISTINCT FROM OLD.is_trainer THEN
    RAISE EXCEPTION 'Not authorized to modify privileged player fields';
  END IF;
  RETURN NEW;
END;
$$;
