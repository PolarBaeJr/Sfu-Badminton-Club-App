# `scripts/`

Maintainer tooling. Nothing here runs as part of the apps; these are commands a
person runs by hand from a checkout.

---

## `gen-db-types.mjs`

Regenerates `packages/shared/src/types/database.gen.ts` from a live database.
It reads the Postgres catalogs with `psql` inside the database container,
reached over `ssh`, and emits the same shape the Supabase CLI would. Output is
a pure function of the schema (no timestamps, no hostnames), so re-running it on
an unchanged database produces no diff.

Run `node scripts/gen-db-types.mjs --help` for its options. A database is
named by a profile: copy `gen-db-types.profiles.example.json` to
`gen-db-types.profiles.json` (which is gitignored, because it names real hosts)
and fill in your ssh host and container. The root `npm run gen:types` script
runs the `production` profile; `--profile <name>` picks another, and explicit
`--ssh-host` and `--container` flags work without any profile. The Supabase
CLI's `supabase gen types typescript` produces the same shape if you would
rather use that.

Run it after every schema migration, and **read the diff.** A stale generated
type does not fail loudly; it fails by agreeing with you.

## The migration manifest

`supabase/migrations/.manifest.json` records `count`, `latest`, and a `rollup`
sha256 over every migration file's checksum in version order. A test in
`@badminton/shared` (`migration-manifest.test.ts`) recomputes it from the
directory and fails when the committed file disagrees, so a new migration needs
an updated manifest. The generator script is not in the repository; the test
shows exactly how each field is computed.

## One-off SQL

One-off data repairs live in
[`supabase/One Time Scripts/`](<../supabase/One Time Scripts/README.md>), not in
this directory.
