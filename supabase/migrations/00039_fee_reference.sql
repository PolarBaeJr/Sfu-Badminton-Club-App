-- ============================================================
-- 00039_fee_reference.sql — record the transaction id alongside the method
-- ============================================================
-- Marking a fee paid captured only *how* it was paid, never *which* payment.
-- Reconciling a bank export against the roster therefore meant matching on name
-- and amount, which stops working the moment two people pay the same amount on
-- the same day — which is the normal case for a flat season fee.
--
-- A separate column rather than appending to `method`: method is now a fixed
-- vocabulary (see utils/payment-methods.ts) so it can be grouped and counted,
-- and folding a unique id into it would make every row its own category.
--
-- Deliberately TEXT with no format constraint. E-transfer confirmations,
-- portal receipt numbers and hand-written cheque references share no shape, and
-- a CHECK here would only ever reject something an exec legitimately wanted to
-- record.
-- ============================================================

ALTER TABLE club_fees      ADD COLUMN IF NOT EXISTS reference TEXT;
ALTER TABLE tournament_fees ADD COLUMN IF NOT EXISTS reference TEXT;

COMMENT ON COLUMN club_fees.reference IS
  'Transaction/confirmation id for this payment, as recorded by the exec who marked it paid. Free-form: e-transfer references, portal receipt numbers and cheque numbers have no common format.';

COMMENT ON COLUMN tournament_fees.reference IS
  'Transaction/confirmation id for this payment. See club_fees.reference.';
