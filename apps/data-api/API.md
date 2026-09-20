# SFU Badminton Data API

**Status: DRAFT CONTRACT, version 0. Nothing is live yet.**

This file is the contract. It was written before the service, deliberately, so
that the field names, the scopes and the error shapes were settled while they
were still free to change. The implementation follows this document; where they
disagree, this document is the bug report.

Base URL, once live:

| Environment | Host |
|---|---|
| Production | `https://api.sfubadminton.com` |
| Staging | `https://api.polardev.org` |

---

## What this API is for

Predicting the outcome of a challenge between two club members. That is the only
use case it was designed around, and the shape reflects it.

### What it deliberately does not carry

No names, emails, Discord handles, phone numbers, avatars, student numbers or
member codes. Not by omission: the feed reads from a purpose-built view that
cannot join to those columns at all.

---

## Player identifiers are pseudonyms, not database ids

Every player is identified by a `player_ref`: a salted hash of their internal id,
stable forever, unique per consumer.

**This is not decoration.** The club's own member-facing site has a page at
`/leaderboard/<player-id>` that renders a member's real name, photo and a
challenge QR code. Handing out raw internal ids would mean handing out a lookup
key into that page. The salt stays on the club's side, so:

- The same player is the same `player_ref` across every row and every request,
  which is all a model needs.
- Two different consumers see different `player_ref` values for the same person,
  so datasets from separate keys cannot be cross-joined.
- Nobody outside the club can turn a `player_ref` back into a person.

Treat `player_ref` as an opaque string. Do not parse it.

---

## Authentication

Every endpoint except `/health` requires a key:

```
Authorization: Bearer <your key>
```

Keys are issued by a club admin, shown exactly once at creation, and stored
hashed. **Nobody can recover your key for you, not even the club.** If you lose
it, it gets revoked and you get a new one.

### Scopes

A key carries only the scopes it was granted. A key is not allowed everything by
default; it is allowed nothing by default.

| Scope | Grants |
|---|---|
| `players:read` | player refs, ratings and aggregate counts |
| `matches:read` | individual match results, once they exist |
| `ratings:history:read` | rating movement over time, once recorded |

For win-rate prediction you want `players:read` today, and `matches:read` as
match data accumulates.

### Revocation

A revoked key stops working within 30 seconds. Verification results are cached
briefly so that a busy consumer does not cause a database read per request.

---

## Endpoints

### `GET /health`

Unauthenticated. For uptime checks.

```json
{ "ok": true, "version": "0.1.0" }
```

### `GET /v1/players`

Requires `players:read`.

Every member with a rating, one object each.

```json
{
  "season": { "name": "Fall 2026", "started_on": "2026-09-01" },
  "generated_at": "2026-09-19T22:14:03Z",
  "count": 39,
  "players": [
    {
      "player_ref": "p_8f14e45fceea167a",
      "singles_elo": 1180,
      "doubles_elo": 1042,
      "singles_provisional": false,
      "doubles_provisional": true,
      "singles_matches_played": 0,
      "doubles_matches_played": 0,
      "singles_wins": 0,
      "singles_losses": 0,
      "doubles_wins": 0,
      "doubles_losses": 0,
      "updated_at": "2026-09-14T04:11:55Z"
    }
  ]
}
```

### `GET /v1/players/{player_ref}`

Requires `players:read`. One player, same object shape. `404` if unknown.

### `GET /v1/matches`

Requires `matches:read`. **Returns an empty list today. See the honesty note.**

---

## Field meanings, and the traps in them

| Field | Meaning |
|---|---|
| `player_ref` | opaque pseudonym, stable, per-consumer |
| `singles_elo` / `doubles_elo` | current rating, separate ladders |
| `*_provisional` | `true` while the rating is still settling. A provisional rating is a guess, not a measurement. Weight it accordingly or exclude it. |
| `*_matches_played` | rated matches only |
| `*_wins` / `*_losses` | rated matches only |
| `updated_at` | when the rating row last changed |

**Elo here is not earned from play.** New members are assigned a starting rating
by skill tier at signup. A 1200 and a 400 have not necessarily played anybody.
Ratings currently span 400 to 1423 across 39 members, and almost all of that
spread is assignment rather than results.

**Singles and doubles are separate ladders.** Do not average them, and do not
use one to predict the other.

**Wins plus losses does not always equal matches played.** Walkovers and
forfeits are counted differently. Derive win rate from `wins` and `losses`, not
by subtracting.

---

## The honesty note, read this before modelling

At the time of writing, the club database holds **three matches, none of them
rated**, and all three belong to a test season that has since been retired. The
current season has **zero** matches.

Concretely, for anyone building a predictor:

- Every `*_wins`, `*_losses` and `*_matches_played` field is `0`. They are
  correct, not broken. There is simply nothing to count yet.
- `GET /v1/matches` returns an empty list.
- **There is no historical training data.** A model cannot be fitted on club
  results today.

What does exist is ratings across 39 members. The standard starting point for
"who wins when A challenges B" is the rating difference, which needs no history:

```
P(A beats B) = 1 / (1 + 10 ** ((elo_B - elo_A) / 400))
```

That is a reasonable baseline now, and it becomes calibratable against real
outcomes once matches accumulate. Treat anything fancier as unvalidated until
there is something to validate against.

One further limit worth knowing: the club does **not** journal rating changes
per match, so Elo-at-the-time-of-a-match cannot be reconstructed for past
matches. If a model wants that feature, it has to be captured going forward.

---

## Errors

| Status | Meaning |
|---|---|
| `401` | missing, malformed, unknown, expired or revoked key. Deliberately identical in all five cases. |
| `403` | valid key, but it lacks the scope for this endpoint |
| `404` | unknown player ref, or no such route |
| `429` | rate limited |

```json
{ "error": "forbidden", "detail": "this key does not carry players:read" }
```

---

## Rate limits and etiquette

A per-key limit applies; `429` means slow down. The dataset changes slowly, so
polling every few minutes buys nothing. Pull `/v1/players` on a schedule
measured in hours and cache it.

---

## Versioning

The `/v1` prefix is the contract. Within it, **new fields may be added** and
existing fields will not be removed or change meaning. Parse defensively and
ignore fields you do not recognise. A breaking change becomes `/v2`.

---

## Data handling expectations

This is real data about real people, shared under a named key that identifies
who received it.

- Do not attempt to re-identify players.
- Do not redistribute the data or publish it as a dataset.
- Keep the key out of version control.
- Tell the club if the key leaks, and it will be revoked and reissued.
