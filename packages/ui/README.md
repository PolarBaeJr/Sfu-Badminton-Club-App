# `@badminton/ui`

The component library both apps share: 31 components plus a few React-free
helpers. Consumed **as TypeScript source** (`main`/`types` point at
`src/index.ts`, and both apps list the package in `transpilePackages`), so there
is no build step and no `dist/`.

```sh
npm run type-check -w @badminton/ui
```

There is no test script here. The testable parts were deliberately extracted
into React-free modules (`player-search.ts`, `player-selection.ts`,
`multi-select.ts`) and are covered from the admin app's
`src/lib/__tests__/`.

---

## What's in it

```
src/
  components/     Button, Card, Dialog, DataTable, ResponsiveTable, Select,
                  Input, Textarea, Switch, Tabs, Toast, Badge, StatCard,
                  PlayerPicker, MultiSelect, DatePicker, EmptyState,
                  PageHeader, LegalMarkdown, RouteError, RouteLoading,
                  StaleBuildBanner, ...
  player-search.ts      Pure matching/filtering, lifted out of PlayerPicker.
  player-selection.ts   Pure selection-state helpers.
  multi-select.ts       Pure option matching and toggling for MultiSelect.
  use-live-channel.ts   The one Supabase Realtime subscription hook.
  utils.ts              cn() — clsx + tailwind-merge.
```

Everything is re-exported from `src/index.ts`, so callers import from
`@badminton/ui` and never from a path inside it.

## React must stay a peer dependency

`react` and `react-dom` are declared **`peerDependencies`** here, and the root
`package.json` `overrides` force a single copy across the whole workspace.

Adding `react` to this package's `dependencies` reintroduces a second copy in
the tree, and two Reacts in one tree produce **error #31 at runtime** — not at
install, not at build. Don't.

`@sentry/nextjs` is a peer for the same reason (the apps own the instance);
it's in `devDependencies` only so this package type-checks on its own.

## Why `useLiveChannel` lives here

A Supabase Realtime channel reports its own death **only** through the
`.subscribe()` status callback, and Postgres CDC never replays what a dead
channel missed. Eight live surfaces across the two apps all need identical
handling of that. The two apps don't share a `lib/`, so this package is the only
place one copy can live — the recovery logic itself is in
`@badminton/shared/src/utils/realtime-recovery`.

Note that it **deep-imports** that module rather than going through the
`@badminton/shared` barrel: the barrel re-exports `email/sender`, which pulls in
`resend`, and this is a `'use client'` module, so everything it touches becomes a
candidate for both browser bundles. Same rule applies to any new client
component here.

## Styling conventions

Tailwind. The apps own their `tailwind.config.ts` and scan
`packages/ui/src/**` for classes — a class that only ever appears in a runtime
string here will be purged.

Two things worth knowing:

**The two app configs carry the same `borderRadius` scale on purpose.** A
component here is compiled by whichever app renders it, so if the scales drifted
the same component would round differently in each app. The scale was once
zeroed for a sharp-cornered design and now carries real values again (`md` is
8px, `xl` is 16px), which is why some components still spell a corner as a
literal such as `rounded-[16px]`. `rounded-none` is the way to keep a corner
square.

**Opacity shorthand on a CSS variable compiles to nothing.** Tailwind's
`bg-[var(--x)]/20` cannot compute an alpha for a value it can't parse, and it
emits no rule at all rather than erroring. Use `color-mix()` in the arbitrary
value instead — see `Badge.tsx`:

```
bg-[color-mix(in_oklab,var(--color-accent)_20%,transparent)]
```
