# scripts/sql

SQL that is **run again whenever the situation comes up**. Every file here
reads the database it is pointed at and works out its own answer, so it is
correct today and correct next month.

Most of it exists because `prod-to-dev-snapshot.sh` drops and restores the
`public` schema, and a plain `pg_dump` restore does not carry everything back:

- **`mirror-public-acls.sql`** — run on the SOURCE with `psql -At`, pipe the
  output into the TARGET. Emits the GRANTs that make a restored database carry
  production's privileges instead of a blanket `GRANT ALL`.
- **`mirror-public-publications.sql`** — the same shape, for publication
  membership.
- **`check-public-dependents.sql`** — lists anything outside `public` that
  depends on something inside it, i.e. what a `DROP SCHEMA public CASCADE`
  would take with it.

**One-off repairs and data moves do not go here.** They go in
`supabase/One Time Scripts/`, which explains the split — the short version is
that a file belongs there if running it twice is meaningless or wrong.
