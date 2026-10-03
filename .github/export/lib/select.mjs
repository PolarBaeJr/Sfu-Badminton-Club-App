// Which files the export contains. Default-deny: a path ships only when the
// last include.txt pattern that matches it is a positive one, and the hard
// denylist in leak-rules.json overrides even that.
//
// Files are enumerated from git, never from a directory walk, so an untracked
// .env.local or auth-logs export cannot reach the output however it got there.

import { spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A glob anchored to the whole repo-relative path. `**` spans directories,
 * `*` and `?` stay inside one segment, `[...]` is a character class. A pattern
 * ending in `/` matches everything below that directory.
 */
export function globToRegExp(glob) {
  let g = glob;
  if (g.endsWith('/')) g += '**';
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') {
        const slashAfter = g[i + 2] === '/';
        const atSegmentStart = i === 0 || g[i - 1] === '/';
        if (slashAfter && atSegmentStart) {
          re += '(?:.*/)?';
          i += 2;
        } else {
          re += '.*';
          i += 1;
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else if (c === '[') {
      const end = g.indexOf(']', i + 1);
      if (end === -1) {
        re += '\\[';
      } else {
        let cls = g.slice(i + 1, end);
        if (cls.startsWith('!')) cls = '^' + cls.slice(1);
        re += `[${cls.replace(/\\/g, '\\\\')}]`;
        i = end;
      }
    } else {
      re += c.replace(/[.+^${}()|\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

/** Parses include.txt: one glob per line, `!` negates, `#` comments. */
export function parseInclude(text) {
  const rules = [];
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const negate = line.startsWith('!');
    const pattern = negate ? line.slice(1) : line;
    rules.push({ pattern: line, negate, re: globToRegExp(pattern) });
  }
  return rules;
}

/**
 * Applies the include rules (later lines win) and then the denylist. Returns
 * the selected paths and every include pattern that matched no path at all,
 * which the caller treats as a failure so the list cannot quietly go stale.
 */
export function selectPaths(paths, includeRules, denyGlobs = [], allowGlobs = []) {
  const deny = denyGlobs.map(globToRegExp);
  const allow = allowGlobs.map(globToRegExp);
  const used = new Set();
  const selected = [];
  for (const path of paths) {
    let keep = false;
    for (const rule of includeRules) {
      if (rule.re.test(path)) {
        used.add(rule.pattern);
        keep = !rule.negate;
      }
    }
    if (!keep) continue;
    if (deny.some((re) => re.test(path)) && !allow.some((re) => re.test(path))) continue;
    selected.push(path);
  }
  const unmatched = includeRules.filter((r) => !used.has(r.pattern)).map((r) => r.pattern);
  return { selected, unmatched };
}

function git(cwd, args, opts = {}) {
  const res = spawnSync('git', ['-C', cwd, ...args], { maxBuffer: 1024 * 1024 * 1024, ...opts });
  if (res.error) throw res.error;
  if (res.status !== 0) {
    throw new Error(`git ${args[0]} failed (exit ${res.status}): ${String(res.stderr).trim()}`);
  }
  return res.stdout;
}

/**
 * Lists the source files with their content root and mode.
 *
 * ref mode: the tree at <ref>, extracted with git archive into a temp dir.
 * worktree mode: tracked plus untracked-but-not-ignored files as they are on
 * disk, so an uncommitted change can be dry-run. Ignored files never appear in
 * either mode.
 *
 * Symlinks and submodules fail the run: neither has an obvious safe export.
 */
export function listSource(src, { ref = 'HEAD', worktree = false } = {}) {
  const problems = [];
  if (worktree) {
    const out = git(src, ['ls-files', '-z', '--cached', '--others', '--exclude-standard']).toString('utf8');
    const staged = git(src, ['ls-files', '-s', '-z']).toString('utf8');
    for (const entry of staged.split('\0')) {
      if (!entry) continue;
      const mode = entry.split(' ')[0];
      if (mode === '160000') problems.push(`${entry.split('\t')[1]}: submodule`);
    }
    const files = [];
    const seen = new Set();
    for (const path of out.split('\0')) {
      if (!path || seen.has(path)) continue;
      seen.add(path);
      let st;
      try {
        st = lstatSync(join(src, path));
      } catch {
        continue; // listed in the index but deleted on disk
      }
      if (st.isSymbolicLink()) {
        problems.push(`${path}: symlink`);
        continue;
      }
      if (!st.isFile()) continue;
      files.push({ path, mode: st.mode & 0o111 ? '100755' : '100644' });
    }
    return { root: src, files, problems };
  }

  const tree = git(src, ['ls-tree', '-r', '-z', '--full-tree', ref]).toString('utf8');
  const files = [];
  for (const entry of tree.split('\0')) {
    if (!entry) continue;
    const [meta, path] = entry.split('\t');
    const mode = meta.split(' ')[0];
    if (mode === '120000') problems.push(`${path}: symlink`);
    else if (mode === '160000') problems.push(`${path}: submodule`);
    else files.push({ path, mode });
  }
  const root = mkdtempSync(join(tmpdir(), 'export-src-'));
  const tar = git(src, ['archive', '--format=tar', ref]);
  const res = spawnSync('tar', ['-x', '-C', root], { input: tar, maxBuffer: 1024 * 1024 * 1024 });
  if (res.status !== 0) throw new Error(`tar failed: ${String(res.stderr).trim()}`);
  return { root, files, problems };
}

export function readInclude(path) {
  return parseInclude(readFileSync(path, 'utf8'));
}
