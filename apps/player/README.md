# `player` — the members' app

The member-facing half of the club app, served at the site root
([sfubadminton.com](https://sfubadminton.com)). Next.js 15 App Router, React 19,
installable as a PWA.

It carries the public landing page and leaderboard, and — once signed in — the
feed, ladder challenges, session check-in, fees, tournaments, notifications and
settings. The private exec/admin console is a **separate** app; see
[`../admin`](../admin/README.md).

Monorepo-wide setup, env vars and deployment live in the [root
README](../../README.md). This file is about this app only.

---

## Run it

```sh
npm run dev:player       # from the repo root — http://localhost:3000
```

Per-app scripts (run from this directory, or via `npm run <script> -w player`):

| Script | Does |
|--------|------|
| `dev` | `next dev` on port 3000 |
| `build` | `next build` (`output: 'standalone'` — that's what the container runs) |
| `start` | serve a production build on 3000 |
| `lint` | `next lint` |
| `type-check` | `tsc --noEmit` |
| `test` | Vitest, one run |

> `npm run type-check` is **not** part of `build` or `test`. CI runs it
> separately, so a type error can pass everything you ran locally and still fail
> the pipeline. Run it at the repo root before pushing.

## Layout

```
src/
  app/            App Router. One directory per route; every page is dynamic.
    api/          Route handlers — see "HTTP surface" below.
  components/     App-specific React components (nav, scanner, gates, banners).
                  Anything reusable across both apps belongs in packages/ui.
  lib/            Plain modules: rules, queries, formatting. This is the tested
                  layer — 44 suites in lib/__tests__ point here.
    actions/      'use server' Server Actions, one file per domain.
  fonts/          Barlow Condensed. .woff2 for the browser, .ttf for next/og.
  middleware.ts   Auth gate + redirects on every non-static request.
public/           PWA manifest, icons, service worker.
```

`lib/` holds the logic and `app/` holds the wiring, deliberately: routes are hard
to unit-test and `lib/` modules are not, which is why the test suite lives there.

## HTTP surface

Beyond the pages, `src/app/api/` exposes:

- **`/api/health/live`, `/api/health/ready`** — container probes. These must stay
  dependency-free. `middleware.ts` short-circuits `/api/health/` before it even
  constructs a Supabase client, and the middleware matcher excludes them too —
  two independent guards on purpose, because if one is mis-edited every
  container reports unhealthy at once.
- **`/api/passkey/{login,register}`** — WebAuthn ceremonies (`@simplewebauthn`).
- **`/api/calendar/[token]`** — per-player iCal feed, authenticated by the token
  in the path (no session), so a calendar client can subscribe to it.
- **`/api/discord/*`** — the service API the Discord bot calls. Machine-to-machine
  only; auth is checked in `lib/discord-service-auth.ts`, not by a user session.
  See [`../bot`](../bot/README.md).

## Things that will catch you

**Server Action parameters are client input.** Every exported parameter of a
`'use server'` function is a field in a POST body that anyone can craft — "no UI
passes this" is not a defence. Actions are wrapped in `runAction()`
(`lib/actions/_shared.ts`) so thrown errors survive Next's production redaction
as `{ ok: false, error }` values; that wrapper does **not** authorize anything.
Do the capability check first, before any write — not after it, and not inside a
later conditional.

**`_shared.ts` is not a `'use server'` module.** It is a plain helper file
imported by the ones that are, so a `grep` that assumes everything in
`lib/actions/` is an action boundary will misread it.

**The middleware bundle is on the hot path.** It deep-imports
`@badminton/shared/src/utils/constants` rather than the package barrel; the
barrel pulls the whole package in and took the bundle from 208 kB to 371 kB.
Keep new middleware imports dependency-light.

**The Discord profile card needs fonts on disk.** `next/og` renders it
server-side and reads `src/fonts/*.ttf` at request time. Nothing imports those
files, so nothing traces them into the standalone bundle — `next.config.js`
lists them in `outputFileTracingIncludes` by route. They're `.ttf` and not the
`.woff2` the browser gets because satori cannot read WOFF2. Get this wrong and
the route builds clean, then 500s on its first request inside the container.

**Camera permission is `camera=(self)`.** QR check-in and the tournament door
scanner both call `getUserMedia`. `camera=()` is a platform-level veto that
denies them before the member is ever prompted. See the note in
`next.config.js` — don't "tighten" it back.

**React is a single copy, pinned at the workspace root.** Adding `react` to a
package's `dependencies` reintroduces a second copy and you get React error #31
at runtime.

**Vitest needs its own config here.** `vitest.config.ts` sets the `@` alias and
overrides `jsx` for oxc — without those, anything importing `@/lib/...` or
anything with a `.tsx` in its import graph is untestable. The comments in that
file explain why the obvious spellings fail silently.

## Observability

Sentry (`sentry.*.config.ts`, `src/instrumentation.ts`) and PostHog are wired in
but only activate when their DSN/key env vars are set — `next.config.js` skips
the Sentry wrapper entirely otherwise, so local dev is clean by default.

Tracing and profiling sample rates are cost-tuned: at 100% they measurably ate
throughput on the self-hosted box. Don't raise them without re-measuring.
