# How it fits together

Four clients, one database. The phone app is a peer of the other three, not a wrapper
around any of them.

```
                  player web (Next.js)
                  admin console (Next.js)
  Supabase  <---- Discord bot
   Postgres       phone app        <- this directory
   PostgREST
   GoTrue
```

| Layer | Where it lives | Work for this app |
|---|---|---|
| Business logic | 23 Postgres functions | none, call the same RPCs |
| Authorization | RLS, 68 of 69 public tables | none |
| Validation, Elo, fees, brackets | `packages/shared`, 18,646 lines | none, import it |
| Screens and navigation | new | this is the project |
| Auth glue | new, plus one server change | see `02-auth.md` |
| Push notifications | new | see `03-push.md` |

Realtime carries over unchanged. `packages/ui/src/use-live-channel.ts` and
`packages/shared/src/utils/realtime-recovery.ts` already drive live session and
tournament updates, and the same client works natively.
