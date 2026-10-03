#!/usr/bin/env node
// Builds the public export of this repository into an empty directory.
//
//   node .github/export/export.mjs --out <dir> [--source <repo>]
//     [--ref <ref> | --worktree] [--patterns-file <path>] [--require-patterns]
//     [--tree-hash] [--verify]
//
// Pipeline: select (include.txt, default-deny), brand map, migration comment
// redaction, .gitignore cleanup, generated icons, migration manifest, link
// check, leak checks. Exits non-zero on any failure. See README.md here.
//
// Nothing this prints may carry file contents or a personal pattern: a report
// line is `path:line: [category] rule <id>`. The logs of a public repo's
// Actions runs are public.

import { spawnSync } from 'node:child_process';
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { generatedAssets } from './lib/icons.mjs';
import { compileRules, formatFinding, parsePatterns, scan } from './lib/leaks.mjs';
import { checkLinks } from './lib/links.mjs';
import { computeManifest, formatManifest, MIGRATIONS_DIR } from './lib/manifest.mjs';
import { listSource, readInclude, selectPaths, globToRegExp } from './lib/select.mjs';
import { applyBrandMap, compileBrandMap, redactMigration, transformGitignore } from './lib/transform.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

export function parseArgs(argv) {
  const opts = {
    out: null,
    source: resolve(HERE, '..', '..'),
    ref: 'HEAD',
    worktree: false,
    patternsFile: null,
    requirePatterns: false,
    treeHash: false,
    verify: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const take = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${arg} needs a value`);
      return v;
    };
    switch (arg) {
      case '--out': opts.out = resolve(take()); break;
      case '--source': opts.source = resolve(take()); break;
      case '--ref': opts.ref = take(); break;
      case '--worktree': opts.worktree = true; break;
      case '--patterns-file': opts.patternsFile = resolve(take()); break;
      case '--require-patterns': opts.requirePatterns = true; break;
      case '--tree-hash': opts.treeHash = true; break;
      case '--verify': opts.verify = true; break;
      default: throw new Error(`unknown option: ${arg}`);
    }
  }
  if (!opts.out) throw new Error('--out <dir> is required');
  return opts;
}

function inside(child, parent) {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith(sep) && rel !== '..');
}

function real(path) {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/**
 * The personal patterns. A publish run passes --require-patterns, and then an
 * absent, empty or blank value is a hard failure: the check must fail closed
 * when it is the last thing between a member's name and a public branch. A dry
 * run only warns.
 */
export function loadPatterns(opts, env = process.env) {
  let text = env.EXPORT_LEAK_PATTERNS ?? '';
  if (opts.patternsFile) {
    if (inside(real(opts.patternsFile), real(opts.source))) {
      throw new Error('--patterns-file must live outside the source repository');
    }
    text = readFileSync(opts.patternsFile, 'utf8');
  }
  const patterns = parsePatterns(text);
  if (patterns.length === 0) {
    if (opts.requirePatterns) {
      return { patterns, error: 'EXPORT_LEAK_PATTERNS is not set or empty; refusing to publish without the personal-value check' };
    }
    return { patterns, warning: 'EXPORT_LEAK_PATTERNS not set; personal-value check skipped' };
  }
  return { patterns };
}

function isBinary(buf) {
  if (buf.includes(0)) return true;
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(buf);
    return false;
  } catch {
    return true;
  }
}

function treeHash(dir) {
  const tmp = mkdtempSync(join(tmpdir(), 'export-tree-'));
  try {
    const env = { ...process.env, GIT_DIR: join(tmp, 'repo.git'), GIT_INDEX_FILE: join(tmp, 'index'), GIT_WORK_TREE: dir };
    delete env.EXPORT_LEAK_PATTERNS;
    const run = (args, runEnv = env) => {
      const res = spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.fileMode=true', ...args], { env: runEnv, cwd: dir, encoding: 'utf8' });
      if (res.status !== 0) throw new Error(`git ${args[0]} failed: ${res.stderr.trim()}`);
      return res.stdout.trim();
    };
    const { GIT_DIR, GIT_INDEX_FILE, GIT_WORK_TREE, ...initEnv } = env;
    run(['init', '--quiet', '--bare', GIT_DIR], initEnv);
    run(['add', '--all', '--force', '.']);
    return run(['write-tree']);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

function runVerify(dir) {
  const env = { ...process.env };
  delete env.EXPORT_LEAK_PATTERNS;
  for (const cmd of [
    ['npm', ['ci']],
    ['npx', ['turbo', 'run', 'type-check', 'lint', 'test', '--continue']],
  ]) {
    console.log(`\n== verify: ${cmd[0]} ${cmd[1].join(' ')}`);
    const res = spawnSync(cmd[0], cmd[1], { cwd: dir, env, stdio: 'inherit' });
    if (res.status !== 0) return false;
  }
  return true;
}

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv);
  let failed = false;
  const fail = (msg) => {
    failed = true;
    console.log(`FAIL ${msg}`);
  };

  const { patterns, error, warning } = loadPatterns(opts);
  if (error) {
    console.log(`::error::${error}`);
    return 1;
  }
  if (warning) console.log(`::warning::${warning}`);

  if (inside(real(opts.out), real(opts.source))) throw new Error('--out must be outside the source repository');
  if (existsSync(opts.out) && readdirSync(opts.out).length > 0) throw new Error('--out must be empty or absent');
  mkdirSync(opts.out, { recursive: true });

  const leakConfig = JSON.parse(readFileSync(join(HERE, 'leak-rules.json'), 'utf8'));
  const brandConfig = JSON.parse(readFileSync(join(HERE, 'brand-map.json'), 'utf8'));
  const include = readInclude(join(HERE, 'include.txt'));

  // 1. select
  const source = listSource(opts.source, { ref: opts.ref, worktree: opts.worktree });
  for (const p of source.problems) fail(`${p.split(':')[0]}:0: [select] rule ${p.endsWith('submodule') ? 'submodule' : 'symlink'}`);
  const { selected, unmatched } = selectPaths(
    source.files.map((f) => f.path),
    include,
    leakConfig.deny,
    leakConfig.denyAllow,
  );
  for (const pattern of unmatched) fail(`include.txt: pattern matches nothing (line text: ${pattern})`);
  const modes = new Map(source.files.map((f) => [f.path, f.mode]));

  const files = new Map();
  for (const path of selected) {
    const buf = readFileSync(join(source.root, path));
    files.set(path, isBinary(buf) ? { binary: true, buf } : { text: buf.toString('utf8') });
  }
  if (!opts.worktree) rmSync(source.root, { recursive: true, force: true });

  // 2. brand map
  const brandRules = compileBrandMap(brandConfig);
  const skip = (brandConfig.skip ?? []).map(globToRegExp);
  const counts = new Map();
  for (const [path, file] of files) {
    if (file.binary || skip.some((re) => re.test(path))) continue;
    file.text = applyBrandMap(brandRules, path, file.text, counts);
  }

  // 3. transforms
  const compiled = compileRules(leakConfig, patterns);
  let redacted = 0;
  for (const [path, file] of files) {
    if (file.binary) continue;
    if (path.startsWith(MIGRATIONS_DIR) && path.endsWith('.sql')) {
      const r = redactMigration(compiled, path, file.text);
      file.text = r.text;
      redacted += r.redacted;
    }
  }
  if (files.has('.gitignore')) {
    files.get('.gitignore').text = transformGitignore(files.get('.gitignore').text, [...files.keys()]);
  }

  // 4. generated assets
  for (const [path, buf] of generatedAssets()) files.set(path, { binary: true, buf, generated: true });

  // 5. manifest, last, over the final migration bytes
  const manifestPath = `${MIGRATIONS_DIR}.manifest.json`;
  if (files.has(manifestPath)) {
    const migrations = [...files]
      .filter(([p]) => p.startsWith(MIGRATIONS_DIR) && !p.slice(MIGRATIONS_DIR.length).includes('/'))
      .map(([p, f]) => [p.slice(MIGRATIONS_DIR.length), f.binary ? f.buf : Buffer.from(f.text, 'utf8')]);
    files.get(manifestPath).text = formatManifest(computeManifest(migrations));
  }

  // write
  for (const [path, file] of files) {
    const dest = join(opts.out, path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, file.binary ? file.buf : file.text);
    chmodSync(dest, modes.get(path) === '100755' ? 0o755 : 0o644);
  }

  // 6. links
  const texts = [...files].filter(([, f]) => !f.binary).map(([p, f]) => [p, f.text]);
  for (const b of checkLinks([...files.keys()], texts)) fail(`${b.path}:${b.line}: [link] rule broken-link`);

  // 7. leaks
  const findings = scan(compiled, files, leakConfig.binaryAllow);
  const fails = findings.filter((f) => f.level === 'fail');
  const warns = findings.filter((f) => f.level !== 'fail');

  console.log(`\n== export: ${files.size} files, ${redacted} migration comment lines redacted`);
  console.log('\n== brand map hits');
  for (const rule of brandConfig.rules) {
    const n = counts.get(rule.from) ?? 0;
    console.log(`${String(n).padStart(6)}  ${JSON.stringify(rule.from)}`);
    if (n === 0) console.log(`::warning::brand rule matched nothing: ${JSON.stringify(rule.from)}`);
  }

  const tally = (list) => {
    const by = new Map();
    for (const f of list) by.set(`${f.category}/${f.id}`, (by.get(`${f.category}/${f.id}`) ?? 0) + 1);
    return [...by].sort();
  };
  console.log(`\n== leak check: ${fails.length} failing, ${warns.length} warning`);
  for (const [k, n] of tally(fails)) console.log(`  fail ${k}: ${n}`);
  for (const [k, n] of tally(warns)) console.log(`  warn ${k}: ${n}`);
  if (fails.length) {
    console.log('\n== failing lines');
    for (const f of fails) console.log(formatFinding(f));
    failed = true;
  }
  if (warns.length) {
    console.log('\n== warning lines');
    for (const f of warns) console.log(formatFinding(f));
  }

  if (opts.treeHash) {
    const tree = treeHash(opts.out);
    console.log(`\ntree ${tree}`);
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tree=${tree}\n`);
  }

  if (failed) {
    console.log('\nexport FAILED');
    return 1;
  }
  if (opts.verify && !runVerify(opts.out)) {
    console.log('\nexport verify FAILED');
    return 1;
  }
  console.log('\nexport OK');
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = main();
  } catch (err) {
    console.log(`::error::${err.message}`);
    process.exitCode = 1;
  }
}
