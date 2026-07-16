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
   send-challenge-reminders, send-session-reminders,
   send-stale-confirmation-alerts, detect-noshow-patterns,
   mark-inactive-players. (apply-season-compression and
   capture-season-snapshot are invoked on demand — include the header there
   too.)

3. Deploy all functions:

   ```sh
   supabase functions deploy
   ```

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
