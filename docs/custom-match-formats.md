# Custom match formats — design notes

**Goal:** let people set up a game as "X games to Y points" instead of picking
from the four fixed formats.

Today `match_format` is a Postgres enum with exactly four members:

| format | games | points | Elo weight |
|---|---|---|---|
| `bo3_21` | best of 3 | 21 | **1.25** |
| `single_21` | 1 | 21 | **1.00** |
| `single_15` | 1 | 15 | **0.75** |
| `single_11` | 1 | 11 | **0.50** |

## The hard part: Elo weight

Everything else is mechanical. The real question is **how much a custom format
should move ratings**, because right now the weight is a hand-picked lookup and
an arbitrary (games, points) pair has no entry.

A format that counts for more rating movement is worth more to win, so this
isn't cosmetic: if a custom "1 game to 5 points" carried the same weight as a
best-of-3 to 21, players could farm rating from trivial games.

Two options:

**A. Derive a weight from (games, points).** Needs a formula that roughly
reproduces the existing four so ratings stay comparable across old and new
matches. Fitting the table above, points scale close to linearly and multi-game
adds ~25%:

```
weight = (points / 21) * (isMultiGame ? 1.25 : 1.0)
```
Reproduces `bo3_21`=1.25 and `single_21`=1.00 exactly; gives 0.71 vs 0.75 for
`single_15` and 0.52 vs 0.50 for `single_11` — close enough that existing
matches don't need recomputing. Clamp to something like [0.25, 1.5] so nobody
invents a 99-point format worth triple.

**B. Keep custom formats unrated.** Custom = casual, `rated_flag = false`, no
Elo at all. Zero risk of weight abuse, much less work, but the feature is then
only useful for organising a game, not for the ladder.

**Recommendation: A, with the weight capped, plus admin-configurable bounds**
(min/max points, max games) in `platform_settings` next to the other rating
knobs — the same pattern as `sweep_margin_multiplier`.

## Schema

Don't add enum members — that's unbounded. Instead:

- add `games_per_match SMALLINT` and `points_per_game SMALLINT` to `challenges`
  and `matches`
- keep `match_format` for the four presets (back-compat; every existing row and
  all tournament code keeps working)
- treat the new columns as authoritative when present, falling back to the enum

`get_format_weight()` and `getFormatWeight()` become "if custom columns present,
compute; else use the lookup".

## Knock-on effects

- **Score validation.** `matchGameSchema` hardcodes `max(30)` — correct for
  21-point games with the deuce cap, wrong for an 11-point game. The cap needs
  to derive from `points_per_game` (e.g. `points + 9`, mirroring 21→30), and
  `submit_match_result` should enforce it server-side. Note the RPC currently
  does **no** score validation at all — it trusts the Zod layer — so this is a
  good moment to close that.
- **Winner derivation.** Already generic (compares per-game scores, counts game
  wins), so it needs no change.
- **`getMaxGamesForFormat`** must read `games_per_match`.
- **Sweep bonus.** `getMarginMultiplier` keys off "loser won zero games", which
  generalises to any game count already — no change needed.
- **Tournaments** use a separate `tournament_match_format` enum; leave alone
  unless custom formats should apply there too.

## Open question for the club

Should a custom format be **rated by default**, or opt-in? Rated custom formats
are the useful version but carry the weight-abuse risk above; unrated is safe
but limited.
