-- ============================================================
-- 00091 — a hand-picked set gets a name of its own
--
-- *** APPLY THIS BEFORE DEPLOYING THE CODE THAT GOES WITH IT. *** Without it,
-- saving a hand-picked set on /permissions fails on the role CHECK below. The
-- failure is loud and changes nothing, but it is the whole of the feature
-- refusing to save.
--
-- (The constraint's name is deliberately not written above this line: the
-- storage test slices from its FIRST occurrence to the end of the CHECK, so a
-- mention up here would drag half a page of prose into what it parses.)
--
-- WHAT THIS ADDS AND WHY. The editor lets an admin tick individual capabilities
-- for one person. Storing that needs a role, because resolvePermissions() reads
-- a NULL role as "not composed" and does not consult the deltas at all — so a
-- hand-picked set with no role would resolve to the level baseline and the ticks
-- would do nothing. Until now the only roles were the four VP jobs, and the
-- editor's only way to store a hand-picked set was to borrow the closest of them
-- and correct it with grants and revokes.
--
-- THAT BORROWING IS THE BUG THIS FIXES, and it is not cosmetic. A varsity
-- trainer who ticked one session capability would have been stored as 'finance'
-- with the club's three expense capabilities revoked: a row that says the
-- trainer is the treasurer, an audit entry that says the same, and — the part
-- that bites — membership of the blast radius of any future change to what
-- 'finance' means. Role contents live in code, so that change leaves no trace
-- here at all. An empty base has no blast radius, because there is nothing in it
-- to change.
--
-- NOTHING CHANGES FOR ANYONE. This only WIDENS a CHECK: every value that was
-- accepted before is still accepted, no existing row is rewritten, and no row
-- anywhere holds 'custom' until an admin saves one. Safe to apply well ahead of
-- the code.
--
-- WHY A NEW FILE, rather than editing 00087. Staging has 00087 recorded as
-- applied, so an in-place edit never re-runs there and the two databases diverge
-- on which roles they will accept. Same reason 00087 was not edited into 00086,
-- and 00089 and 00090 not into 00088.
--
-- THE ROLE LIST NOW LIVES HERE. 00087 drops and re-adds the constraint and so
-- does this file, so the LATEST one is the only one whose list is live —
-- exactly how the capability vocabulary already moved from 00087 to 00088 to
-- 00089. capability-storage.test.ts asserts that list against PERMISSION_ROLES
-- and follows it here.
-- ============================================================

ALTER TABLE public.players DROP CONSTRAINT IF EXISTS players_permission_role_check;
ALTER TABLE public.players ADD CONSTRAINT players_permission_role_check
  CHECK (permission_role IS NULL
         OR permission_role IN ('finance', 'tournaments', 'internal', 'external', 'custom'));

-- The other four CHECKs are untouched and all of them still apply to 'custom'.
-- The one worth naming is players_permission_deltas_need_role_check: 'custom' is
-- a role, so it carries deltas legitimately, and a hand-picked set of nothing at
-- all — 'custom' with two empty arrays — is a person with no access rather than
-- an unwritten row. That is a real state and the constraint permits it.

COMMENT ON COLUMN public.players.permission_role IS
  'Which set of capabilities this person STARTS from: finance | tournaments | internal | external | custom, or NULL for "not composed". NULL is the deploy-day state of every row and means the level baseline applies — exactly the access this person had before per-user permissions existed. A role REPLACES the baseline rather than adding to it, so assigning one is how somebody is narrowed to their own job — and, on a varsity trainer, how they are given an area their level never reached without being made an executive. ''custom'' is the empty base: it grants nothing by itself, so everything a hand-picked person holds is spelled out in permission_grants and the row says what they hold rather than a name plus two corrections. Settable on an executive or a varsity trainer; IGNORED for admins, who are superusers by level (permits() short-circuits before any stored set is read), which is why setPlayerPermissions() refuses to store one on an admin rather than storing a value nothing consults. Privileged: guarded by guard_player_privileged_columns and writable only by setPlayerPermissions() in the admin console, which enforces grant closure and is audited.';

-- No NOTIFY: no column, function or signature changed, so PostgREST's cached
-- schema is still correct.
