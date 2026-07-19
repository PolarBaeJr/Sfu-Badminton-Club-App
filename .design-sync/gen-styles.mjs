// Regenerates the CSS snapshot the design-sync bundle ships (cfg.cssEntry).
// Run after any player-app build that changes styles:
//   node .design-sync/gen-styles.mjs
//
// What it does:
//  1. Takes the LARGEST compiled stylesheet from apps/player/.next/static/css
//     (tokens + tailwind utilities + component classes).
//  2. Prepends a Google Fonts @import (the app loads Inter / Space Grotesk /
//     JetBrains Mono via next/font with hashed family names; previews use the
//     real names).
//  3. Maps the next/font CSS vars to real family names on :root.
//  4. Mirrors every `[data-theme="dark"]` token block onto :root — preview
//     pages have no data-theme attribute on <html>, so without this every
//     var(--*) resolves to nothing and components render unstyled. Dark is
//     mirrored because the app is dark-by-default (slate/#E94560 design).
//  5. Writes .design-sync/app-styles.css and copies it to
//     packages/ui/.ds-styles.css (the package-relative cssEntry, gitignored).
import { readFileSync, writeFileSync, readdirSync, statSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const cssDir = join(root, 'apps/player/.next/static/css');

const files = readdirSync(cssDir).filter((f) => f.endsWith('.css'));
if (!files.length) throw new Error(`no compiled css in ${cssDir} — build apps/player first`);
const largest = files
  .map((f) => ({ f, size: statSync(join(cssDir, f)).size }))
  .sort((a, b) => b.size - a.size)[0].f;
const css = readFileSync(join(cssDir, largest), 'utf8');

// Mirror [data-theme="dark"] custom-prop blocks onto :root (token blocks have
// no nested braces, so a flat regex is safe on the minified output).
const darkBlocks = [...css.matchAll(/\[data-theme=(?:"dark"|dark)\]\{([^}]+)\}/g)].map(
  (m) => m[1],
);
if (!darkBlocks.length) console.warn('! no [data-theme=dark] blocks found — tokens may be missing');

const out = [
  '@import url("https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500;600;700&display=swap");',
  `/* Snapshot of apps/player compiled CSS (${largest}). Regenerate: node .design-sync/gen-styles.mjs */`,
  ':root{--font-sans:"Inter";--font-display:"Space Grotesk";--font-mono:"JetBrains Mono";}',
  `:root{${darkBlocks.join(';')}}`,
  css,
  // Preview cards inline body{background:#fff} AFTER linking this sheet; the
  // dark ground must win, so use higher specificity (html body) not order.
  'html body{background:var(--bg);color:var(--ink)}',
].join('\n');

writeFileSync(join(root, '.design-sync/app-styles.css'), out);
copyFileSync(join(root, '.design-sync/app-styles.css'), join(root, 'packages/ui/.ds-styles.css'));
console.log(
  `wrote app-styles.css (${(out.length / 1024).toFixed(0)} KB) from ${largest}; dark-token blocks mirrored to :root: ${darkBlocks.length}`,
);
