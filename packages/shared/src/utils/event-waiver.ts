import { createHash } from 'node:crypto';

// Stable fingerprint of a tournament event's waiver text. Trimmed so trivial
// whitespace edits don't force re-acceptance; any real edit changes the hash,
// and the unique (player_id, tournament_id, waiver_hash) then requires a fresh
// acceptance. Node-only (node:crypto) — imported by subpath, NOT via the barrel.
export function eventWaiverHash(text: string): string {
  return createHash('sha256').update(text.trim()).digest('hex');
}
