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

**It scrubs the members at the end of the run.** The dump itself carries real
names, emails, phones, officer notes and fee records, because that is what a
faithful `pg_dump` of production is. The scrub replaces each of those with a
value derived from the row's own id (stable across refreshes, so a member is the
same person on staging tomorrow), blanks the officer notes and audit diffs, and
deletes the bearer tokens, passkeys, push endpoints and bounce records. Ids,
ratings, matches, fee status and row counts survive untouched. `$STAGING_ADMIN_EMAILS`
is kept in the clear on purpose: sign-in on staging is an email code, so
scrubbing the owner's address locks the owner out of staging.

The run then queries staging for any surviving real identifier and **fails** if
it finds one. `SCRUB_MEMBER_DATA=0` skips the scrub and warns loudly; use it only
to reproduce a bug that genuinely depends on the real values, and re-run the
snapshot straight afterwards.

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

## Privacy and retention

### `request-account-deletion.sh`

Schedules a member's deletion on their behalf, for the case the app cannot
cover: a member who asks by email, or whose own request was wiped out by a
database restore. The in-app **Settings → delete account** is the only other
writer of `deletion_requested_at`, and the admin console can only *cancel* a
pending deletion, never start one. Until that console button exists, this is the
route.

```sh
./scripts/request-account-deletion.sh --actor <admin-email> \
  --target <member-email> --reason "emailed request 2026-09-21"   # dry run
./scripts/request-account-deletion.sh … --confirm                 # commits
./scripts/request-account-deletion.sh … --db prod                 # skip staging
```

It writes to **both** databases by default, production first, so a refusal on
prod never leaves the two copies disagreeing. On staging the checks relax rather
than tighten: a member who is not there is a no-op, and no audit row is written,
because staging's `audit_logs` is reloaded from prod every night. With the
snapshot scrub live this is belt and braces rather than the main event, since
staging no longer holds the member's real identifiers either way, but it still
applies the deletion immediately instead of waiting for 04:00.

It is a **dry run unless `--confirm` is passed** (the transaction ends in
`ROLLBACK;` instead of `COMMIT;`), and it refuses before writing anything if the
actor or target does not resolve to exactly one player, if they are the same
person, if the target is already scheduled, or if the target is already purged.

The refusal worth knowing about: it also stops on a target who holds console
access. Scheduling a deletion sets `active_flag = false`, and
`apps/admin/src/lib/supabase-server.ts` rejects exactly that, so deleting an
admin, exec or trainer locks them out of the only screen the cancel button lives
on. `--allow-officer` overrides it, deliberately, once you have read that
sentence.

Every commit writes an `audit_logs` row with `action_type =
'officer_deletion_requested'` — distinct from the app's
`self_deletion_requested`, so the log always says which of the two happened.

### `run-edge-fn.sh`

Invokes one Supabase edge function with the cron secret and **records the
result**. The seven crontab lines on the Pi call this; the nightly retention
jobs run through it, `purge-deleted-accounts` included, which is the job that
has to satisfy a deletion request inside 30 days. Read the header before
changing it: the version it replaced discarded the HTTP status, so a function
failing every night for a month looked identical to one that never failed.

## One-off SQL

These live in **`supabase/One Time Scripts/`**, not in this directory.

- **`cleanup-orphan-challenges.sql`** — deletes zero-participant challenges left
  by a since-fixed RLS failure. Only touches challenges with no participants and
  no match. There's a commented-out preview `SELECT` at the top; use it.
- **`reseed-admin.sql`** — recreates the owner's admin account after a
  fresh-schema apply. Also the fix for staging, where the nightly refresh drops
  the owner's admin role.
- **`wipe-summer-2026-test-data.sql`** — deletes the Summer 2026 test rows that
  members can still see. The season was *retired* separately on 2026-09-10,
  which zeroed the counters but deleted nothing; this is the deletion half, and
  it is owner-run section by section. Read the header: the ordering matters,
  because the derived-stats tables carry no foreign key and an FK sweep cannot
  find them.
- **`00094-fee-ledger-data-migration.sql`** — the data half of migration 00094,
  deliberately kept out of `supabase/migrations/` so no automated step applies
  it. It moves the club's money records, and the counts on either side are meant
  to be read by a person.

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
