-- ============================================================
-- 00059 — a reinstatement fee can record its transaction id
--
-- club_fees gained `reference` in 00039 so a payment could be
-- traced back to the e-transfer or portal receipt that settled
-- it. reinstatement_fees never did, even though it is the same
-- act: money changed hands and somebody has to reconcile it
-- later. An exec recording a reinstatement had nowhere to put
-- the transaction id and was leaving it in the ban reason or
-- nowhere at all.
--
-- Same type and limit as club_fees.reference (TEXT, capped at
-- 120 in the Zod schema) so the two ledgers agree.
-- ============================================================

ALTER TABLE reinstatement_fees
  ADD COLUMN IF NOT EXISTS reference TEXT;

COMMENT ON COLUMN reinstatement_fees.reference IS
  'Payment reference / transaction id for this reinstatement, e.g. an e-transfer confirmation number. Free text, capped at 120 chars by the validator. Mirrors club_fees.reference.';
