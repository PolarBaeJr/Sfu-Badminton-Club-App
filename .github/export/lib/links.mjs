// Every relative link in an exported markdown file must resolve to an exported
// file or directory. Docs that point at something the export leaves out are
// the drift this catches.

import { posix } from 'node:path';

const LINK = /\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;

export function checkLinks(paths, texts) {
  const files = new Set(paths);
  const dirs = new Set();
  for (const p of paths) {
    let d = posix.dirname(p);
    while (d !== '.' && !dirs.has(d)) {
      dirs.add(d);
      d = posix.dirname(d);
    }
  }
  const broken = [];
  for (const [path, text] of texts) {
    if (!path.endsWith('.md')) continue;
    let fenced = false;
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      if (/^\s*(```|~~~)/.test(lines[i])) {
        fenced = !fenced;
        continue;
      }
      if (fenced) continue;
      for (const m of lines[i].matchAll(LINK)) {
        const target = m[1];
        if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith('#') || target.startsWith('/')) continue;
        let rel = target.split('#')[0].split('?')[0];
        if (!rel) continue;
        try {
          rel = decodeURIComponent(rel);
        } catch {
          // keep the raw text
        }
        const resolved = posix.normalize(posix.join(posix.dirname(path), rel)).replace(/\/$/, '');
        if (resolved === '.' || files.has(resolved) || dirs.has(resolved)) continue;
        broken.push({ path, line: i + 1 });
      }
    }
  }
  return broken;
}
