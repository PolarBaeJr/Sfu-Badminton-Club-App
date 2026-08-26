# Rate limits

Rate limiting for this app happens **at the edge, in the proxy**, not in the
Next.js processes. This document is the only place in the repo that records the
numbers, because the configuration itself lives on the Pi.

## Where the configuration actually is

`/home/polarbaejr/stack/cmd/proxy/routes.json` on the Pi (bind-mounted into the
proxy container at `/etc/proxy/routes.json`). It is **not** in this repo and it
is **not** in any compose file. Editing it requires ssh.

After editing it:

```sh
ssh pi 'curl -s -X POST http://127.0.0.1:8094/refresh'
ssh pi 'docker logs --since 60s proxy | tail -5'     # expect "loaded N route(s)"
```

## The limits

All on host `sfubadminton.com`, keyed per client IP (full address for IPv4,
/64 prefix for IPv6).

| path | rpm | covers |
| --- | --- | --- |
| `/api/passkey` | 240 | player passkey register + login, options and verify |
| `/auth/callback` | 120 | player Supabase auth callback |
| `/api/calendar` | 120 | ICS feed, incl. token enumeration |
| `/api/discord` | 600 | every `/api/discord/*` service route |
| `/unsubscribe` | 120 | email unsubscribe |
| `/link` | 120 | Discord account linking page |
| `/checkin` | 240 | session check-in QR landing page |
| `/admin/api/passkey` | 60 | console passkey routes |
| `/admin/auth/callback` | 60 | console auth callback |

The bot has its own limit via a compose label rather than a routes.json entry
(`proxy.ratelimit` / `proxy.ratelimit.rpm: 300` in `docker-compose.yml`),
because a label limit is per service and the bot is a whole service.

### Why the numbers are large

They are ceilings against floods, not traffic shaping. Two constraints push
them up and neither is negotiable:

- **The club shares NAT.** Everyone on SFU campus wifi leaves through one
  address, and the edge bucket is shared across replicas, so a tight per-IP
  number is a club-wide outage during a signup or check-in rush. It locks out
  real members holding correct credentials; it does not stop an attacker, who
  is not on that NAT.
- **A 429 on an auth path breaks the default way in.** On the passkey options
  routes it breaks the "Sign in with a passkey" button itself.

Measured on production before these were set: a real residential member peaked
at **114 requests/min**, and a scanner sat at **1712/min**. Those populations
overlap enough that no single rpm cleanly separates them — which is why these
numbers are set to stop only the obviously-pathological end.

## Why there is (almost) no in-app limiting

There used to be ~43 `rateLimit()` call sites backed by
`packages/shared/src/utils/rate-limit.ts`. That limiter is a module-scope `Map`,
so it is **per Node process**. Production ran two player replicas when this was
measured and runs **five across two hosts** as of 2026-08-26 — the multiplier is
not a constant, and nothing ties it to the numbers written in code. So every
number written against it was enforced at roughly double. Measured, not assumed:
an 80-request burst against a limit written as 30 returned 60 × 404 and
20 × 429.

Doubling is fine for anti-spam and is not fine for an auth gate, so the IP-keyed
call sites were removed in favour of the edge limits above.

**One caller survives**: `/api/discord/feedback`, which keys on the reporting
Discord user rather than an IP. Every request to it comes from the single bot
process, so an IP-keyed edge limit would be one bucket for the whole club and
the first member to file a few reports would silence everybody else. There is no
way to say "per Discord user" at the edge. The doubling is harmless there — it
is volume control on a feature that writes a row, not a gate on anything
privileged.

A database-backed shared limiter was built and **rejected by the owner on
2026-08-24**. Do not re-propose it.

## Gotchas

- **A bad rpm fails open, silently.** A non-numeric or `<= 0` `ratelimit_rpm` is
  logged and then *ignored*; the route keeps serving, unthrottled. Nothing in
  the UI says so. Always verify after editing:

  ```sh
  ssh pi 'curl -s http://127.0.0.1:8094/ratelimit | python3 -m json.tool'
  ```

  `mcp__dashboard__list_routes` does **not** show limiter state.

- **A new group starts empty and fills at `rpm/60`.** Burst-testing a limit
  within the first minute of a reload will show far fewer requests getting
  through than the capacity suggests. That is warm-up, not a misconfiguration.

- **The label form is per service, not per route.** The proxy keys a group on
  `proxy.host + "|" + proxy.path`, so `proxy.ratelimit` on the player app —
  whose `proxy.path` is `/` — would meter the entire site against one bucket.
  Per-path limits therefore have to be hand-written routes.json entries.

- **Those entries set `service` and leave `backends` empty.** The proxy backfills
  backends by service name, so the entry follows containers across deploys
  instead of pinning a dead container. Getting `health` wrong takes that one
  path to 503; it must match the app (`/api/health/ready` for the player,
  `/admin/api/health/ready` for the console).

- **The dashboard rewrites routes.json** whenever an onboarded service changes,
  but it only matches entries carrying its own markers, so these hand-curated
  entries survive. Still worth re-checking `/ratelimit` after any onboarding
  change.

- **The limiter fails OPEN.** If Redis is unreachable past the failure
  threshold, the proxy falls back to a local in-memory bucket rather than
  refusing traffic. This is deliberate and is load-bearing for the bot, which
  must answer Discord within 3 seconds.

- **There is no staging equivalent.** `badminton.polardev.org` has no rate-limit
  entries at all, so a burst test there proves nothing about production.

## Spreading badminton-player across the mesh

CONFIRMED LIVE 2026-08-26, not a prediction: the Mac mini is running three
badminton-player replicas, its own routes.json has ZERO sfubadminton.com
entries, and its proxy nonetheless reports all nine limited paths at the right
rpm -- which is exactly the learned-only shape described below.

Every entry in the table above is a *static* routes.json entry that backfills its
backends from a `service` label. That backfill reads `dc.listEnabledContainers`
-- the **local** Docker socket only (`cmd/proxy/router.go`, `backendsByService`).
It does not see another host's containers. That has three consequences the moment
a second host starts running badminton-player, and none of them are visible from
`list_routes` on the origin.

**The limited paths do not spread.** The peer builds exactly one group from
labels, `sfubadminton.com|/`, because `proxy.path` is the only path a label can
express. It has no routes.json entry for `/api/passkey` or any of the others, so
it learns those groups from this host's advertisement instead -- and a learned
group's only backend is a peer backend pointing back here. Longest-prefix wins,
so a request that lands on the peer for a limited path hairpins to this host even
though the peer has healthy local replicas one group over. Login, the check-in
QR, and the whole bot API keep running entirely on the origin.

**There is no failover on those paths either.** If this host's containers die,
the peer's learned group holds one dead peer backend and does not fall back to
its own replicas, because those live in the `/` group, not this one. Spreading
therefore buys redundancy for everything *except* auth.

**The limits themselves are fine.** `peermerge.go` adopts `RateLimit`/`RateRPM`
when it synthesizes a learned-only group, so the peer charges the shared bucket;
and a request carrying `X-Pmgr-Peer-Hop` skips the limiter on the second hop, so
nothing is charged twice.

THE FIX IS CONFIG, NOT CODE: copy the same entries into the peer's routes.json,
unchanged, and `POST /refresh` there. `service` + `backends: []` then backfills
from *its* local containers, both hosts serve the limited paths locally, both
advertise them, and the peer backend on each becomes real failover.

Note that a static entry can never itself spread: `staticRoute` has no `spread`
field, and peersync advertises `SpreadLocal`, which is false for these. Peer
backends on them stay a failover tier. That is the correct shape here -- it is
why both hosts need their own local backfill rather than one host spreading.
