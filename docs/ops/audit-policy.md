# Audit policy

What the club's audit trail guarantees, in one page, so the promise and the code
agree. Written for F-023 of the 2026-08-27 pre-deployment audit, which correctly
said the policy had never been chosen — only inherited.

Writing it down was never enough to close that, because the open question was
not what the code did; it was whether the club is willing to live with it. That
answer is now recorded under **The decision**, below.

## The guarantee

**Audit writes are best-effort. They are not transactional with the action they
record.** An action can succeed while its audit row does not.

That is a deliberate choice, not an omission, and the reason is the alternative.
Making the audit write blocking means throwing *after* the mutation has already
landed. The operator sees a failure for something that worked, and the obvious
next move — do it again — applies the fee, the ban or the rating repair twice.
The console has said so in `confirmWalkover` for a long time: throwing would
skip the audit **and** leave irreversible effects unattributed.

## The decision

**Accepted by the club owner on 2026-08-29: explicit best effort.**

In full, that means three things, and the third is the one that constrains
future work:

1. An action is never blocked or rolled back because its audit row failed to
   save. The action stands.
2. Nothing in the product or the documentation claims complete logs — see
   *What this means for the product copy* at the end.
3. High-risk actions get a stronger path where one is available: the required
   class below, and the in-transaction trail above it.

**What this does not promise.** That every action is in the log. An action can
succeed while its audit row does not, and where the row is lost entirely there
is nothing on the audit screen to say so — the report goes to Sentry. Anyone
treating the audit log as a complete record of what happened is treating it as
something it has never been.

The two alternatives were considered and refused. **Transactional everywhere**
means throwing after the fee, ban or rating repair has already landed: the
operator sees a failure for something that worked, repeats it, and it happens
twice — a worse outcome than a missing line. **A durable outbox** — a queue
table plus a replay worker — is a subsystem to build and then operate, for a
failure that fires when Postgres refuses a single insert.

### The asymmetry this leaves, also accepted

The same console action can produce a durable audit row on one path and a
best-effort one on the other. Resolving a dispute is the live example: the
unrated path writes its audit fact inside the transaction, the rated path
writes it afterwards from TypeScript. That is not a defect to be tidied up
later — it is what accepting best effort means in practice. Paths get the
stronger treatment when they are rewritten for some other reason, not on their
own account.

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
- `void_club_match` (00203)
- `convert_club_match_to_casual` (00203)
- `resolve_dispute_unrated` (00203)

The last three arrived together and none of them were built for this: 00203 put
those three operations into one transaction each for their own reasons, and the
audit insert moved inside along with everything else. That is the pattern to
expect — this list grows when a path is rewritten anyway, not as a project of
its own.

This is the strongest form and it is where new high-risk actions should go. It
is not retrofitted across the other 79 call sites, because each one would have
to become an RPC to get it.

### What is atomic but NOT self-auditing

This list used to also name dispute resolution and placement bonuses, and that
was wrong — neither function contains an audit insert. Being one transaction and
writing its own audit fact are separate properties, and only the two above have
both. These are atomic in the change they make, but their audit row is still
written afterwards by `audit.ts` on the best-effort path described above:

- `resolve_dispute_rated` / `claim_dispute_for_resolution` (00178, 00188, 00192)
- `apply_placement_bonus` / `credit_participant_placement_bonus` (00179, 00188)

`resolve_dispute_rated` sat beside `resolve_dispute_unrated` on this list until
00203 moved the unrated one up. Same screen, same button, two different
guarantees — that is the accepted asymmetry described under *The decision*.

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
