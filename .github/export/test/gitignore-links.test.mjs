import assert from 'node:assert/strict';
import { test } from 'node:test';

import { checkLinks } from '../lib/links.mjs';
import { transformGitignore } from '../lib/transform.mjs';

test('comments go, and negations that name nothing exported go', () => {
  const text = '# deps\nnode_modules/\n\n\n# local\nscripts/*\n!scripts/kept.mjs\n!scripts/private.sh\n!scripts/sql/\n!.env.example\n';
  const out = transformGitignore(text, ['scripts/kept.mjs', 'apps/a/.env.example']);
  assert.equal(out, 'node_modules/\n\nscripts/*\n!scripts/kept.mjs\n!.env.example\n');
});

test('a directory negation is kept when something below it is exported', () => {
  const out = transformGitignore('scripts/*\n!scripts/sql/\n', ['scripts/sql/a.sql']);
  assert.equal(out, 'scripts/*\n!scripts/sql/\n');
});

test('relative links must resolve to an exported file or directory', () => {
  const paths = ['README.md', 'docs/a.md', 'docs/guides/b.md'];
  const texts = [
    ['README.md', '[a](docs/a.md) [g](docs/guides/) [web](https://x.example) [top](#top)\n[gone](docs/ops/c.md)\n'],
    ['docs/a.md', '```\n[ignored](nowhere.md)\n```\n[b](guides/b.md#part) [up](../README.md)\n'],
  ];
  assert.deepEqual(checkLinks(paths, texts), [{ path: 'README.md', line: 2 }]);
});
