-- ============================================================
-- 00231: A RECEIPT FOR MONEY BACK
--
-- APPLY AFTER 00230. Nothing here depends on it; the ordering is only so that
-- schema_migrations stays a straight line.
--
-- ------------------------------------------------------------
-- WHAT THIS IS
-- ------------------------------------------------------------
-- One nullable column, one private bucket, one storage policy, and one CHECK
-- widened by a single conjunct. No new table, no status column, no approval
-- workflow: the expense row /fees already records is the record, and this adds
-- somewhere to keep the picture of the receipt behind it.
--
-- ------------------------------------------------------------
-- WHY A RECEIPT IS EVIDENCE AND NOT A REQUIREMENT
-- ------------------------------------------------------------
-- The row already asserts the payment. 00077 built the flow: an exec buys
-- shuttles out of their own pocket, the spend is recorded so the club knows the
-- money went out, and an admin later confirms the club has paid them back. The
-- assertion that money moved is the ROW. What this column adds is the evidence
-- for an assertion that has already been made, which is why it changes no
-- money figure, gates nothing, and blocks nothing.
--
-- IT IS OPTIONAL, AND THAT IS A DECISION RATHER THAN A SHORTCUT. A receipt can
-- legitimately not exist in a form anybody can photograph: it was lost on the
-- way home, the shop emailed it, the court block was invoiced to the club with
-- no counter slip at all. Requiring one would mean an exec who genuinely cannot
-- produce it either cannot record the spend, or records it dishonestly with
-- some other picture attached. Both are worse than a NULL that says, plainly,
-- that no receipt was attached. NOT NULL here would also retro-invalidate every
-- expense already on production, which were all filed before this existed.
--
-- ------------------------------------------------------------
-- THE UPLOADER AND THE PAYER ARE ROUTINELY DIFFERENT PEOPLE
-- ------------------------------------------------------------
-- This is the fact that shapes the storage policy and the check in the server
-- action, so it is worth stating before either. 00077:23-24 documents the two
-- ordinary cases for `paid_by`:
--
--     an exec pays at the counter and records it themselves
--       -> marked_by = paid_by = that exec
--     an exec texts a receipt to an admin who records it
--       -> marked_by = the admin, paid_by = the exec
--
-- The SECOND one is the commonest way a receipt reaches the console at all: it
-- arrives as a photo in somebody else's phone. So the person uploading the file
-- is frequently not the person the club owes money to, and any rule written as
-- "the payer owns the receipt" would refuse precisely the flow this feature
-- exists to serve. The folder below is therefore named after the UPLOADER, and
-- the server action re-checks the path against the uploader and not against
-- `paid_by`. Neither is a weaker rule than the other; they are answers to
-- different questions, and only one of them is a question storage can ask.
-- ============================================================


-- ------------------------------------------------------------
-- 1. The bucket. PRIVATE, deliberately.
-- ------------------------------------------------------------
--
-- Same reasoning 00174 gives for feedback-screenshots, and it is stronger here.
-- `avatars` is public because an avatar is already shown to every member. A
-- receipt is not: it is a photograph of a real-world transaction, which routinely
-- carries the last four digits of somebody's card, a signature, a home address
-- printed on a delivery slip, or simply what the club spends and where. The
-- ledger itself sits behind fees.expenses.read, which an ordinary member does not
-- hold, and a public bucket would put the most revealing part of the row back
-- outside that boundary. An unguessable path is not an access control.
--
-- The limits are set HERE, at creation, rather than only in the picker. That
-- means an oversized or wrong-typed file is refused AT UPLOAD, in the browser,
-- while the exec is still standing there and can pick a smaller photo. Enforced
-- only client-side it would be advice; enforced only later it would be a file
-- accepted and then silently unusable. 8 MiB and the same three image types as
-- 00174, so the two buckets do not drift on what an attachment is.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES (
  'expense-receipts',
  'expense-receipts',
  FALSE,
  8388608,
  ARRAY['image/jpeg', 'image/png', 'image/webp']
)
ON CONFLICT (id) DO UPDATE
  SET public             = EXCLUDED.public,
      file_size_limit    = EXCLUDED.file_size_limit,
      allowed_mime_types = EXCLUDED.allowed_mime_types;


-- ------------------------------------------------------------
-- 2. Storage policy: write-only, and only into your own folder.
-- ------------------------------------------------------------
--
-- INSERT only. THERE IS DELIBERATELY NO SELECT POLICY, and that is the whole
-- read model: reads are service-role only. The console signs a short-lived URL
-- on demand behind fees.expenses.read, so who may look at a receipt is decided
-- by the same capability that decides who may see the row it belongs to, in one
-- place, in the app. A SELECT policy for `authenticated` would be a second and
-- quieter answer to that question, and the only one storage could express is
-- "the person who uploaded it", which is the wrong set: the admin who needs to
-- check an exec's receipt before reimbursing them is not its uploader.
--
-- The uploader never needs to read one back either. The dialog previews the
-- local File it is about to upload, the same trick the feedback form and
-- AvatarUpload use, so there is nothing to fetch and nothing lost by having no
-- way to fetch it.
--
-- The folder is auth.uid(), NOT players.id. players.id is a separate uuid and
-- storage RLS can only see the JWT subject. foldername()[1] is the first path
-- segment. Anything reading this path back has to key on auth.uid() as well:
-- that is what addExpense checks, and getting it wrong there would be a check
-- that passes for nobody.
DROP POLICY IF EXISTS expense_receipts_auth_insert ON storage.objects;
CREATE POLICY expense_receipts_auth_insert ON storage.objects
  FOR INSERT TO authenticated
  WITH CHECK (
    bucket_id = 'expense-receipts'
    AND (storage.foldername(name))[1] = auth.uid()::text
  );


-- ------------------------------------------------------------
-- 3. Remember the PATH, never a URL.
-- ------------------------------------------------------------
--
-- The column is nullable with no default, for the reasons in the header, and it
-- goes in BEFORE the constraint below, which references it.
ALTER TABLE public.club_ledger ADD COLUMN IF NOT EXISTS receipt_path TEXT;


-- ------------------------------------------------------------
-- 4. A DONATION HAS NO RECEIPT TO REIMBURSE.
-- ------------------------------------------------------------
--
-- club_ledger_reimbursement_is_expense (00159:132-135) already fences every
-- expense-only column into the expense half of the ledger: paid_by,
-- reimbursed_at, reimbursed_by and quantity. receipt_path is one more of
-- exactly the same kind, so it joins them rather than being the one column that
-- is quietly allowed on both halves.
--
-- 00159's own comment gives the reason this fence exists at all: without it an
-- income row could carry a payer and a settlement date and would render with a
-- reimbursement badge on the Expenses tab's own component. A receipt on a
-- donation is the same class of nonsense one column over. Income has no payer,
-- so it has nobody to reimburse, so it has no evidence of a reimbursement to
-- hold. The income dialog does not offer the picker, and this is what makes
-- that a fact about the database rather than a fact about the dialog.
--
-- ADD CONSTRAINT has no IF NOT EXISTS, so the DROP comes first: the pattern at
-- 00077:83-84, which is re-runnable for the same reason.
--
-- NO `NOT VALID` NEEDED, and this is worth stating positively rather than
-- leaving as something to worry about. The column is brand new and nullable, so
-- every row already in club_ledger holds receipt_path IS NULL, so every
-- existing income row already satisfies the new conjunct. The validation scan
-- cannot fail. A NOT VALID constraint here would buy nothing and would leave
-- behind an unvalidated constraint somebody has to remember to validate.
ALTER TABLE public.club_ledger DROP CONSTRAINT IF EXISTS club_ledger_reimbursement_is_expense;
ALTER TABLE public.club_ledger ADD CONSTRAINT club_ledger_reimbursement_is_expense CHECK (
  direction = 'expense'
  OR (paid_by IS NULL AND reimbursed_at IS NULL AND reimbursed_by IS NULL AND quantity IS NULL
      AND receipt_path IS NULL)
);

COMMENT ON COLUMN public.club_ledger.receipt_path IS
  'Object path in the private expense-receipts bucket, for expense rows only. Sign it on demand; never store the signed URL.';


-- PostgREST caches the schema. Without this, a column it has not reloaded reads
-- back as ABSENT WITH NO ERROR, and a failed PostgREST read arrives as an empty
-- list rather than as a failure: the symptom would be silence on a money page.
NOTIFY pgrst, 'reload schema';

-- ============================================================================
-- AFTER THE MIGRATION
--
-- ADDITIVE AND FORWARD-ONLY. Everything above is an INSERT, a CREATE or an
-- ALTER ... ADD. No table is dropped, no data is moved, and no existing row
-- changes value. The one DROP is of a constraint that is immediately recreated
-- with one conjunct more than it had.
--
-- APPLY IT WITH --single-transaction. There is no top-level COMMIT in this
-- file, by house convention, so the runner supplies the transaction:
--
--   psql --single-transaction -f 00231_a_receipt_for_money_back.sql
--
-- THIS ONE ADDS A COLUMN, SO THE GENERATED TYPES REALLY DO MOVE. Regenerate
-- database.gen.ts and read the diff: the expected change is receipt_path
-- appearing on club_ledger's Row, Insert and Update types and nothing else.
-- Anything larger means something else has drifted and this is the moment it is
-- visible.
--
-- AND REGENERATE THE RELEASE MANIFEST, BEFORE PROMOTING:
--
--   ./scripts/gen-migration-manifest.sh
--
-- Commit the resulting supabase/migrations/.manifest.json alongside this file.
-- The rollup is a hash OVER THIS FILE'S BYTES, so any further edit here
-- invalidates it: regenerate once the content is final. db-migrate.sh preflight
-- compares the checkout's manifest against public.schema_migrations, and
-- migration-manifest.test.ts recomputes it from the directory, so a stale
-- manifest both refuses the promotion and keeps CI red.
--
-- ---- APPLY THIS BEFORE THE CODE THAT READS IT -------------------
--
-- THE ORDERING IS NOT COSMETIC HERE. Four separate reads name receipt_path once
-- the app change ships: EXPENSE_COLS in ledger-card.tsx, the `existing` selects
-- in updateExpense and removeExpense, and the receipt route's own select.
-- PostgREST refuses a select naming an unknown column, and the console reads a
-- refused read as an empty result, so with the code deployed and this file
-- unapplied the expense ledger renders EMPTY and every Edit and every Delete
-- reports "Expense not found". On a money page, with nothing in any log saying
-- why. Apply this first.
--
-- ---- VERIFYING IT ------------------------------------------------
--
-- 1. The bucket is private and capped:
--
--      SELECT id, public, file_size_limit, allowed_mime_types
--        FROM storage.buckets WHERE id = 'expense-receipts';
--      -- expect: f | 8388608 | {image/jpeg,image/png,image/webp}
--
-- 2. There is an INSERT policy and NO select policy:
--
--      SELECT polname, polcmd FROM pg_policy
--       WHERE polrelid = 'storage.objects'::regclass
--         AND polname LIKE 'expense_receipts%';
--      -- expect exactly one row, polcmd = 'a' (INSERT)
--
-- 3. An income row cannot carry a receipt, and an expense row can.
--
--    BOTH PROBES ARE WRITES, SO BOTH ARE FENCED IN A TRANSACTION THAT ROLLS
--    BACK. This is not caution for its own sake. The second statement sets
--    receipt_path to the value it already holds on every expense row in the
--    club's ledger, which changes no figure but is still a write across a money
--    table, and a verification step that mutates what it is verifying is a bad
--    trade however small the mutation. Run the whole block, or none of it: the
--    ROLLBACK is what makes it a read.
--
--    The CHECK is not RLS. It applies to everybody, superuser included, which
--    is the point of putting it in the database rather than in a policy, so it
--    does not matter which role runs this.
--
--      BEGIN;
--
--      -- expect: ERROR  new row ... violates check constraint
--      --         "club_ledger_reimbursement_is_expense"
--      UPDATE club_ledger SET receipt_path = 'x/y.jpg' WHERE direction = 'income';
--
--      -- expect: UPDATE <n>, no error
--      UPDATE club_ledger SET receipt_path = NULL WHERE direction = 'expense';
--
--      ROLLBACK;
--
--    The first statement aborts the transaction, so run it in its own
--    BEGIN/ROLLBACK if you want to see the second one succeed in the same
--    sitting. An aborted transaction reports "current transaction is aborted"
--    for everything after it, which is the expected result and not a new fault.
-- ============================================================================
