# `scripts/`

Operator tooling. Nothing here runs in CI and nothing here runs inside a
container — these are commands a person runs from a laptop, and most of them
reach production over `ssh pi` into the database container.

**Every credential stays on the host.** No script in this directory wants a
connection string, because a connection string carries the Postgres password and
nobody working on this repo holds it. Access is always
`ssh <host> "docker exec -i <container> psql -U postgres …"`.

---

## Database migrations

### `db-migrate.sh` — the migration runner

```sh
./scripts/db-migrate.sh status    [prod|staging]        # read-only, safe any time
./scripts/db-migrate.sh preflight [prod|staging]
./scripts/db-migrate.sh backfill  [prod|staging]
./scripts/db-migrate.sh prepare   [prod|staging] <version>
./scripts/db-migrate.sh apply     [prod|staging] <version> [--yes]
```

`prepare` builds the bundle, prints an `ssh` command, and **exits 0 having
applied nothing** — read the bundle, then run it. `apply` runs it and then
confirms against the database that the migration row landed with the expected
checksum. Bundle creation is never treated as evidence of anything.

It exists because two things have gone wrong doing this by hand:

1. **Transaction wrapping.** Some migration files open their own
   `BEGIN`/`COMMIT` and some don't. `--single-transaction` on a self-wrapping
   file gives a nested-transaction warning and a commit that doesn't mean what
   you think; omitting it on a file that doesn't self-wrap leaves half a
   migration applied on failure. The script reads the file and decides — by
   matching a top-level `COMMIT`, never a `BEGIN` (a `BEGIN` also opens a `DO`
   block).
2. **Under-claiming.** A migration this script did not watch succeed is never
   recorded as applied. Better a false "pending" than a false "applied".

### `gen-migration-manifest.sh` *(local only — not tracked)*

Writes `supabase/migrations/.manifest.json`: `count`, `latest`, and a `rollup`
sha256 over every file's checksum in version order. The rollup is the
load-bearing value — `latest` alone can't see a migration *edited* after it was
applied, and a count can't see one renumbered. Regenerate after adding a
migration; a test in `@badminton/shared` checks it.

### `gen-db-types.mjs`

Regenerates `packages/shared/src/types/database.gen.ts` from a live database,
reading the catalogs over `ssh` and emitting the same shape the Supabase CLI
would. Output is a pure function of the schema — no timestamps, no hostnames —
so re-running it on an unchanged database produces no diff.

Run it after every schema migration, and **read the diff.** A stale generated
type doesn't fail loudly; it fails by agreeing with you.

## Snapshots

### `prod-to-dev-snapshot.sh`

Online `pg_dump` of prod into the staging database — MVCC, no prod downtime, all
through `docker exec` so the host needs no `postgresql-client`. Copies the whole
`public` schema plus `auth.users` and `auth.identities` (so `player.user_id` FKs
stay valid); prod sessions and refresh tokens are deliberately skipped.

This is what runs nightly at 04:00. It is **not** a faithful copy on purpose,
and the header comment says exactly where it diverges.

Its three SQL helpers live in `sql/` and are all **read-only on the source** —
run them against prod with `psql -At`, pipe the output into the target:

| File | Puts back what `pg_dump --schema=public` loses |
|------|-----------------------------------------------|
| `check-public-dependents.sql` | Lists objects *outside* `public` that depend on something inside it — `DROP SCHEMA public CASCADE` takes them and the restore does not put them back. Run this **before** a restore. |
| `mirror-public-acls.sql` | Production's actual grants, instead of a blanket `GRANT ALL`. |
| `mirror-public-publications.sql` | Publication membership — a publication is a database-level object, so a schema dump contains no trace of it. |

> When capturing SQL these emit, use `psql -Atq`. Without `-q`, psql puts
> command tags (`CREATE TABLE`, `DO`) into the captured output and the replay
> fails.

## One-off SQL

- **`cleanup-orphan-challenges.sql`** — deletes zero-participant challenges left
  by a since-fixed RLS failure. Only touches challenges with no participants and
  no match. There's a commented-out preview `SELECT` at the top; use it.
- **`reseed-admin.sql`** — recreates the owner's admin account after a
  fresh-schema apply. Also the fix for staging, where the nightly refresh drops
  the owner's admin role.

## Assets

- **`make-icons.py <source-image>`** — renders the PWA icon set for both apps.
  The committed `icon-512.png` is soft because the only available source was
  64×64; re-run this against a proper high-resolution or vector asset and that
  goes away. Read the header before "improving" the resampling — the
  supersample-and-threshold approach was tried and produces crisper edges at the
  cost of wrecking the mark.

---

## Before you run any of these against production

Reads are fine. **Writes are the owner's to run** — hand over the exact SQL
rather than executing it. And `docker compose` matches services by project +
service name, not by `container_name`: check the resolved project and dry-run
first. That mistake has taken production down once.
