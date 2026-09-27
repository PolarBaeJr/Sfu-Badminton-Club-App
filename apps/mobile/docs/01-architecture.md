# How it fits together

Four clients, one database. The phone app is a peer of the other three, not a wrapper
around any of them.

```
                  player web (Next.js)
                  admin console (Next.js)
  Supabase  <---- Discord bot
   Postgres       Android app (Kotlin)   <- this directory
   PostgREST
   GoTrue
```

There is no Supabase SDK in the app. It makes plain HTTPS calls
(`HttpURLConnection`, JSON through kotlinx.serialization):

- **GoTrue** for four calls: send a code, verify it, refresh, and log out this
  device (`scope=local`). They are made on the wire the way auth-js makes them
  (`auth/GoTrueApi.kt`).
- **PostgREST** with the member's JWT for every read (`data/`). The RPCs
  `get_leaderboard` and `get_active_season`, and the tables `players_self`,
  `players`, `ratings`, `matches`, `sessions`, `club_fees`, `seasons`,
  `tournaments` and `club_events`. A 401 refreshes the session once and retries
  once. A failed read reaches the screen as an error, never as an empty list.

| Layer | Where it lives | Work for this app |
|---|---|---|
| Business logic | 23 Postgres functions | none, call the same RPCs (no writes yet) |
| Authorization | RLS, 68 of 69 public tables | none |
| Fees, sessions, auth rules | `packages/shared` | hand ported to `shared/`, kept in step by hand |
| Elo | Postgres and `packages/shared` | none, ratings are read, never computed |
| Screens and navigation | Compose, `ui/` | four tabs behind sign in |
| Auth glue | `auth/` | email code and passkey sign-in (`02-auth.md`) |
| Push notifications | not built | see `03-push.md` |

No realtime: every screen loads on open and refreshes by pull to refresh.

The app starts in `BadmintonApp`, which builds one `AppContainer` per process so a
session has one owner. With no usable Supabase config the container has no services
and the app shows `ConfigErrorScreen` instead of starting.
