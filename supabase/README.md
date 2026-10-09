# `supabase/`: schema, functions, and SQL tests

The database is Supabase (Postgres). This directory holds the schema history, the Deno edge functions, a small set of
transactional SQL tests, and a record of one-off data repairs.

```
migrations/         Numbered .sql files: the whole schema, RLS, functions,
                    triggers, and every change since. Count them rather than
                    trusting a number here; it drifts every migration.
functions/          Deno edge functions for the scheduled maintenance jobs.
tests/              SQL that runs inside BEGIN ... ROLLBACK. Not migrations.
One Time Scripts/   One-off data repairs, run by hand. See its README.
```

There is no `config.toml` here, so this is not a Supabase CLI project: the
migrations are plain SQL files.

---

## Migrations are applied by hand

Nothing in this repository applies a migration automatically. To build a fresh schema, apply every file in `migrations/`
in filename order. The migrations enable `pgcrypto`, `uuid-ossp`, `pg_cron` and
`pg_net`.

Some files open their own `BEGIN`/`COMMIT` and some do not. When applying
with `psql`, use `--single-transaction` only for a file with no top-level
`COMMIT`.

### Writing one

- **End with `NOTIFY pgrst, 'reload schema';`**, as many of the existing
  migrations do. PostgREST caches the schema, and a change it hasn't been told
  about produces *silent* failures: a failed read arrives as an **empty list**,
  never an error. You diagnose that from the gateway access log, not from the
  UI.
- **A `psql` superuser check proves nothing.** Superuser bypasses both RLS and
  grants, and reaches past the PostgREST schema cache. Verify with `SET ROLE`.
  It does **not** bypass triggers, though, and that catches people from the
  other direction: a maintenance script running as `postgres` still trips every
  guard trigger on the tables it writes. Give a guard a `current_user NOT IN
  ('anon', 'authenticated')` early return if maintenance is meant to pass
  through it (and then it cannot be `SECURITY DEFINER`, or `current_user`
  resolves to the owner and the guard never fires for anyone). 00050's
  `trg_guard_last_admin_passkey` deliberately has no such hatch, so a
  maintenance script has to disable that trigger by name.
- **`information_schema.role_table_grants` reports grants that do not exist.**
  Read `pg_class.relacl` (and `pg_attribute.attacl` for column-level grants)
  instead.
- **Revoking from `anon` means naming both `PUBLIC` and `anon`.**
- **Don't derive a migration's premise from a running database's schema.** A
  database can be behind the repo; grep the migrations not yet applied to it
  first. A duplicate migration has already been written this way once.
- **A migration that changes an existing function's signature, or tightens
  what it accepts, can break app code that is still running against it.** Draw
  generation is the known case: an old generator can commit an unstamped match
  after the new one has already checked for foreign matches, and nothing later
  removes it. Plan for the old and new code overlapping.
- Self-wrapping is your choice (some files open their own `BEGIN`/`COMMIT` and
  some don't), but a top-level `COMMIT` is what marks a file as self-wrapping. A
  `BEGIN` alone does not, because a `BEGIN` also opens a `DO` block.
- Regenerate `packages/shared/src/types/database.gen.ts` afterwards
  (`scripts/gen-db-types.mjs`) and **read the diff.**
- After adding a migration, update `migrations/.manifest.json` (`count`,
  `latest`, and a `rollup` sha256 over every file's checksum in version order).
  `packages/shared/src/__tests__/migration-manifest.test.ts` recomputes it from
  this directory and fails when the committed file disagrees.

## `functions/`: the scheduled maintenance jobs

The Deno edge functions run the expiry sweeps (challenges, walkovers),
challenge reminders and stale-confirmation alerts, the no-show and inactivity
checks and the account purges, plus an on-demand season snapshot. The scheduled
ones are invoked over HTTP by a scheduler outside the database. The session
reminders, inactivity notices and weekly digest are different: those are
`pg_cron` jobs inside Postgres calling the admin app's `/api/cron/*` routes with
a bearer secret.

Every function requires an `x-cron-secret` header matching the `CRON_SECRET`
function secret, and they **fail closed**: if that secret is unset, every
request is rejected. Besides `CRON_SECRET`, the functions read `SUPABASE_URL`
and `SUPABASE_SERVICE_ROLE_KEY`; the push-sending ones also need the VAPID keys
(`NEXT_PUBLIC_VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_EMAIL`), and the
two account purges only report (dry run) unless `PURGE_INACTIVE_ENABLED` /
`PURGE_UNFINISHED_ENABLED` is `true`. Each function's header comment says what it
does.

A `pg_cron` job returning 200 is not evidence the job ran: the HTTP client
follows redirects, so the 200 can come from somewhere else entirely. Verify from
what the job wrote.

## `tests/` are not migrations

Each file runs every statement inside one transaction that ends in `ROLLBACK`,
so it leaves nothing behind. Run one against a development database with
`psql`:

```sh
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f supabase/tests/00203_conversion_arms.sql
```

They exist for behaviour that cannot be unit-tested: multi-statement
transactions, trigger interaction, lock behaviour. Two notes from experience:

- **Mutation testing cannot prove a lock.** Use two concurrent sessions and
  check `xmax`. And a lock test proves nothing about the *check* it guards, so
  drive the happy path through `BEGIN ... ROLLBACK` as well.
- **`prosrc` includes comments**, so a tripwire that greps a function's source
  for a phrase will pass even after the statement carrying it is deleted.
