-- ============================================================
-- 00224 — VP EXTERNAL MAY SPEAK IN DISCORD
--
-- APPLY AFTER 00223. That file widens the two vocabulary CHECKs to admit
-- `announcements.discord.write`; this one stores the string. Run out of order
-- and every statement below is rejected by
-- permission_baselines_vocabulary_check, loudly and with nothing written —
-- which is the right failure, but it is avoidable by reading this line.
--
-- ------------------------------------------------------------
-- WHAT THE OWNER ASKED FOR
-- ------------------------------------------------------------
-- "announcement discord.write should be based on external."
--
-- 00223 shipped the capability admin-only, and said in its own header that
-- handing it to a VP job would be a different migration. This is that
-- migration. The reasoning it gave still holds and is why this is a file rather
-- than a one-line edit to a constant: the four VP portfolios are SEEDED ROWS
-- (00104) and editable-roles.test.ts reads that file as text, so widening one
-- means writing down the widening where "reset to shipped default" can find it.
--
-- It is also the coherent home for it. VP External already holds every other
-- announcement write; the person who decides what the club says to its members
-- should not have to ask somebody else to say it in the one place most members
-- actually read.
--
-- IT IS STILL NOT IN THE EXEC BASELINE. This is the one comms act in the
-- console with no undo — unpublishing takes an announcement down, and nothing
-- takes a Discord message back — so it belongs to a named job and not to
-- everybody who happens to be an exec.
--
-- ------------------------------------------------------------
-- WHY THERE ARE THREE STATEMENTS AND NOT ONE
-- ------------------------------------------------------------
-- A BUILT-IN ROLE IS COPIED ONTO A PERSON, NOT RESOLVED THROUGH — 00104's
-- central decision, taken so resolvePermissions() could stay pure and
-- synchronous at 22 call sites. Assigning "External" writes
-- permission_role = 'custom' with the row's capabilities copied into
-- players.permission_grants, and permission_baseline_id as the label saying
-- where the copy came from.
--
-- So widening the ROW alone would produce a portfolio that grants something
-- nobody holding it can do, until somebody happens to re-save the baseline in
-- the console. The app's own edit path propagates for exactly this reason
-- (holdersOf() in apps/admin/src/lib/actions/permission-baselines.ts); a
-- migration does not run that code, so it has to do the same work here.
--
-- holdersOf() reaches TWO populations, and both are reproduced below:
--
--   1. rows LABELLED with the baseline (permission_baseline_id), the copied
--      shape every assignment made since 00104;
--   2. rows still storing the LEGACY permission_role = 'external', which
--      resolve through the hard-coded ROLE_DEFAULTS. 00104 part 4 converted the
--      ones that existed then; this handles any that appeared since, and costs
--      nothing when there are none.
--
-- ON PRODUCTION TODAY BOTH POPULATIONS ARE EMPTY (checked 2026-09-09: three
-- holders, all Internal). That is not a reason to skip the statements — it is
-- the reason they are cheap, and staging and every future database will not
-- have the same shape.
--
-- ------------------------------------------------------------
-- IDEMPOTENT, AND NOT BY ON CONFLICT
-- ------------------------------------------------------------
-- Every statement is guarded by NOT (... @> ARRAY[...]), so re-applying this
-- file is a no-op rather than a second copy of the string in an array that
-- allows duplicates. That matters more than usual here: staging re-applies the
-- whole migration set nightly.
--
-- IT APPENDS, IT DOES NOT REWRITE. The External row is EDITABLE — that is
-- 00104's entire feature — so the club may have changed it since. Overwriting
-- it with the shipped default plus one would silently discard those edits,
-- which is the failure 00104's ON CONFLICT DO NOTHING exists to avoid. "Give
-- VP External this capability" means add this capability, and nothing else.
-- ============================================================

BEGIN;

-- 1. THE BASELINE ROW ------------------------------------------------------
--
-- Matched on builtin_role, not on the name: renaming a built-in is allowed
-- (00104's column comment says so explicitly), so the name is not an identity.
UPDATE public.permission_baselines
   SET capabilities = capabilities || ARRAY['announcements.discord.write']::TEXT[]
 WHERE builtin_role = 'external'
   AND NOT (capabilities @> ARRAY['announcements.discord.write']::TEXT[]);

-- 2. THE PEOPLE WHO HOLD IT BY LABEL --------------------------------------
--
-- Joined back to the row rather than hard-coding the seeded id, so a database
-- whose External row was created with a different id (a restore, a rebuild)
-- still updates the right holders.
--
-- A REVOKE IS LEFT ALONE, deliberately and importantly. Somebody with the
-- capability explicitly revoked has had a decision made about them, and the
-- resolver subtracts revokes after grants — so adding the grant here does not
-- hand it back, and stripping the revoke would be this migration overruling a
-- person. Nothing below touches permission_revokes.
UPDATE public.players p
   SET permission_grants = p.permission_grants || ARRAY['announcements.discord.write']::TEXT[]
  FROM public.permission_baselines b
 WHERE b.builtin_role = 'external'
   AND p.permission_baseline_id = b.id
   AND NOT (p.permission_grants @> ARRAY['announcements.discord.write']::TEXT[]);

-- 3. THE LEGACY HOLDERS ----------------------------------------------------
--
-- permission_role = 'external' resolves through ROLE_DEFAULTS in code, which
-- the deploy accompanying this migration has already widened. So these rows
-- need NOTHING — the constant is their answer, and it moved.
--
-- Stated as a comment rather than a statement because writing a grant here
-- would be actively wrong: it would turn a role-resolved row into a row that
-- carries its own copy, which is exactly the "same word meaning two things"
-- outcome 00104 part 4 exists to prevent. If such a row is later converted to
-- the copied shape, holdersOf() converts it with the CURRENT baseline, which
-- by then includes this capability.

COMMIT;

-- The CHECK constraints did not move, but permission_baselines and players did,
-- and a reload costs nothing.
NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- VERIFY, after applying:
--
--   SELECT name, builtin_role,
--          capabilities @> ARRAY['announcements.discord.write'] AS has_it,
--          array_length(capabilities, 1) AS total
--     FROM permission_baselines
--    WHERE builtin_role = 'external';
--   -- expect has_it = t, total = 7
--
--   SELECT count(*) FROM players p
--     JOIN permission_baselines b ON b.id = p.permission_baseline_id
--    WHERE b.builtin_role = 'external'
--      AND NOT (p.permission_grants @> ARRAY['announcements.discord.write']);
--   -- expect 0
-- ============================================================================
