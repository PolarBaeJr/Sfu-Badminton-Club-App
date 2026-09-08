# `@badminton/config`

Shared configuration for the workspace. Currently one file: a partial Tailwind
theme (`tailwind.config.ts`) declaring the three font families the design uses —
Barlow Condensed for display, DM Sans for body, JetBrains Mono for mono.

```
packages/config/
  package.json         name only — no scripts, no dependencies
  tailwind.config.ts   Partial<Config>: theme.extend.fontFamily
```

## Status: not currently imported

Nothing in the repo imports `@badminton/config` today. Each app carries its own
complete `tailwind.config.ts` — including its own font families — and neither
one spreads this partial in.

It is still a workspace member, so `npm install` links it and the name resolves.
Treat it as a **placeholder for config the two apps should stop duplicating**,
not as something already load-bearing:

- fonts are duplicated in `apps/player/tailwind.config.ts` and
  `apps/admin/tailwind.config.ts`
- so is the zeroed `borderRadius` scale, and much of the colour palette

Merging those into this package is a reasonable cleanup, but it is a real change
with a real blast radius (every class in both apps and in `packages/ui` resolves
through those configs), not a tidy-up. Until someone does it deliberately,
**edit the app configs** — editing this file changes nothing.
