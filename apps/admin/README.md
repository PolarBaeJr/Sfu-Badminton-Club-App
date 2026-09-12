# `admin` — the exec console

The private console the club's executives run the club from, mounted at
[sfubadminton.com/admin](https://sfubadminton.com/admin). Next.js 15 App Router,
React 19. Same stack as the member app, different audience and a much harder
authorization story.

It covers members and accounts, seasons and fees, sessions and attendance,
ladder ratings and disputes, the tournament desk, announcements, platform
settings, permissions and the audit log.

Monorepo-wide setup, env vars and deployment live in the [root
README](../../README.md). This file is about this app only.

---

## Run it

```sh
npm run dev:admin        # from the repo root — http://localhost:3001
```

Locally the console is **root-mounted** (`http://localhost:3001/dashboard`). In
every deployed build it sits under `/admin`. See the base-path note below —
that difference is the source of a whole class of bug that only appears in
production.

| Script | Does |
|--------|------|
| `dev` | `next dev` on port 3001 |
| `build` | `next build` (`output: 'standalone'`) |
| `start` | serve a production build on 3001 |
| `lint` | `next lint` |
| `type-check` | `tsc --noEmit` |
| `test` | Vitest, one run (89 suites in `src/lib/__tests__`, 93 across the app) |

> `type-check` runs separately in CI and is not implied by `build` or `test`.
> Run it at the repo root before pushing.

## Layout

```
src/
  app/            App Router — one directory per console section.
    api/          Route handlers: cron, health, passkey, email webhooks.
  components/     Console-specific UI.
  lib/            The tested layer: rules, gates, queries, formatting.
    actions/      'use server' actions, one file per domain.
    tournament-actions/   The tournament desk, split by concern
                          (brackets, seeding, results, finalize, …).
```

## HTTP surface

- **`/api/health/live`, `/api/health/ready`** — container probes; keep them
  dependency-free.
- **`/api/passkey/{login,auth,register}/{options,verify}`** — WebAuthn.
- **`/api/cron/{session-reminders,inactivity-notices,weekly-digest}`** — the
  scheduled jobs. **They are not run by a platform scheduler.** `pg_cron` inside
  Postgres calls these routes over HTTP, authenticating with
  `Authorization: Bearer $CRON_SECRET`. The Supabase edge functions in
  `supabase/functions/` are *not* what runs on the self-hosted stack.
- **`/api/webhooks/{resend,ses}`** — delivery/bounce callbacks from the email
  provider.

## Authorization — read this before touching a write path

Console access is **one question with four answers** — none, executive, varsity
trainer, admin — stored across three columns, and translated in exactly one
place: `lib/console-access.ts`. `/permissions` is the only screen that sets a
level. `writeConsoleLevel()` in `lib/actions/permissions.ts` is the only writer
of those columns, and it is not exported.

Beyond that level, individual capabilities are checked through
`lib/permissions.ts` and the shared `CAPABILITY_GATES`. `players.portfolio` does
not exist: 00086 gave an exec one of four VP portfolios and 00087 dropped the
column again in the same sitting, replacing it with `permission_role` plus two
capability arrays. Anything in the docs or in an old branch that still says
"portfolio" is describing a schema that was never live for long — read
`permission_role`.

Three rules that have each already cost a bug:

1. **Gate before you write, at the top.** A capability check placed after the
   mutation, or nested inside a later `if`, means an uncapable caller has
   already changed data by the time they're refused.
2. **Every exported parameter of a `'use server'` function is a client-supplied
   POST field.** Counting call sites proves nothing — if you don't want a
   parameter honoured, delete the parameter.
3. **`_internal.ts` in `tournament-actions/` is not an action module.** It says
   so in its own header comment, and it false-matches the obvious `grep` for
   `'use server'` files. Many of the exported actions are thin `runAction`
   wrappers, too — follow them to the `*Impl` to find the real gate.

Self-promotion is blocked by a **BEFORE trigger in the database**, not by RLS
and not by this app. A missing SELECT grant protects nothing: an unqualified
`UPDATE` doesn't need one. Any new column on `players` needs adding to that
guard.

## Things that will catch you

**`basePath` is baked in at build time.** `NEXT_PUBLIC_BASE_PATH` is inlined
into the client bundle when the image is built; setting it in the host's runtime
`.env` does nothing. Next applies the prefix to `<Link>` and to router
navigation, but **not** to raw strings — `fetch('/api/x')`,
`window.location.href = '/login'`, a `redirectTo` built from
`window.location.origin`. Because the console shares an origin with the member
app, an unprefixed path is not a 404: it silently hits the *player* container.
Route every such string through `withBase()` in `lib/base-path.ts`, and keep
that module free of Node-only imports — the Edge middleware pulls it in.

**Navigation is cached for 30 seconds.** `staleTimes.dynamic` is set in
`next.config.js` so flicking between console tabs doesn't re-run a full server
render each way. Mutations already invalidate it (`revalidatePath` /
`router.refresh`), so the window only ever applies to passive navigation. If you
are measuring whether it works, look for the *absence* of an `?_rsc=` request.

**The reminder job claims before it sends.** `session-reminders` marks a row
claimed, then sends; anything that throws after the claim is a silent permanent
drop for that member. Stale claims are retried after ~15 minutes, capped at five
attempts. Keep that ordering in mind before adding work to the send path.

**A cron route returning 200 proves very little.** The caller follows redirects,
so a 200 can come from a page that isn't the job. Verify a scheduled run from
what the job actually wrote, not from the response code.

**React is a single copy, pinned at the workspace root.** Adding `react` to a
package's `dependencies` reintroduces a second copy — React error #31 at
runtime.

## Observability

Sentry and PostHog activate only when their env vars are set; `next.config.js`
skips the Sentry wrapper otherwise, so local dev stays quiet.
