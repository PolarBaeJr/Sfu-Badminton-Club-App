# design-sync notes — @badminton/ui → "SFU Badminton Club" (claude.ai/design)

## Repo gotchas
- **No build script** in `packages/ui` (`main` points at `src/index.ts`) — the
  converter runs in synth-entry mode from `src/`. Fine at this size (23 components).
- **Package resolution goes through `node_modules/@badminton/ui`** (workspace
  symlink), so package-relative config paths resolve from there. The CSS snapshot
  must live INSIDE the package: `packages/ui/.ds-styles.css` (gitignored),
  `cssEntry: ".ds-styles.css"`.
- **CSS comes from the player app's compiled build**, not the package. Regenerate
  with `node .design-sync/gen-styles.mjs` AFTER `turbo run build --filter=player`.
  It: picks the largest `.next/static/css/*.css`, prepends a Google Fonts @import
  (next/font uses hashed family names; previews need the real names — validate
  prints the expected `[FONT_REMOTE]`), maps `--font-sans/display/mono` to real
  names, and **mirrors the `[data-theme="light"]` token block onto `:root`** —
  preview pages have no `data-theme` attribute, and without this every `var(--*)`
  resolves to nothing (invisible primary buttons; the first-run failure mode).
- Tailwind content globs cover `packages/ui/src/**` from apps/player, so ui-package
  utility classes are present in the snapshot.

## Preview recipes that work here
- **Dialog** (`fixed inset-0`): wrap in a transformed stage —
  `<div style={{position:'relative', height:520, transform:'translateZ(0)', overflow:'hidden'}}>`
  — a transform makes the wrapper the containing block for fixed descendants, so
  the modal centers inside the card. Config: `overrides.Dialog = {cardMode:'single', viewport:'680x760'}`.
- **Toast** (plain fixed, not portal'd): same stage trick, per-variant (~150px stages).
- **Dropdown** (portal'd to document.body, click-to-open, uncontrolled): stage trick
  does NOT apply. Auto-open in a mount effect:
  `ref.current.querySelector('.cursor-pointer').click()` — `el.click()` fires only
  `click`, not `mousedown`, so the outside-mousedown closer doesn't fire.
- Avatar needs real `name`/`src` props (data-URI SVG works for the photo state).

## Component bugs found by the sync (fixed in source 2026-07-18)
- **Toast `type="info"`** was white-on-white (`bg-[var(--bg-surface)]` + shared
  `text-white`). Fixed: per-variant text colors; info uses elevated surface + border.
- **Badge default/success/warning/danger** had no pill background: Tailwind v3
  silently drops `/20` opacity modifiers on `var()` arbitrary colors. Fixed with
  `bg-[color-mix(in_oklab,var(--x)_20%,transparent)]`.
- Observation (not fixed): Tabs active label `text-[var(--text-primary)]` on the
  red accent track is low-contrast — candidate for a future polish pass.

## Known render warns (triaged as legitimate)
- `Spinner` — [RENDER_THIN]: it's a tiny spinner glyph; genuinely thin. Floor card by scope.
- `RouteLoading` — [RENDER_BLANK]-ish: skeleton shimmer has very low ink. Floor card by scope.
- These two + `RouteError` were deliberately left unauthored (trivial components).

## Dark-first design (2026-07-19, black/red remap)
- The app is dark-by-default (true black #0a0a0a + #C00 red, Barlow fonts —
  see docs/design-reference.md). `gen-styles.mjs` now mirrors the
  `[data-theme="dark"]` blocks to `:root` (was light) AND appends
  `html body{background:var(--bg);color:var(--ink)}` — preview cards inline
  `body{background:#fff}` AFTER linking styles.css, so the dark ground must
  win by specificity. Without that rule, dark ink renders on white
  (invisible PageHeader — the failure mode that prompted it).
- Fonts changed to Barlow/Barlow Condensed — the Google Fonts @import in
  gen-styles.mjs must list THOSE families after the next re-sync
  regeneration (check it matches apps/player layout.tsx next/font families).
- conventions.md palette claims were updated for slate once and black/red is
  NEWER still — re-validate its color values against the fresh build on the
  next sync (token names are stable; values moved twice in one day).

## Re-sync risks
- `app-styles.css`/`packages/ui/.ds-styles.css` snapshot goes stale whenever
  `apps/player/src/app/globals.css`, tailwind config, or ui-package classes change —
  regenerate via `gen-styles.mjs` (needs a fresh player build first).
- The Google Fonts remote @import must stay reachable at render time.
- Previews compose against current component APIs; app polish passes that change
  packages/ui sources re-style cards automatically on rebuild, but API changes need
  preview updates.
- Grades live in gitignored `.cache/` — cross-machine carry-forward comes from the
  uploaded `_ds_sync.json` anchor, not git.
