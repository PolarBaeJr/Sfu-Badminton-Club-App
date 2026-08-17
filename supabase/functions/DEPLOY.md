# Edge Function Deployment

All edge functions now require an `x-cron-secret` header matching the
`CRON_SECRET` function secret. Requests without it (or with a wrong value)
get a 401. If `CRON_SECRET` is unset the functions fail closed — every
request is rejected — so the secret MUST be set before deploying.

## Rollout steps

1. Generate and set the secret:

   ```sh
   supabase secrets set CRON_SECRET=$(openssl rand -hex 32)
   ```

2. Update every cron schedule in the Supabase dashboard
   (Edge Functions → the function → Schedules, or the pg_cron/`net.http_post`
   job if scheduled via SQL) to send the header:

   ```
   x-cron-secret: <the same value>
   ```

   Functions with schedules: expire-challenges, expire-walkover-pending,
   send-challenge-reminders, send-stale-confirmation-alerts,
   detect-noshow-patterns, mark-inactive-players, purge-deleted-accounts.
   (apply-season-compression and capture-season-snapshot are invoked on demand
   — include the header there too.)

3. Deploy all functions:

   ```sh
   supabase functions deploy
   ```

## Web push (VAPID) secrets

The reminder/alert functions (`send-challenge-reminders`,
`send-stale-confirmation-alerts`, `detect-noshow-patterns`) also send web
push notifications via `_shared/push.ts`. Set the VAPID secrets — the same
values used by the Next.js apps:

```sh
supabase secrets set \
  NEXT_PUBLIC_VAPID_PUBLIC_KEY=... \
  VAPID_PRIVATE_KEY=... \
  VAPID_EMAIL=...
```

If the secrets are unset, push sending is a silent no-op — the in-app
notification inserts still run. Note that web push only works for clients
served from an HTTPS origin (service worker requirement), so it activates
for real once the club domain lands.

## send-session-reminders was deleted — REDUNDANT, not broken

It was a SECOND session reminder, running daily from the Pi's host crontab
(`0 17 * * * ~/bin/run-edge-fn.sh send-session-reminders`) alongside the real
one. The real one is the pg_cron job that POSTs the admin app's
`/api/cron/session-reminders` every five minutes, and it is strictly better on
every axis:

|                  | admin route (kept)                  | edge function (deleted)     |
|------------------|-------------------------------------|-----------------------------|
| Source table     | `session_rsvp` (`intent = 'going'`) | `session_attendance`        |
| Timing           | each player's own lead time         | fixed "session is tomorrow" |
| Idempotency      | `reminded_at` claim-before-send     | **none**                    |

`session_attendance` is the CHECK-IN table — `checked_in_at TIMESTAMPTZ NOT
NULL DEFAULT NOW()`, and its INSERT policy requires `session_checkin_open()`,
which is false until shortly before a session starts. So a query for
*tomorrow's* sessions joined to check-ins matched nothing and sent nothing; the
logs showed `Sent 0 session reminders` every day. It was not silently
duplicating reminders — it was silently doing nothing.

The reason to delete it rather than leave it: it was a live, scheduled,
service-role job that inserts `notifications` rows and pushes with **no dedup
key at all**. Widening `checkin_opens_minutes_before` past 1440, or "fixing" it
to read `session_rsvp`, would immediately give every member two different
reminders per session — and the edge one would repeat on every invocation.

### Complete the removal on the Pi (owner action)

Both halves are required and only the first lives in this repo. Deleting the
function alone leaves cron POSTing at a 404 nobody watches; removing the
crontab line alone leaves a live service-role endpoint any holder of
`CRON_SECRET` can fire.

1. `ssh pi 'crontab -e'` — delete the line
   `0 17 * * * ~/bin/run-edge-fn.sh send-session-reminders >/dev/null 2>&1`
2. `supabase functions delete send-session-reminders` (or remove it from the
   edge runtime's function directory on the Pi).

Nothing to do for the reminders themselves — the pg_cron job at `*/5` has been
carrying them the whole time.

## refresh-leaderboards was deleted

The `refresh-leaderboards` function was removed from this repo. Complete the
removal on the hosted project:

1. Delete its cron schedule in the dashboard.
2. `supabase functions delete refresh-leaderboards`

## Shared code

`_shared/` holds code used by every function:

- `auth.ts` — `requireCronSecret(req)` (constant-time secret comparison)
- `client.ts` — `createServiceClient()` and `jsonResponse(body, status)`
- `constants.ts` — Deno cannot import the npm workspace; keep in sync with
  `packages/shared/src/utils/constants.ts`
- `push.ts` — `sendPushToPlayers(supabase, playerIds, payload)`; keep in sync
  with `packages/shared/src/push/send.ts`. It carries a Deno copy of the
  request-line chunking and the concurrency bound from
  `packages/shared/src/utils/{query-chunks,concurrency}.ts` — `.in()` is a
  query-string filter and Kong refuses a request line over 8,192 bytes, which
  is about 215 uuids.
- `dedup.ts` — `alreadyAlertedIds(...)`, so a daily job does not re-notify
  about the same record every morning forever. Reads the `notifications` table
  as its own ledger; returns `null` when that read fails, which callers must
  treat as "send nothing".
