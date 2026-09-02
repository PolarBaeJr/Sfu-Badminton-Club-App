# Why there are .ttf files in here as well as .woff2

The `.woff2` files are what the browser gets, through `next/font/local` — three
per weight (latin / latin-ext / vietnamese), chained by `unicode-range` in
globals.css exactly as Google ships them.

The three `.ttf` files are for the Discord profile card
(`src/app/api/discord/card/[token]`), which `next/og` renders server-side.
**satori, which next/og renders through, cannot read WOFF2 at all** — so the
card needs the same faces in a format it can parse.

They are not a different typeface and not a re-download. Each one is the
existing `.woff2` subsets for that weight, decompressed and **merged into a
single face**, so an accented or Vietnamese name renders as itself instead of
as a tofu box — satori has no `unicode-range`, so the three subsets could not
stay separate.

| File | Merged from |
|---|---|
| `BarlowCondensed-Bold.ttf` | `barlow-condensed-{latin,latin-ext,vietnamese}-700.woff2` |
| `Barlow-Regular.ttf` | `barlow-{latin,latin-ext,vietnamese}-400.woff2` |
| `Barlow-SemiBold.ttf` | `barlow-{latin,latin-ext,vietnamese}-600.woff2` |

Same OFL licence as the source files — see `OFL-Barlow.txt`, which covers these
too. To regenerate after a font update, with `fonttools` and `brotli`:

```python
from fontTools.ttLib import TTFont
from fontTools.merge import Merger

subs = []
for sub in ('latin', 'latin-ext', 'vietnamese'):
    f = TTFont(f'barlow-condensed-{sub}-700.woff2')
    f.flavor = None                      # write plain TTF, not WOFF2
    f.save(t := f'/tmp/{sub}.ttf'); subs.append(t)
Merger().merge(subs).save('BarlowCondensed-Bold.ttf')
```

**They reach the container through `outputFileTracingIncludes` in
`next.config.js`.** Nothing imports them — the route reads them off disk — so
without that entry the route builds clean and 500s on its first real request.
`__tests__/discord-profile-card.test.ts` asserts both the tracing entry and
that these files really are TrueType.
