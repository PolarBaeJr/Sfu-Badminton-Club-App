-- ============================================================
-- 00116_per_session_scan_policy.sql — "scan required" becomes a property of the
-- night, not of the deployment
-- ============================================================
-- WHAT MOVED. Whether a member may check in by tapping a button, or must scan
-- the QR taped to the door, was `REQUIRE_SCAN_TO_CHECK_IN` — a module-level
-- constant in apps/player/src/lib/checkin-scan.ts, shipping false. That made it
-- a property of the BUILD: flipping it changed what attendance meant for every
-- session at once, including the casual drop-ins where checking in from the bus
-- is perfectly fine.
--
-- Presence is a property of the NIGHT. A ladder final wants it; a Sunday social
-- does not. `sessions` is the only table with a row per night, so the flag
-- belongs on it. The alternatives were considered and rejected:
--
--   platform_settings   reproduces the global switch with extra steps.
--   seasons             a term with one strict night in it cannot say so.
--   track               re-decided every time a member changes stream, and
--                       says nothing about any particular evening.
--
-- WHAT IT GATES, precisely. Only the TOKENLESS check-in — the player app's
-- `checkInToSession(sessionId)`, reached from the card's quiet "Check in
-- without scanning" and from the fallback inside the scanner dialog. The QR
-- path (`checkInWithToken`, and the /checkin/[token] page a phone's native
-- camera lands on) is untouched and must stay that way: it is the route this
-- policy exists to require, and gating it would close the only door left open.
--
-- It is enforced in the server action, not in RLS. The RLS gate on
-- session_attendance is session_checkin_open(), which answers a question about
-- the CLOCK; a token is not visible to it — the insert carries no evidence of
-- how the member got there — so a policy predicate could not tell a scan from a
-- tap and would have to refuse both. The app layer is the only layer that knows
-- which entry point ran. That is stated plainly rather than glossed: someone
-- calling the tokenless server action directly is refused by that action, and
-- someone posting straight at PostgREST with their own key is bounded by
-- session_checkin_open() and by nothing this column says.
--
-- DEFAULT FALSE, NOT NULL, and both halves matter. Every session that exists
-- today keeps exactly today's behaviour — scan offered, one-tap check-in also
-- available — because a live club must not wake up to a check-in it cannot use.
-- NOT NULL because a three-valued flag would leave the app deciding what NULL
-- means, and it would decide it in two places.
--
-- ON THE GRANT. Additive, and belt-and-braces rather than load-bearing here.
-- `players` is column-restricted (00032 revoked the table grant and hands back
-- named columns), which is why 00115 existed at all: a column added there is
-- unreadable until it is named. `sessions` has NO column-level grants anywhere
-- in this migration history — `authenticated` holds the table-level SELECT, and
-- a table grant covers every column, including ones added later. The player
-- app's schedule page reads sessions with select('*') and works today, which is
-- the live proof of that. So the GRANT below is a no-op on both databases. It
-- is written anyway because the cost of restating it is nothing and the cost of
-- assuming wrong is the failure mode 00115 documents: a missing column grant
-- fails the WHOLE PostgREST request with 403, supabase-js resolves rather than
-- rejects, and the app's `?? []` renders the refusal as an empty schedule.
--
-- IDEMPOTENT. IF NOT EXISTS on the column, and GRANT does not error on a
-- privilege already held, so re-running this changes nothing.
--
-- DEPLOY ORDER IS FREE, in both directions. The app must survive a database
-- without this column, because migrations here are applied by hand and can lag
-- a deploy:
--   * the player schedule selects '*', so the field is simply absent and
--     requiresScanToCheckIn() reads absent as false;
--   * the tokenless action reads the column in its OWN query and treats any
--     error as "unknown, therefore permissive", rather than folding it into the
--     select that decides whether the session is open at all;
--   * the console writes the column in its OWN update, so a pre-migration edit
--     still saves name, date and location and the checkbox is a silent no-op.
-- Applying this migration ahead of the deploy is equally safe: nothing reads
-- the column until the code that knows about it ships, and every row is false.

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS require_scan_to_check_in BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN sessions.require_scan_to_check_in IS
  'When true, this session can only be checked into by scanning its QR — the tokenless checkInToSession action refuses it and the player app offers no direct affordance. Enforced in the app layer, not in RLS: session_checkin_open() cannot see whether a token was presented. Default false preserves the original behaviour, where scanning and one-tap check-in sit side by side.';

GRANT SELECT (require_scan_to_check_in) ON public.sessions TO authenticated;
