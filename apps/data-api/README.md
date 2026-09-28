# `data-api`: the club's external Data API

The service behind [`API.md`](./API.md), which is the contract. Where this code
and that document disagree, the document is the bug report.

A dependency-free Node 24 service: `node:http`, `node:crypto` and the global
`fetch`. `package.json` has no runtime dependencies, only TypeScript, vitest and
`@types/node` for the build and tests.

Consumer-facing documentation is served by the service itself at
`GET /documentations` (for example `https://api.sfubadminton.com/documentations`):
one self-contained HTML page, no key, from `src/docs-page.ts`. A test fails when
a route, scope or error code in `src/server.ts` is missing from it.

## How it reaches the database

Through PostgREST (Supabase REST), as the Postgres role `data_api_reader` from
migration 00241. Never a direct Postgres connection, and never the service_role
key. It calls three functions and nothing else:

| Function | Used for |
|---|---|
| `data_api_verify_key(p_key_hash)` | key hash to consumer, key id and scopes |
| `data_api_players(p_consumer_id)` | `GET /v1/players` |
| `data_api_player_by_ref(p_consumer_id, p_player_ref)` | `GET /v1/players/{player_ref}` |

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

## Minting `DATA_API_DB_JWT` (owner step)

A credential, so it is the owner's to mint, once per environment: staging and
production have DIFFERENT JWT secrets, so a staging token does not work on
production and the reverse. Sign HS256 with the project's JWT secret used as a
raw string (not base64-decoded). Put the secret in `JWT_SECRET` in your own
shell first; the recipe reads it from there and prints only the token:

```sh
node -e 'const c=require("crypto");const b=o=>Buffer.from(JSON.stringify(o)).toString("base64url");const now=Math.floor(Date.now()/1e3);const h=b({alg:"HS256",typ:"JWT"}),p=b({role:"data_api_reader",iss:"supabase",iat:now,exp:now+365*86400});process.stdout.write(h+"."+p+"."+c.createHmac("sha256",process.env.JWT_SECRET).update(h+"."+p).digest("base64url")+"\n")'
```

The example expiry is one year. When it lapses every request answers `503`
(PostgREST rejects the token), so diarise the renewal. Rotating the project's JWT
secret invalidates this token along with every other.

## Staging deploy: owner checklist

Staging runs on the Pi. The dashboard MCP defaults to the Mac, so every
dashboard call below needs `host: dashboard.polardev.org`, and the secrets go in
the Pi's own secrets directory (the two hosts keep different ones).

1. **00241 must be present on staging.** It is currently wiped from staging
   every night until production has it, and without it every authenticated
   request answers `503`.
2. **Merge to `deploy/docker-staging`.** CI builds
   `ghcr.io/polarbaejr/badminton-data-api-staging` (arm64) and moves `:latest`
   together with the other three staging images. Images are built only in CI.
3. **Mint the staging reader JWT** with the recipe above and staging's JWT
   secret. Add it and staging's anon key to the staging host's dashboard secrets
   file as `DATA_API_DB_JWT` and `SUPABASE_ANON_KEY`.
4. **Onboard the service through the proxy dashboard** with env given as
   references, never literals:
   `SUPABASE_URL` (staging's Kong, reachable from the container; staging's
   Kong is on host port `64321`, so `http://host.docker.internal:64321` with a
   host-gateway entry, confirm on the host),
   `SUPABASE_ANON_KEY: ref:SUPABASE_ANON_KEY`,
   `DATA_API_DB_JWT: ref:DATA_API_DB_JWT`, `PORT: 8080`. Labels as in
   [`docker-compose.example.yml`](./docker-compose.example.yml), including
   `proxy.health: /health`. `ref:` is a dashboard feature only: compose does
   not resolve it.
5. **Verify.** `curl https://api.polardev.org/health` answers
   `{"ok":true,"version":...}`; `/v1/players` with no key answers `401`; with a
   key minted in the staging console's `/accounts` panel it answers `200`.
   Read the image revision off the image label
   `org.opencontainers.image.revision`.

## Behaviour worth knowing

- **Verification cache.** Positive results are cached 30 seconds per key hash
  (API.md: a revoked key stops working within 30 seconds), negative results 5
  seconds, at most 1000 entries. Upstream failures are never cached.
- **Rate limits are per process.** 60 requests a minute per key, and 30 failed
  lookups a minute per client address. The edge proxy is the primary limiter;
  replicas each get their own budget.
- **Logs** are one JSON line per request: method, route template (the ref is
  `:ref`, unmatched paths are `(unmatched)`), status, ms, and the first eight
  characters of the key's row id once verified. No query string, no key, no
  credential, no upstream body.
- **Upstream failure** of any kind (non-2xx, timeout, schema cache miss) is
  `503 {"error":"unavailable"}`, never a pass-through.

## Known gaps

- **`season` is always `null`.** The reader role cannot read `seasons`, and none
  of the three functions returns the active season. `get_active_season()` is
  callable (PUBLIC holds EXECUTE on it) but returns neither `start_date` nor
  `hidden_flag`, so using it could publish a hidden season's name, which the
  contract forbids. Closing this needs a migration adding a function such as
  `data_api_active_season()` that returns `name` and `start_date`, or nothing
  for a hidden season, granted to `data_api_reader`.
- **`player_ref` is a 64-character hex digest**, exactly what
  `data_api_player_ref` returns. API.md's example shows a shorter `p_...` form;
  the contract calls the value opaque, so it is passed through unchanged.
- **No ratings-history route.** API.md defines the scope but no path.
