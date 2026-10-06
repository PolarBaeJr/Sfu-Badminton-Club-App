// Text transforms applied to the selected files: the brand map, comment
// redaction for migrations, and the .gitignore cleanup.

import { globToRegExp } from './select.mjs';
import { lineHits } from './leaks.mjs';

export function compileBrandMap(map) {
  return map.rules
    .map((r, index) => ({
      ...r,
      index,
      only: r.paths ? r.paths.map(globToRegExp) : null,
      skip: r.exclude ? r.exclude.map(globToRegExp) : [],
    }))
    .sort((a, b) => b.from.length - a.from.length || a.index - b.index);
}

/**
 * Literal, case-sensitive replacement, longest `from` first so a long phrase
 * is never pre-empted by a shorter rule inside it. Returns the new text and
 * the hit count per rule.
 */
export function applyBrandMap(rules, path, text, counts = new Map()) {
  let out = text;
  for (const rule of rules) {
    if (rule.only && !rule.only.some((re) => re.test(path))) continue;
    if (rule.skip.some((re) => re.test(path))) continue;
    const parts = out.split(rule.from);
    if (parts.length > 1) {
      counts.set(rule.from, (counts.get(rule.from) ?? 0) + parts.length - 1);
      out = parts.join(rule.to);
    }
  }
  return out;
}

export const REDACTED = '-- (redacted in export)';

/**
 * Which lines of a SQL file begin outside any string or block comment, and
 * whether they begin inside a dollar-quoted body. Only those lines can be a
 * whole-line `--` comment.
 */
function lineStates(sql) {
  const states = [];
  let mode = 'code'; // code | single | block | dollar
  let tag = '';
  let depth = 0;
  let atLineStart = true;
  for (let i = 0; i < sql.length; i++) {
    if (atLineStart) {
      states.push({ mode, tag });
      atLineStart = false;
    }
    const c = sql[i];
    if (c === '\n') {
      atLineStart = true;
      continue;
    }
    if (mode === 'single') {
      if (c === "'") {
        if (sql[i + 1] === "'") i++;
        else mode = 'code';
      }
      continue;
    }
    if (mode === 'block') {
      if (c === '*' && sql[i + 1] === '/') {
        depth--;
        i++;
        if (depth === 0) mode = 'code';
      } else if (c === '/' && sql[i + 1] === '*') {
        depth++;
        i++;
      }
      continue;
    }
    if (mode === 'dollar') {
      // A dollar-quoted body ends at the first closing tag, whatever sits
      // between, exactly as the server reads it.
      if (c === '$' && sql.startsWith(tag, i)) {
        i += tag.length - 1;
        mode = 'code';
        tag = '';
      }
      continue;
    }
    if (c === '-' && sql[i + 1] === '-') {
      const nl = sql.indexOf('\n', i);
      if (nl === -1) break;
      i = nl - 1;
      continue;
    }
    if (c === "'") {
      mode = 'single';
    } else if (c === '/' && sql[i + 1] === '*') {
      mode = 'block';
      depth = 1;
      i++;
    } else if (c === '$') {
      const m = /^\$[A-Za-z_]*\$/.exec(sql.slice(i, i + 64));
      if (m) {
        mode = 'dollar';
        tag = m[0];
        i += tag.length - 1;
      }
    }
  }
  if (atLineStart) states.push({ mode, tag });
  return states;
}

/**
 * Migrations are immutable in source, so a comment that still trips a fail rule
 * after the brand map has its text replaced here. Line count is preserved and
 * no SQL changes. Lines inside a single-quoted literal are data, never touched.
 * Inside a dollar-quoted body a line starting `---` is markdown, not a comment.
 * A hit that is not a whole-line comment is left for the leak scan to fail.
 */
export function redactMigration(compiled, path, sql) {
  const lines = sql.split('\n');
  const states = lineStates(sql);
  let redacted = 0;
  for (let i = 0; i < lines.length; i++) {
    const state = states[i] ?? { mode: 'code' };
    if (state.mode === 'single' || state.mode === 'block') continue;
    const trimmed = lines[i].trimStart();
    if (!trimmed.startsWith('--')) continue;
    if (state.mode === 'dollar' && trimmed.startsWith('---')) continue;
    const fails = lineHits(compiled, path, lines[i]).filter((h) => h.level === 'fail');
    if (fails.length === 0) continue;
    const indent = lines[i].slice(0, lines[i].length - trimmed.length);
    lines[i] = indent + REDACTED;
    redacted++;
  }
  return { text: lines.join('\n'), redacted };
}

/**
 * The exported .gitignore keeps its patterns but drops every comment (they
 * describe the private deployment) and every negation that names nothing in
 * the export. Runs of blank lines collapse to one.
 */
export function transformGitignore(text, exportedPaths) {
  const out = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line.startsWith('#')) continue;
    if (line.startsWith('!')) {
      let pattern = line.slice(1);
      if (pattern.startsWith('/')) pattern = pattern.slice(1);
      // As in git: a pattern with no inner slash matches at any depth.
      if (!pattern.replace(/\/$/, '').includes('/')) pattern = `**/${pattern}`;
      const re = globToRegExp(pattern);
      const dirRe = pattern.endsWith('/') ? null : globToRegExp(`${pattern}/`);
      const named = exportedPaths.some((p) => re.test(p) || (dirRe && dirRe.test(p)));
      if (!named) continue;
    }
    if (line === '' && (out.length === 0 || out[out.length - 1] === '')) continue;
    out.push(raw.trimEnd());
  }
  while (out.length && out[out.length - 1] === '') out.pop();
  return out.join('\n') + '\n';
}
