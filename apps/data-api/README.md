# `data-api`: the club's external Data API

The service behind [`API.md`](./API.md), which is the contract. Where this code
and that document disagree, the document is the bug report.

A dependency-free Node 24 service: `node:http`, `node:crypto` and the global
`fetch`. `package.json` has no runtime dependencies, only TypeScript, vitest and
`@types/node` for the build and tests.

Consumer-facing documentation is served by the service itself at
`GET /documentations` (for example `https://api.sfubadminton.com/documentations`):
one self-contained HTML page, no key, from `src/docs-page.ts`. Tests fail when
a route, scope, query parameter or error code in `src/server.ts` or
`src/params.ts` is missing from it or from `API.md`. `GET /changelog` is the
keyless list of what changed in each version, from `src/changelog-page.ts`.

The routes live in one table, `ROUTES` in `src/server.ts`: template, scope,
accepted parameters, and whether unknown parameters are refused. Parameter
parsing is `src/params.ts`. The scope list is `src/scopes.ts`, a copy of
`DATA_API_SCOPES` in `packages/shared/src/utils/data-api-key.ts` that
`__tests__/scopes.test.ts` holds equal to the shared list and to the SQL CHECK.

## How it reaches the database

Through PostgREST (Supabase REST), as the Postgres role `data_api_reader` from
migration 00241. Never a direct Postgres connection, and never the service_role
key. It calls these functions and nothing else:

| Function | Migration | Used for |
|---|---|---|
| `data_api_verify_key` | 00241 | key hash to consumer, key id and scopes |
| `data_api_players` | 00241 | `/v1/players` |
| `data_api_player_by_ref` | 00241 | `/v1/players/:ref` |
| `data_api_active_season` | 00265 | the `season` block of `/v1/players` |
| `data_api_player_published` | 00265 | the 404 check on every `/v1/players/:ref/...` route |
| `data_api_matches` | 00265 | `/v1/matches`, `/v1/players/:ref/matches`, `recent` in vs |
| `data_api_match_by_ref` | 00265 | `/v1/matches/:match_ref` |
| `data_api_head_to_head` | 00265 | `/v1/players/:ref/vs/:other_ref` |
| `data_api_player_seasons` | 00265 | `/v1/players/:ref/seasons` |
| `data_api_rating_history` | 00265 | `/v1/players/:ref/ratings` |
| `data_api_seasons` | 00265 | `/v1/seasons`, `/v1/seasons/:id` |
| `data_api_season_standings` | 00265 | `/v1/seasons/:id/standings` |
| `data_api_season_header` | 00267 | the standings 404 check, without the totals scan |
| `data_api_tournaments` | 00266 | `/v1/tournaments`, `/v1/tournaments/:id` |
| `data_api_tournament_events` | 00266, 00270 | tournament detail, and the event route's ownership check |
| `data_api_tournament_entrants` | 00266, 00270 | tournament detail |
| `data_api_tournament_draw` | 00266, 00270 | `/v1/tournaments/:id/events/:event_id` |
| `data_api_sessions` | 00266 | `/v1/sessions` |
| `data_api_club_events` | 00266 | `/v1/events` |
| `data_api_write_predictions` | 00282 | `POST /v1/predictions` |
| `data_api_delete_predictions` | 00282 | `DELETE /v1/predictions` |

Every match-reading function goes through ONE internal gate,
`data_api_match_rows()`, which unions club and tournament matches and keeps a
match only when it is final, in a visible season, and every player in it is
published. The gate and the other `data_api_*` helpers have no grant at all:
the reader role cannot call them directly. Two predicates exist on purpose: the
roster test from 00241 (adds active and not suspended) for the roster and
standings, and the published test for history. API.md, "Who is in the feed",
explains why.

The presented key is hashed here (sha256 hex of the whole `sfubad_...` string,
the same digest the console stores when it mints) and only the hash is sent.

### Environment

Names only. Values live in the deployment's secret store, never in the repo.

| Variable | For |
|---|---|
| `SUPABASE_URL` | Kong's base URL, e.g. `http://127.0.0.1:54321` locally |
| `SUPABASE_ANON_KEY` | sent as the `apikey` header Kong requires |
| `DATA_API_DB_JWT` | a long-lived JWT with `role: data_api_reader`, sent as `Authorization: Bearer` |
| `PORT` | optional, default `8080` |

The service refuses to start if any of the first three is missing, or if
`DATA_API_DB_JWT` does not decode to `role: data_api_reader`. That second check
is what stops the service_role key (or the anon key) being pasted in by mistake.
The service is never given the JWT secret, so it cannot mint a token for any
other role.

## Run it

```sh
npm run build -w data-api   # tsc to dist/
npm run start -w data-api   # node dist/index.js, listens on $PORT (default 8080)
npm run test -w data-api    # vitest
```

### Against the local Supabase stack

Kong is at `http://127.0.0.1:54321`. The local CLI's JWT secret is the public
demo constant `super-secret-jwt-token-with-at-least-32-characters-long`.

The local database needs migration 00241 applied, or every authenticated
request answers `503` (PostgREST reports the functions as missing). Check with:

```sh
docker exec supabase_db_cli psql -U postgres -c '\df public.data_api_*'
```

Then, with the two keys minted by the recipe below and kept in a gitignored
file (for example `apps/data-api/.env.local`, which `.gitignore` covers):

```sh
set -a; . apps/data-api/.env.local; set +a
npm run build -w data-api && PORT=8080 node apps/data-api/dist/index.js
curl -s localhost:8080/health
curl -s -H "Authorization: Bearer $TEST_KEY" localhost:8080/v1/players
```

A test key is minted the way the console mints one: generate `sfubad_` plus 43
base64url characters of 32 random bytes, and store only its sha256 hex. Use the
`/accounts` panel of the local console, or insert the rows by hand as postgres.

## Minting `DATA_API_DB_JWT`

A credential, minted once per environment: each environment has its own JWT
secret, so a token minted for one does not work on another. Sign HS256 with the project's JWT secret used as a
raw string (not base64-decoded). Put the secret in `JWT_SECRET` in your own
shell first; the recipe reads it from there and prints only the token:

```sh
node -e 'const c=require("crypto");const b=o=>Buffer.from(JSON.stringify(o)).toString("base64url");const now=Math.floor(Date.now()/1e3);const h=b({alg:"HS256",typ:"JWT"}),p=b({role:"data_api_reader",iss:"supabase",iat:now,exp:now+365*86400});process.stdout.write(h+"."+p+"."+c.createHmac("sha256",process.env.JWT_SECRET).update(h+"."+p).digest("base64url")+"\n")'
```

The example expiry is one year. When it lapses every request answers `503`
(PostgREST rejects the token), so diarise the renewal. Rotating the project's JWT
secret invalidates this token along with every other.

## Behaviour worth knowing

- **Verification cache.** Positive results are cached 30 seconds per key hash
  (API.md: a revoked key stops working within 30 seconds), negative results 5
  seconds, at most 1000 entries. Upstream failures are never cached.
- **Read cache.** Every read RPC is cached 15 seconds by function name and
  exact arguments, at most 1000 entries (`src/rpc-cache.ts`). Identical calls
  in flight share one database call, so a burst of the same request costs one
  scan of the match history rather than one each. The consumer id is always an
  argument, so one consumer never receives another's refs. Failures are
  dropped as they settle. Key verification is not routed through it.
- **Rate limits are per process.** 60 requests a minute per key, and 30 failed
  lookups a minute per client address. The edge proxy is the primary limiter;
  replicas each get their own budget.
- **Logs** are one JSON line per request: method, route template (refs and ids
  appear as `:ref`, `:match_ref`, `:id` and so on, unmatched paths are
  `(unmatched)`), status, ms, and the first eight characters of the key's row
  id once verified. No query string, no key, no credential, no upstream body.
- **Upstream failure** of any kind (non-2xx, timeout, schema cache miss) is
  `503 {"error":"unavailable"}`, never a pass-through. The one exception is the
  `season` block of `/v1/players`: if `data_api_active_season` fails, the
  roster is still served with `season: null` and a `season_unavailable` warn
  line is logged.
- **Paging** asks the database for `limit + 1` rows and sets `next_offset` only
  when the extra row came back, so there is never a count query.
- **Check order** is route, method, key, rate, scope, query parameters (400),
  path format (404), then for a write the body (415, 413, 400), database. A
  malformed ref or id never reaches the database.
- **Writes** (`/v1/predictions`, scope `predictions:write`) bypass the read
  cache and send the key HASH, not the consumer id: the write and delete
  functions re-check the key, its scope, revocation and expiry themselves,
  because the verification cache may be up to 30 seconds stale. A `key`
  refusal from the database is answered `401`. A batch is one request against
  the rate limit.

## Known gaps

- **By-ref lookups rehash the published roster.** `data_api_resolve_ref`
  computes every published member's ref for the consumer and compares, because a
  salted hash cannot be inverted. Linear in membership, fine at club scale; a
  per-consumer ref table would be the fix if it ever is not.
- **Derived figures do not reconcile with the lifetime counters.** Documented in
  API.md, "Reconciliation". Not a bug: the gate drops whole matches.
- **No tombstones.** A match that stops being published (a player opts out, a
  season is hidden) disappears rather than coming back through
  `updated_since`. Consumers are told to rebuild periodically.
- **Offset paging is not stable** under concurrent writes. `updated_since` is
  the sync path.
- **Rating history omits manual adjustments.** Only rated matches and
  tournament placement bonuses are journalled, so rows need not chain.
- **Tournament `updated_at` is derived** (the later of `updated_at` or
  `created_at`, and `result_entered_at`), because `tournament_matches` has no
  update trigger.
- **`player_ref` is a 64-character hex digest**, exactly what
  `data_api_player_ref` returns. The contract calls the value opaque, so it is
  passed through unchanged.
