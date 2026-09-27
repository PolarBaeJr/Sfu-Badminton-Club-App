import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// THE SAME RULE metro.config.js ENFORCES AT BUNDLE TIME, CHECKED WITHOUT A
// BUNDLE. The shared barrel and a handful of shared files import the email
// sender, web push or node crypto, none of which exists on a phone. Metro would
// refuse them; this fails first, in `npm test`, and it also walks every shared
// file the app reaches so a shared file that later grows a bad import is
// caught here rather than at the next export.

const APP_ROOT = resolve(__dirname, '..', '..');
const SHARED_ROOT = resolve(APP_ROOT, '..', '..', 'packages', 'shared');

function sourceFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === '__tests__') continue;
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) sourceFiles(full, found);
    else if (/\.tsx?$/.test(entry)) found.push(full);
  }
  return found;
}

/** Runtime imports only: `import type` is erased and never reaches Metro. */
function runtimeSpecifiers(source: string): string[] {
  const out: string[] = [];
  const re = /(?:^|\n)\s*(import|export)\s+(type\s+)?(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (!m[2]) out.push(m[3] as string);
  }
  for (const r of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) out.push(r[1] as string);
  return out;
}

function resolveFile(base: string): string | null {
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/** Why a path inside packages/shared may not be bundled, or null. */
function forbiddenShared(file: string): string | null {
  const rel = relative(SHARED_ROOT, file).split('\\').join('/').replace(/\.tsx?$/, '');
  if (rel === 'src/index' || rel === 'src') return 'the shared barrel';
  if (/^src\/(email|push)\//.test(rel)) return 'server-only email or push code';
  if (rel === 'src/utils/event-waiver' || rel === 'src/utils/data-api-key') return 'node crypto';
  return null;
}

const appFiles = [join(APP_ROOT, 'index.ts'), ...sourceFiles(join(APP_ROOT, 'src'))];

describe('apps/mobile never imports server-only shared code', () => {
  it('finds the app sources it claims to check', () => {
    expect(appFiles.length).toBeGreaterThan(10);
  });

  it('no app file imports the bare shared barrel', () => {
    const offenders = appFiles.filter((f) =>
      runtimeSpecifiers(readFileSync(f, 'utf8')).some((s) => s === '@badminton/shared' || s === '@badminton/shared/'),
    );
    expect(offenders.map((f) => relative(APP_ROOT, f))).toEqual([]);
  });

  it('no shared file reachable from the app is barrel, email, push, event-waiver or data-api-key', () => {
    const problems: string[] = [];
    const seen = new Set<string>();
    const queue: { file: string; from: string }[] = [];

    for (const f of appFiles) {
      for (const s of runtimeSpecifiers(readFileSync(f, 'utf8'))) {
        if (!s.startsWith('@badminton/shared/')) continue;
        const target = resolveFile(join(SHARED_ROOT, s.slice('@badminton/shared/'.length)));
        if (!target) {
          problems.push(`${relative(APP_ROOT, f)}: ${s} does not resolve`);
          continue;
        }
        queue.push({ file: target, from: relative(APP_ROOT, f) });
      }
    }

    while (queue.length > 0) {
      const { file, from } = queue.shift() as { file: string; from: string };
      const reason = forbiddenShared(file);
      if (reason) problems.push(`${from} reaches ${relative(SHARED_ROOT, file)} (${reason})`);
      if (seen.has(file)) continue;
      seen.add(file);
      for (const s of runtimeSpecifiers(readFileSync(file, 'utf8'))) {
        if (!s.startsWith('.')) continue;
        const target = resolveFile(resolve(dirname(file), s));
        if (target) queue.push({ file: target, from: relative(SHARED_ROOT, file) });
      }
    }

    expect(problems).toEqual([]);
  });

  it('the walk would catch a forbidden target', () => {
    expect(forbiddenShared(join(SHARED_ROOT, 'src/index.ts'))).not.toBeNull();
    expect(forbiddenShared(join(SHARED_ROOT, 'src/email/sender.ts'))).not.toBeNull();
    expect(forbiddenShared(join(SHARED_ROOT, 'src/push/send.ts'))).not.toBeNull();
    expect(forbiddenShared(join(SHARED_ROOT, 'src/utils/event-waiver.ts'))).not.toBeNull();
    expect(forbiddenShared(join(SHARED_ROOT, 'src/utils/data-api-key.ts'))).not.toBeNull();
    expect(forbiddenShared(join(SHARED_ROOT, 'src/utils/event-waiver-eligibility.ts'))).toBeNull();
    expect(runtimeSpecifiers("import { x } from '@badminton/shared';")).toEqual(['@badminton/shared']);
    expect(runtimeSpecifiers("import type { X } from '@badminton/shared';")).toEqual([]);
  });
});
