# `@badminton/shared`

Everything both apps (and, over HTTP, the bot) have to agree on: the **ELO
engine**, the **database types**, the **Zod validators**, the **email and push
senders**, and a large pile of pure rule modules under `utils/`.

This package is consumed **as TypeScript source** — `main` and `types` both point
at `src/index.ts`, and the apps list it in `transpilePackages`. There is no build
step and no `dist/`.

```sh
npm run test -w @badminton/shared        # vitest — 73 test files
npm run type-check -w @badminton/shared
```

---

## Layout

```
src/
  index.ts        The barrel. Read the comments in it before adding an export.
  elo/engine.ts   The rating engine.
  types/          database.ts (hand-written) + database.gen.ts (generated).
  validators/     Zod schemas + parse helpers.
  email/          Templates, sender, unsubscribe tokens.
  push/           Web Push send + VAPID. NOT in the barrel — see below.
  utils/          ~50 single-purpose rule modules: seasons, fees, standings,
                  tournament windows and entry caps, capability gates,
                  member identity, match results, QR/link tokens, …
```

`utils/` is where most of the club's actual rules live, one concern per file,
all pure. That is why the package carries 73 test files and the apps' route
handlers carry almost none.

## The barrel has rules

`src/index.ts` is imported by client bundles, so **anything Node-only must stay
out of it**:

- **`push/send` is deliberately not exported.** `web-push` pulls in `net`/`tls`
  and would break any client bundle importing the barrel. Server code deep-imports
  it: `@badminton/shared/src/push/send`.
- **`utils/event-waiver` is out for the same reason** (it hashes, so it needs
  `node:crypto`). Its sibling `utils/event-waiver-eligibility`, which computes no
  hashes, is in.

There is a second reason to deep-import: **bundle weight on hot paths.** The
player app's middleware runs on every request and imports
`@badminton/shared/src/utils/constants` directly — going through the barrel there
took the middleware bundle from 208 kB to 371 kB.

## The ELO engine

`elo/engine.ts`. A rating change is

```
k × formatWeight × eventMultiplier × marginMultiplier
```

and those factors **compound** — they are not alternatives, and there is no
clamp that rescues a bad combination. A single game to 11 lands at **0.52**, not
at the 0.25 floor people assume from the format weight alone.

`ELO_SCALE` is **800**, not the classic 400. The ladder's spread is deliberately
stretched 2x: nominal rating 400, practical ceiling around 1300, and a gap of one
full scale means the stronger player wins ~91% of the time. Any intuition
imported from a standard ELO implementation will be wrong by a factor of two
here.

Configured bounds come from the database and override the defaults;
`elo_multiplier` is `DECIMAL(4,2)` with **no CHECK constraint**, so a nonsense
value entered in the console is stored happily and shows up as absurd rating
deltas.

## Database types

`types/database.gen.ts` is **generated** from the live schema —
`scripts/gen-db-types.mjs`. Regenerate it after every schema migration and *read
the diff*.

It has drifted before: at one point it was six tables and fourteen functions
behind, which hid a column that had been dropped forty migrations earlier and
quietly made a guard test vacuous. A stale generated type does not fail loudly;
it fails by agreeing with you.

`types/database.ts` is the hand-written layer on top (aliases, narrowed unions,
domain names) and is the one you should normally import from.
