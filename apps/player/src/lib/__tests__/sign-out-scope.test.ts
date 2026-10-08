import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

// EVERY signOut() NAMES ITS SCOPE. auth-js defaults to `global`, so a bare
// signOut() on one phone ends the member's sessions on every other device, and
// in the console too, since both apps share one cookie. Callers go through
// @badminton/shared/src/utils/sign-out, or pass `{ scope: ... }` themselves.

const SRC = join(__dirname, '../..');

/** Comments removed, the same way tour-copy.test.ts does it. */
function withoutComments(src: string): string {
  return src
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n')
    .filter((line) => !/^\s*\/\//.test(line))
    .join('\n');
}

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}

describe('sign-out scope', () => {
  it('no source file calls auth.signOut() without naming a scope', () => {
    const bare: string[] = [];
    for (const file of sourceFiles(SRC)) {
      const src = withoutComments(readFileSync(file, 'utf8'));
      for (const match of src.matchAll(/\.auth\.signOut\(([^)]*)\)/g)) {
        if (!/^\s*\{\s*scope:/.test(match[1] ?? '')) bare.push(`${relative(SRC, file)}: ${match[0]}`);
      }
    }
    expect(bare).toEqual([]);
  });
});
