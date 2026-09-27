# apps/mobile

The members' phone app. Milestone 1 is Android, run through Expo Go: sign in by
email code, the ladder, your own stats, upcoming sessions and your membership
statement, all read only. How to run it is in `docs/05-development.md`.

## What this is, and what it is not

It is a **separate installable app**, not a webview wrapper. No Capacitor, no
Cordova, no Trusted Web Activity. The screens are native views.

It is **not a fourth backend**. It is a fourth client of the same Supabase, on the
same footing as the player web app, the admin console and the Discord bot. Nothing
here should grow its own API.

## Why it can be one codebase serving both platforms

`packages/shared` is 66 files and 18,646 lines, and exactly one of them
(`utils/event-waiver.ts`) imports anything Node, Next or React specific. That is the
Elo engine, fee tiers, entry fees, bracket layout, waiver eligibility, membership
rules and match results, all platform agnostic TypeScript today.

Two native codebases would mean porting that twice, into two languages, with no
shared tests. `docs/reference/` and the memory notes record that the Elo factors
compound and that two weight tables deliberately disagree. An independent port
diverges silently and nothing in this repo would catch it.

So `ios/` and `android/` below are the two platform targets of one app, not two
separate products. If that decision is ever reversed, reverse it here first: every
other choice in this directory follows from it.

## Scope: the player app only. The console stays on the web.

Console authorization is application layer: 93 capability gates in Next.js server
code against exactly one RLS policy that touches `is_exec`. A native console means
reimplementing all 93 per platform or moving them into the database.

It would also be the least used surface, built twice. As of 2026-09-21, eleven of
thirteen exec and admin accounts have never taken a single console action, while 34
of 47 member accounts signed in within 30 days. The player app is the one with users.

## Why this already works: the writes are in the database

The player web app reads tables directly in 297 places and calls **23 Postgres
functions** for its writes, among them `submit_match_result`,
`create_challenge_atomic`, `enter_tournament_event`, `report_walkover_atomic`,
`respond_to_challenge` and `dispute_match_result`.

So the business logic is not in Next.js, it is in Postgres. The sixteen `'use server'`
files in the player app are mostly transport: authenticate, call an RPC, revalidate a
page. This app skips the transport and calls the same functions. It is a second
caller, not a reimplementation.

Row level security is already the gate: 68 of the 69 `public` tables have RLS
enabled, and the one that does not (`discord_role_revocations`) denies
`authenticated` SELECT outright. A native client holding a member's JWT is therefore
defensible without anything new in front of it.

**The audit to run before writing code:** find anything the player app does inside a
server action that is *not* already behind an RPC. Each of those has to become one,
or the phone app cannot do it. The list is expected to be short.

## The blocker to settle first

Passkeys. Both verify routes mint the session by redeeming a `generateLink` token on
a **cookie writing** server client:

- `apps/player/src/app/api/passkey/login/verify/route.ts:173`
- `apps/admin/src/app/api/passkey/login/verify/route.ts:221`

A phone app has no cookie jar. Those routes have to return the access and refresh
tokens in the response body, and the app stores them in Keychain (iOS) or
EncryptedSharedPreferences (Android). That is a change to shipped authentication
code, so it gets scoped and reviewed on its own before anything else starts.

Native passkeys additionally need an associated domain file served from
`sfubadminton.com` with a matching RP ID: `.well-known/assetlinks.json` for Android,
`.well-known/apple-app-site-association` for iOS. See `docs/02-auth.md`.

## Layout

```
apps/mobile/
  ios/          the iOS app expansion: native project, entitlements, signing
  android/      the Android app expansion: native project, manifest, signing
  src/
    screens/      one file per screen
    components/   shared presentational pieces
    navigation/   the navigator and route types
    hooks/
    lib/
      auth/       sign in, token storage, the passkey bridge
      supabase/   the client, typed against packages/shared
      push/       FCM and APNs registration
  assets/       icons, splash, fonts
  docs/         the decisions, written down before the code
```

## Outside the npm workspaces, on purpose

The root `package.json` lists its workspaces by name and leaves this directory
out. The root forces one `react` across the web apps through `overrides`, and the
Expo SDK's `react-native` needs the exact `react` it was built against, which is a
different patch. One install cannot satisfy both. So this app has its own
`package-lock.json` and its own `node_modules`, installed from here:

```
cd apps/mobile
npm install
```

Check `npm prefix` prints this directory before the first install. If it prints the
repository root, npm will install into the web apps' tree instead.

Being outside also means:

- **No CI yet.** turbo, the root `npm run type-check` and the Dockerfile never see
  this app. Run its gates by hand: `npm run type-check && npm test && npx expo
  install --check`.
- **`@badminton/shared` is not a dependency.** Metro resolves it by path
  (`metro.config.js`), and TypeScript by `paths` (`tsconfig.json`).

## Importing from packages/shared: deep imports only

Never `import ... from '@badminton/shared'`. The barrel re-exports the email sender,
and a few shared files use node crypto; none of that exists on a phone. Import the
one pure file you need by its path:

```ts
import { SIGNIN_OTP_TYPES } from '@badminton/shared/src/utils/auth-otp';
```

`metro.config.js` refuses the barrel, `src/email/`, `src/push/`,
`utils/event-waiver` and `utils/data-api-key` at bundle time, and
`src/__tests__/import-guard.test.ts` checks the same list, including every shared
file reached through relative imports, in `npm test`.
