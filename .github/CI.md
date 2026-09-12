# `.github/`

Continuous integration. **CI builds and pushes container images; it never
touches the database.** Migrations are applied by hand — see
[`supabase/`](../supabase/README.md).

```
workflows/
  ci.yml             type-check + lint + test the whole workspace
  build-images.yml   production images  → GHCR, tag `latest`
  build-staging.yml  staging images     → GHCR, tag `staging`
ci/
  check-shared-drift.mjs   guards the hand-copied edge-function constants
```

---

## `ci.yml` — the checks

Runs `npx turbo run type-check lint test --continue` across every workspace,
plus the drift check below.

Two entry points, and **no `push` trigger on the production branch**:

- `pull_request` against `deploy/docker-prod` — gates the PR.
- `workflow_call` — `build-images.yml` calls it first, so an image is never
  built from a commit that failed.

A direct push to the prod branch *is* covered, via that `workflow_call`. Adding
a `push` trigger on top would start a second identical run contending for the
same concurrency group — and if `cancel-in-progress` killed the `verify` job,
`needs: verify` would fail and the images would silently never build. A deploy
that quietly doesn't ship is worse than a duplicate run, so the trigger is
deliberately absent.

**It needs no secrets, on purpose.** The repo is public, so a PR from a fork
gets none, and a check that only passes for the owner is a check people route
around. `next build` succeeds with no `NEXT_PUBLIC_*` set — those values only
affect the shipped bundle, not whether the code compiles.

> `type-check` is a **separate** turbo task. `next build` does not run it and
> neither does vitest, so a type error can pass everything you ran locally and
> still fail here. Run `npm run type-check` at the root before pushing.

## `build-images.yml` — production

Triggered by a push to **`deploy/docker-prod`** (or manually). Builds natively
on arm64 — free for public repos — and pushes to GHCR tagged `latest` and
`sha-<commit>`. The self-hosted proxy auto-updates from `latest`.

`concurrency` cancels a superseded build: two quick pushes used to start two
builds that raced to move `latest`, and the *slower* one won — which deploys the
older commit.

## `build-staging.yml` — staging

Triggered by a push to `deploy/docker-staging`, and to `deploy/docker-prod` too
(staging should never be behind what is live, or it stops being a rehearsal).
Pushes the `staging` tag, which the staging containers track.

**It is a separate build rather than a re-tag of the production image**, because
every `NEXT_PUBLIC_*` value is a build arg inlined into the client bundle. The
production image has production's Supabase URL compiled in; pointing it at a
staging `.env` would move the server only and leave every browser-side query
aimed at the **production database**.

It runs the same CI suite, with an escape hatch: `workflow_dispatch` skips the
checks. Staging is where you go to find out whether something works, so refusing
to deploy a red commit would remove the one safe place to look at one — but a
red commit should reach staging by *decision*, not by default.

## `ci/check-shared-drift.mjs`

`supabase/` is not an npm workspace, so `turbo run test` never reaches
`supabase/functions/**`, and Deno cannot import `@badminton/shared` anyway.
`supabase/functions/_shared/constants.ts` is therefore a **hand-typed copy** of
values from `packages/shared/src/utils/constants.ts`.

This script compares them by value: every numeric constant the edge copy
declares must exist in the workspace with the same value. A stale `DEFAULT_ELO`
would make season compression regress ratings toward the wrong baseline.

Two things worth knowing:

- It lives in `.github/ci/` and not the conventional `.github/scripts/` because
  the root `.gitignore` excludes `scripts/` at any depth — the conventional path
  would silently keep this file out of the repo.
- **Known gap:** `_shared/push.ts` and `_shared/settings.ts` are *behavioural*
  mirrors, not literal ones. Comparing those means comparing logic, which is a
  Deno test suite's job, not a regex's. They are unguarded today.

---

## What CI does not do

- **No migrations.** Nothing in this directory connects to a database.
- **No deploy step.** CI pushes an image; the proxy on the host notices the new
  digest and rolls the containers itself. Never `docker compose up -d`,
  `--build`, or `docker pull` the player/admin containers on the host — they are
  owned by the proxy, and doing so detaches them from auto-update. See
  [`docs/ops/RUNBOOK.md`](../docs/ops/RUNBOOK.md).
- **No secret is required to pass**, and none should become required.
