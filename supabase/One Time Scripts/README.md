# One Time Scripts

SQL that is run **once**, against a database in a particular state, and is then
finished. Nothing here is applied by any automated step: no migration runner
and no CI job reads this directory.

## The line this directory draws

A file belongs here if **running it a second time is either meaningless or
wrong**. A script whose point is to be run again whenever the situation comes
up is a tool, not a record, and does not belong here.

## Why this is not `supabase/migrations/`

A migration changes the **schema** and every database gets it, in order,
forever. The files here change **rows**, the club's actual data, and they are
run by hand, by the owner, after reading them. Putting a data move in the
migrations directory would mean every future database replayed a repair for a
problem it never had.

That is a rule this repo has followed since `00094`, and this directory is
where the files that follow it live.

## What is here

- **`00094-fee-ledger-data-migration.sql`**: moves the fee rows into
  `club_fees` alongside migration `00094`. Deliberately not a migration: it
  moves money records, and the counts on either side are a human check.
- **`cleanup-orphan-challenges.sql`**: removes zero-participant challenges
  left behind by the pre-fix `challenge_participants` RLS failure.

## Before you run one

Read it first. These touch live rows and assume the state the database was in
on a particular day: a file that was correct in July is not automatically
correct now. Where a script prints counts, compare them.
