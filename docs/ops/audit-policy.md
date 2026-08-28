# Audit policy

What the club's audit trail guarantees, in one page, so the promise and the code
agree. Written to close F-023 of the 2026-08-27 pre-deployment audit, which
correctly said the policy had never been chosen — only inherited.

## The guarantee

**Audit writes are best-effort. They are not transactional with the action they
record.** An action can succeed while its audit row does not.

That is a deliberate choice, not an omission, and the reason is the alternative.
Making the audit write blocking means throwing *after* the mutation has already
landed. The operator sees a failure for something that worked, and the obvious
next move — do it again — applies the fee, the ban or the rating repair twice.
The console has said so in `confirmWalkover` for a long time: throwing would
skip the audit **and** leave irreversible effects unattributed.

## The two classes

`apps/admin/src/lib/audit-policy.ts` is the list. It has one behavioural
consequence.

| | Routine | Required |
|---|---|---|
| Examples | a session rename, an attendance mark, a passkey login | money, permissions, moderation, rating repair, disputes, deletions, tournament finalisation, legal versions |
| On a refused insert | reported to Sentry, action proceeds | **retried without the payload**, then reported |
| Throws? | never | never |

The retry drops `old_value` / `new_value` (or `details`, on the tournament
trail) and keeps actor, action, target and the human's typed reason, with the
original error appended to that reason so the loss is legible in the row itself
rather than only in Sentry.

This is not a consolation prize. The payload is the likeliest reason a row is
refused — an oversized jsonb, a value the column will not take, a text key in a
uuid column (the console shipped exactly that bug and the comment in `audit.ts`
still records it). Dropping it is usually the difference between a row and no
row at all.

## What IS transactional

Actions that run through a `SECURITY DEFINER` RPC write their audit fact in SQL,
inside the same transaction as the change, and never reach `audit.ts`:

- `merge_players` (00163)
- `apply_match_result` (00177)

This is the strongest form and it is where new high-risk actions should go. It
is not retrofitted across the other 79 call sites, because each one would have
to become an RPC to get it.

### What is atomic but NOT self-auditing

This list used to also name dispute resolution and placement bonuses, and that
was wrong — neither function contains an audit insert. Being one transaction and
writing its own audit fact are separate properties, and only the two above have
both. These are atomic in the change they make, but their audit row is still
written afterwards by `audit.ts` on the best-effort path described above:

- `resolve_dispute_rated` / `claim_dispute_for_resolution` (00178, 00188)
- `apply_placement_bonus` / `credit_participant_placement_bonus` (00179, 00188)

For the bonuses the gap is narrower than it looks: `tournament_bonus_grants`
(00188) records every grant in the paying transaction, so who was paid what is
durable even when the audit row is lost. That table is a ledger, not an audit
trail — it does not record who pressed the button — but it means a lost audit
row cannot make a payment unaccountable.

## Keeping the list honest

`apps/admin/src/lib/__tests__/audit-policy.test.ts` scans every `action_type:`
literal in the admin app and fails when one matches a risk-class name pattern
and is not classified — and also when the list names an action that no longer
exists, which is how a rename hides. It found five destructive actions on its
first run.

## What this means for the product copy

Nothing in the app or the docs may claim that every sensitive action is
guaranteed to be logged. It may say sensitive actions are logged, which is true,
and audit gaps are reported to Sentry rather than being invisible.
