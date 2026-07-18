# SFU Badminton Club — build conventions

**Setup.** No provider or wrapper is required. Import components from `window.BadmintonUI` (e.g. `const { Button, Card, PageHeader } = window.BadmintonUI`). The stylesheet ships light-theme tokens on `:root`; design on the warm-cream ground it provides (`--bg` #FAF8F5), with SFU crimson as the single accent.

**Styling idiom — important.** Components style themselves; for your own layout glue use **inline styles with the CSS custom properties** and the **app component classes** below. Do NOT write new Tailwind utility classes — the shipped stylesheet contains only the utilities this app compiled, so arbitrary new ones (`p-6`, `text-lg`, …) will silently not resolve. Inline `style={{}}` + `var(--*)` always works.

Tokens (on `:root`): color — `--red` (accent, #CC0633), `--red-ink` (hover), `--bg`, `--surface` (cards), `--surface-2` (elevated), `--ink` (text), `--ink-2` (secondary), `--mute`, `--line` (borders), `--win` (green), `--loss`, `--gold`; aliases `--text-primary/-secondary/-muted`, `--border`, `--color-accent/-success/-warning/-danger`, `--bg-card`, `--bg-elevated`. Fonts — `--display` (Space Grotesk, headings), `--body` (Inter), `--mono` (JetBrains Mono — numbers, ELO, labels). Other — `--elev-1` (card shadow), `--r-lg` (14px radius).

Component classes (from the app's own CSS, safe to use on your elements): layout `card-base`, `card-head`, `card-title`, `feed-col`, `grid-2`, `grid-3`, `hero-banner`; rows `list-row`, `row-title`, `row-sub`; text `display`, `mono`, `muted`, `page-eyebrow`, `page-title`, `page-sub`, `stat-label`, `stat-value`; controls `btn` + `btn-primary|btn-ghost` + `btn-lg`, `input-base`, `search-pill`; status `chip chip-success|chip-red`, `pill`, `tag`, `alert-danger`, `skeleton`; empty states `empty`, `empty-icon`, `empty-title`, `empty-hint`.

**Where the truth lives.** Read `styles.css` (tokens + every class above) before inventing styling, and each component's `<Name>.prompt.md` / `<Name>Props` in `<Name>.d.ts` for its API. Overlay components: `Dialog` needs `open` + `title` + `onClose`; `Toast` fixes itself bottom-right; `Dropdown` menus open on trigger click.

**Idiomatic example** (a page section in this system):

```jsx
const { PageHeader, Card, Button, Badge } = window.BadmintonUI;

<div style={{ maxWidth: 1120, margin: '0 auto', padding: 24 }}>
  <PageHeader
    eyebrow="RANKINGS · LIVE"
    title="Leaderboard"
    sub="Every confirmed match moves your number."
    actions={<Button variant="primary">Issue Challenge</Button>}
  />
  <Card title="Top of the ladder">
    <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="list-row" style={{ justifyContent: 'space-between' }}>
        <div>
          <div className="row-title">Jordan Lee</div>
          <div className="row-sub">14–3 · W5 STREAK</div>
        </div>
        <span className="mono" style={{ fontWeight: 600 }}>1187</span>
      </div>
    </div>
  </Card>
</div>
```

Content register: badminton-club domain (players, ELO 400–1300, match scores like 21-17, seasons, sessions, fees). Numbers and data always in `--mono`.
