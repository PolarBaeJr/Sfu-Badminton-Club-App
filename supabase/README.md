# `supabase/` — schema, functions, and SQL tests

The database is **self-hosted Supabase** (Postgres 17) on the club's own
hardware, not Supabase Cloud. This directory holds the schema history, the Deno
edge functions, and a small set of transactional SQL tests.

```
migrations/   210 numbered .sql files — the whole schema, RLS, functions,
              triggers, and every change since.
functions/    Deno edge functions. Present, but NOT what runs the live jobs.
tests/        SQL that runs inside BEGIN … ROLLBACK. Not migrations.
```

---

## Migrations are applied by hand. CI never touches the database.

There is no automatic migration step anywhere in the pipeline. A deploy ships
*images*; the schema is moved separately, by a person, using
[`scripts/db-migrate.sh`](../scripts/README.md).

```sh
./scripts/db-migrate.sh status    [prod|staging]   # read-only, safe any time
./scripts/db-migrate.sh preflight [prod|staging]
./scripts/db-migrate.sh prepare   [prod|staging] <version>   # builds a bundle, applies NOTHING
./scripts/db-migrate.sh apply     [prod|staging] <version> [--yes]
```

`prepare` deliberately exits 0 without running anything — it prints a bundle for
you to read. `apply` runs it and then **confirms against the database** that the
migration row landed with the expected checksum before reporting success.

Applied versions are tracked in `public.schema_migrations`. A row with
`verified = false` means *inferred*, not observed — do not spot-check one and
promote it.

### Ordering: migrations first, with one real exception

Apply migrations **before** pushing code. An image deploy is DB-safe; app code
that expects a new column is not.

The exception is a migration that **changes an existing function's signature or
tightens what it accepts.** Migrations-first assumes the old image keeps working
against the new schema, and that assumption fails for the entire rolling window
while old containers are still serving. Draw generation is the live case: an old
generator can commit an unstamped match after the new one has already checked
for foreign matches, and nothing later removes it. Drain the affected feature
first.

### Writing one

- **End with `NOTIFY pgrst, 'reload schema';`** — 71 of the existing migrations
  do. PostgREST caches the schema, and a change it hasn't been told about
  produces *silent* failures: a failed read arrives as an **empty list**, never
  an error. You diagnose that from the gateway access log, not from the UI.
- **A `psql` superuser check proves nothing.** Superuser bypasses both RLS and
  grants, and reaches past the PostgREST schema cache. Verify with `SET ROLE`.
- **`information_schema.role_table_grants` reports grants that do not exist.**
  Read `pg_class.relacl` (and `pg_attribute.attacl` for column-level grants)
  instead.
- **Revoking from `anon` means naming both `PUBLIC` and `anon`.**
- **Don't derive a migration's premise from prod's live schema.** Prod runs
  behind; grep the pending range first. A duplicate migration has already been
  written this way once.
- Self-wrapping is your choice — some files open their own `BEGIN`/`COMMIT` and
  some don't — but `db-migrate.sh` decides how to invoke `psql` by looking for a
  top-level `COMMIT`, never a `BEGIN` (a `BEGIN` also opens a `DO` block).
- Regenerate `packages/shared/src/types/database.gen.ts` afterwards
  (`scripts/gen-db-types.mjs`) and **read the diff.**

## `functions/` is not the scheduler

The Deno edge functions are checked in and deployable, but **the self-hosted
stack does not schedule them.** The live jobs are `pg_cron` inside Postgres
calling the admin app's `/api/cron/*` routes over HTTP with a bearer secret.

Read `functions/DEPLOY.md` before touching them: every function requires an
`x-cron-secret` header matching the `CRON_SECRET` function secret, and they
**fail closed** — if that secret is unset, every request is rejected.

A `pg_cron` job returning 200 is not evidence the job ran: the HTTP client
follows redirects, so the 200 can come from somewhere else entirely. Verify from
what the job wrote.

## `tests/` are not migrations

Each file runs every statement inside one transaction that ends in `ROLLBACK`,
so it leaves nothing behind and is safe to point at staging:

```sh
ssh pi "docker exec -i supabase-staging-db psql -U postgres -d postgres \
  -v ON_ERROR_STOP=1" < supabase/tests/00203_conversion_arms.sql
```

They exist for behaviour that cannot be unit-tested — multi-statement
transactions, trigger interaction, lock behaviour. Two notes from experience:

- **Mutation testing cannot prove a lock.** Use two concurrent sessions and
  check `xmax`. And a lock test proves nothing about the *check* it guards —
  drive the happy path through `BEGIN … ROLLBACK` as well.
- **`prosrc` includes comments**, so a tripwire that greps a function's source
  for a phrase will pass even after the statement carrying it is deleted.

## Staging

Staging is refreshed from a prod dump at **04:00 daily**, which wipes any
staging-only migrations applied during the day (they correctly show as pending
again the next morning). The refresh also strips **column-level** grants —
`relacl` looks correct while `pg_attribute.attacl` is empty — and it resets the
owner's staging admin role.

More in [`docs/STAGING.md`](../docs/STAGING.md).
