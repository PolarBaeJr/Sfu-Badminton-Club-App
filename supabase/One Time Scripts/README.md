# One Time Scripts

SQL that is run **once**, against a database in a particular state, and is then
finished. Nothing here is applied by any automated step — no migration runner,
no CI job, no snapshot script reads this directory.

## The line this directory draws

A file belongs here if **running it a second time is either meaningless or
wrong**, and belongs in `scripts/sql/` if running it again next month is the
point.

|                        | `supabase/One Time Scripts/`             | `scripts/sql/`                          |
| ---------------------- | ---------------------------------------- | --------------------------------------- |
| When it runs           | Once, on a specific day, by a person      | Every time the situation comes up        |
| What it assumes        | The state the database was in that day    | Nothing — it reads what is there         |
| After it has run       | Kept as a record of what was done         | Still live, still the tool for the job   |
| Example                | Moving the fee rows into `club_fees`      | Mirroring prod's grants onto a restore   |

## Why this is not `supabase/migrations/`

A migration changes the **schema** and every database gets it, in order,
forever. The files here change **rows** — the club's actual data — and they are
run by hand, by the owner, after reading them. Putting a data move in the
migrations directory would mean every future database replayed a repair for a
problem it never had.

That is a rule this repo has followed since `00094`; this directory is where
the files that follow it now live, instead of being scattered between
`scripts/` and `docs/ops/`.

## What is here

- **`00094-fee-ledger-data-migration.sql`** — moves the fee rows into
  `club_fees` alongside migration `00094`. Deliberately not a migration: it
  moves money records, and the counts on either side are a human check.
- **`cleanup-orphan-challenges.sql`** — removes zero-participant challenges
  left behind by the pre-fix `challenge_participants` RLS failure.
- **`reseed-admin.sql`** — recreates the primary admin account after a
  fresh-schema apply. Carries a specific `auth.users` id.

## Before you run one

Read it first. These touch live rows, and several of them name a specific
account or a specific date — a file that was correct in July is not
automatically correct now. Where a script prints counts, compare them.

The private, un-committed equivalents live in `docs/sensitive/run/` and are
gitignored on purpose; they are not duplicated here.
