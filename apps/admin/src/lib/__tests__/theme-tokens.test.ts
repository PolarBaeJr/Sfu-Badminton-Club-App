import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// EVERY --bg-*/--text-*/--border* TOKEN THE ADMIN CONSOLE PAINTS WITH MUST BE
// ONE globals.css ACTUALLY DECLARES.
//
// The defect this exists for is silent by construction. `bg-[var(--bg-secondary)]`
// is valid Tailwind and valid CSS: it compiles to
// `background-color: var(--bg-secondary)`, the browser cannot resolve the
// property, and it drops the declaration. No build error, no console warning,
// no failing test — just no background. It shipped on the bulk SELECTION BAR,
// where it meant the rows underneath read straight through the "12 sessions
// selected" count, and on the fees and tournaments LOADING skeletons, where it
// meant `animate-pulse` was pulsing nothing and both screens loaded blank.
//
// Nobody is going to notice the next one either, so it is asserted rather than
// remembered. Scoped to the token FAMILIES the theme owns — a one-off
// `--draw-link` or a `--color-*` is covered by the same declaration scan, but a
// var() belonging to some other system (Tailwind's own, a third-party widget)
// is not this file's business, hence the prefix allowlist rather than "every
// var() anywhere".
//
// A BARE var() ONLY. `var(--color-text-tertiary, #6b7280)` resolves to the
// fallback and paints something, so it is not this defect — /disputes is built
// almost entirely that way, from a token vocabulary this theme never adopted,
// and the result is a page that renders correctly and simply does not follow
// light mode. That is a restyle, not a breakage, and folding it in here would
// mean this guard failed on arrival for a thing it is not about.

const ADMIN_SRC = join(__dirname, '..', '..');
const GLOBALS = join(ADMIN_SRC, 'app', 'globals.css');

/** Prefixes this theme is responsible for defining. */
const OWNED = ['--bg-', '--text-', '--border', '--color-', '--surface', '--draw-'];

function declaredTokens(): Set<string> {
  const css = readFileSync(GLOBALS, 'utf8');
  const names = new Set<string>();
  // A declaration, not a usage: `--name:` at the start of a property.
  for (const m of css.matchAll(/(--[a-z0-9-]+)\s*:/g)) names.add(m[1]!);
  return names;
}

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__' || entry === '.next') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, out);
    else if (/\.(tsx?|css)$/.test(entry)) out.push(full);
  }
  return out;
}

describe('admin theme tokens', () => {
  const declared = declaredTokens();

  it('declares the four background tokens the console is built on', () => {
    // A sanity check on the scanner itself: if the regex above stopped matching,
    // `declared` would be empty and the real assertion below would pass
    // vacuously over every file.
    for (const token of ['--bg-primary', '--bg-surface', '--bg-card', '--bg-elevated']) {
      expect(declared.has(token), `${token} missing from globals.css`).toBe(true);
    }
  });

  it('never paints with a token globals.css does not declare', () => {
    const offences: string[] = [];

    for (const file of sourceFiles(ADMIN_SRC)) {
      const text = readFileSync(file, 'utf8');
      const lines = text.split('\n');

      lines.forEach((line, i) => {
        // `var(--token)` with nothing after it. The negative lookahead is what
        // excludes `var(--token, fallback)` — see the note at the top.
        for (const m of line.matchAll(/var\((--[a-z0-9-]+)\s*\)/g)) {
          const token = m[1]!;
          if (!OWNED.some((p) => token.startsWith(p))) continue;
          if (declared.has(token)) continue;
          offences.push(`${relative(ADMIN_SRC, file)}:${i + 1} uses ${token}`);
        }
      });
    }

    // Named, not counted: the failure message has to say which token and where,
    // because "3 offences" sends the next person back to grep for them.
    expect(offences).toEqual([]);
  });
});
