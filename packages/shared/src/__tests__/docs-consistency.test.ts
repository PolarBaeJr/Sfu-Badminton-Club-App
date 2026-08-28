import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// F-027: the README carried a hand-maintained release version and a Node
// prerequisite, and both had drifted from package.json — 1.1.0 against 1.5.1,
// and Node 20 against an engines range that refuses anything below 24. Neither
// drift is visible to anyone reading only one of the two files, and the Node
// one sends a new contributor to install a runtime `npm install` will then
// reject.
//
// The version label is gone (package.json is the single authority, and the app
// reads it for Settings → About). The Node prerequisite has to stay in prose
// because it is advice to a human before they have a checkout, so it gets a
// test instead.
const ROOT = join(__dirname, '../../../..');
const readme = readFileSync(join(ROOT, 'README.md'), 'utf8');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
  version: string;
  engines?: { node?: string };
};

describe('README stays consistent with package.json', () => {
  it('quotes the same Node major that engines.node enforces', () => {
    const enforced = pkg.engines?.node?.match(/>=\s*(\d+)/)?.[1];
    expect(enforced, 'engines.node should carry a >= major').toBeDefined();

    const stated = readme.match(/\*\*Prerequisites:\*\*\s*Node\s*(\d+)/)?.[1];
    expect(stated, 'README should state a Node major under Prerequisites').toBeDefined();

    expect(stated).toBe(enforced);
  });

  it('does not reintroduce a hand-maintained version label', () => {
    // A literal semver next to the word "Version:" is the shape that drifted.
    // package.json is the authority; the README points at it.
    expect(readme).not.toMatch(/\*\*Version:\*\*\s*\d+\.\d+\.\d+/);
  });
});
