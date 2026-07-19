# Design reference — "Vercel red" (the canonical design)

Extracted 2026-07-19 from the live https://badminton-admin-red.vercel.app (the
owner-designated reference for the WHOLE UI, both apps). Values read from the
running page's stylesheets and computed styles — not from any repo history.

## Core tokens

| Token | Value | Notes |
|---|---|---|
| `--bg` | `#0a0a0a` | true near-black, neutral (NOT blue slate) |
| `--surface1` | `#111` | cards |
| `--surface2` | `#1a1a1a` | elevated / hover |
| `--surface3` | `#232323` | highest |
| `--ink` | `#f0f0f0` | primary text |
| `--text` | `#c8c8c8` | secondary text |
| `--muted` | `#888` | muted |
| `--dim` / `--faint` / `--ghost` | `#666` / `#444` / `#333` | de-emphasis ramp |
| `--red` | `#c00` | THE accent (pure red) |
| `--red-dark` | `#a30000` | hover |
| `--red-tint` | `rgba(204,0,0,.1)` | washes / glows |
| `--red-border` | `rgba(204,0,0,.3)` | outlined danger boxes |
| `--hairline` | `hsla(0,0%,100%,.08)` | default border |
| `--hairline-soft` | `hsla(0,0%,100%,.06)` | |
| `--hairline-strong` | `hsla(0,0%,100%,.14)` | hover border |
| `--green` | `#4ade80` | success / win |
| `--amber` | `#eab308` (warning `#fbbf24`) | gold/warning |
| `--color-info` | `#4c98b9` | info |
| `--bg-loss` | `rgba(204,0,0,.06)` | loss wash (loss = red) |
| `--on-surface-soft/med/hard` | white-alpha `.04/.08/.14` | |
| `--radius` | **`0`** | sharp corners everywhere |

Aliases observed (same names our repo already uses): `--bg-primary`, `--bg-card`,
`--bg-elevated`, `--bg-surface`, `--text-primary/-secondary/-muted`, `--border`,
`--border-hover`, `--color-accent(-hover/-glow/-deep)`, `--color-danger/success/
warning/gold/info`, shadcn-style `--primary/--secondary/--card/--ring/...`.

## Typography

- `--font-body`: **Barlow** (13px base UI; nav links 13/400)
- `--font-display`: **Barlow Condensed** — h1 52px/700, letter-spacing −0.78px,
  headlines end with a period ("Settings.", "Run your club like a team.")
- `--font-mono`: JetBrains Mono (IDs, numbers)
- Micro-labels & buttons: 11px/700 UPPERCASE, letter-spacing ~1.76px

## Structural signatures

- **Audit Log page** (from owner screenshot): editorial header (red eyebrow =
  the active range, e.g. "LAST 30 DAYS"; "Audit Log." title; muted sub;
  watermark "A"), then a hairline-bounded filter row: sharp outlined chips per
  category with a muted count ("PLAYERS 0"), active chip red-outlined with red
  text ("ALL 0"); far right a muted micro-label "AUTO-REFRESH · 30S".
  Owner also wants **sorting** on this page (see tasks).

- **Top nav** (black): red logo square + "SFU BADMINTON · ADMIN", uppercase nav
  items, active item gets a **red underline**; search/bell/avatar right.
- **Sub-nav row** below it (secondary sections left, season status right:
  "▪ SEASON 02 · SPRING 2026 · LIVE").
- **Editorial page header**: red eyebrow micro-label, huge condensed headline
  with trailing period, 1–2 muted sub lines, giant faint watermark
  glyph/numeral bleeding off the right edge.
- **Stat strip**: full-width row of hairline-separated cells — uppercase micro
  label over a huge condensed numeral.
- **Tables**: uppercase 10–11px letterspaced column headers, hairline row
  dividers, no zebra, no card chrome around them; section headers like
  "PLAYERS / RECENT" with a "VIEW ALL →" link right-aligned.
- **Forms** (settings) — confirmed against the owner's screenshot of the
  ELO & Ranking section; every settings section (incl. our Platform Settings
  and Legal Documents editor) uses exactly this:
  - Section header: bold sentence-case title (~28px, e.g. "ELO & Ranking"),
    then a muted 1–2 line description (may carry a caution note).
  - One row per setting, separated by full-width hairlines: LEFT = uppercase
    letterspaced ~11px label ("STARTING ELO") over a muted ~14px hint
    ("Assigned to all new players on approval."); RIGHT = the control.
  - Inputs: sharp-cornered boxes, `#0a0a0a` fill, hairline border, light text,
    generous padding; width fits the content (small numeric boxes, full-width
    text, side-by-side paired inputs for e.g. K-factor).
  - Toggles: rectangular (sharp), dark track with hairline; ON = red `#c00`
    knob with red-tinted track/border, OFF = gray knob on dark track.
  - Selects/dropdowns: same sharp hairline box as inputs, plain light text
    (e.g. "Best of 3 to 21 · Win by 2"), no visible chevron chrome.
- **Buttons**: primary = solid `#c00`, white uppercase letterspaced text, sharp
  corners; danger-zone actions are red-outlined ghosts in a red-bordered box.
- **Danger Zone**: red-hairline box, red heading, row-per-action layout.
- **Dialogs/modals** (confirmed against the owner's Create Session screenshot —
  the one place rounding survives): dark panel (`#111`-family) with **soft
  rounding (~16px)** and a subtle hairline; sentence-case labels ABOVE inputs
  (not the settings' uppercase-left idiom); inputs are dark filled boxes with
  **~8px rounding** and hairline borders; short fields sit in multi-column rows
  (e.g. Start time / End time / Capacity); primary action = solid red uppercase
  letterspaced SHARP button, secondary = hairline ghost uppercase SHARP button;
  square plain checkboxes with sentence-case inline labels. In dialogs,
  selects DO show a chevron (settings rows don't). Disabled primary buttons
  render dimmed red-less gray.
  **Owner adjustment:** dialog action row is a spread — secondary/Cancel at the
  LEFT edge, primary (e.g. CREATE PLAYER) right-aligned at the far RIGHT edge
  (`justify-between`), not adjacent buttons.
  More dialog anatomy (from the Admin Match Entry screenshot): related fields
  group inside **hairline-bordered inset panels** with an uppercase muted
  micro-label (SIDE A / SIDE B); toggles inside dialogs are **round red pill
  switches** (red track, white round knob) with sentence-case inline labels —
  distinct from the rectangular settings toggles; steppers are square hairline
  −/+ buttons; repeating score rows use a muted row label left ("Game 1") with
  labeled numeric columns (A Score / B Score); textareas are resizable.
  Required fields get a red asterisk after the label.
  **Owner adjustment:** long-content textareas (e.g. announcement body)
  auto-expand with their content (auto-grow, sensible max ~60vh, then the
  dialog scrolls) rather than fixed-height inner scroll.
- Flat design elsewhere: no shadows, no rounded corners outside dialog panels
  and dialog inputs; hierarchy from hairlines, type scale, and the single red
  accent.
