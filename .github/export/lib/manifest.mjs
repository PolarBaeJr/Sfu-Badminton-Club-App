// Recomputes supabase/migrations/.manifest.json for the exported migrations,
// with the same algorithm as packages/shared/src/__tests__/migration-manifest.test.ts.
// The export redacts migration comments, so the committed manifest no longer
// matches; the regenerated one does, and that test passes in the export.

import { createHash } from 'node:crypto';

export const MIGRATIONS_DIR = 'supabase/migrations/';

/** `files` is [name, Buffer] for each file directly in the migrations dir. */
export function computeManifest(files) {
  const sql = files
    .filter(([name]) => /^\d+.*\.sql$/.test(name))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const lines = sql.map(([name, buf]) => {
    const version = name.split('_')[0];
    return `${version} ${createHash('sha256').update(buf).digest('hex')}`;
  });
  return {
    count: sql.length,
    latest: sql.length ? sql[sql.length - 1][0].split('_')[0] : '',
    rollup: createHash('sha256').update(lines.join('\n') + '\n').digest('hex'),
  };
}

export function formatManifest(manifest) {
  return JSON.stringify(manifest, null, 2) + '\n';
}
