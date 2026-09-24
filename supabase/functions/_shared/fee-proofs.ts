// The e-transfer screenshots a member uploaded (00248), erased with them.
//
// Stored in the private fee-proofs bucket under `<auth user id>/`, the only
// folder the upload policy allows. Called by both purge jobs BEFORE the auth
// user is deleted and the row anonymised, while user_id is still known. The
// fee_submissions rows stay (they are the club's record of a payment) with
// screenshot_path nulled.
//
// Removes every path a row points at, then everything left in the folder: an
// upload whose receipt was never filed, or whose row went with a deleted fee.
// Idempotent: a second run finds nothing and removes nothing.

import type { createServiceClient } from './client.ts';

type ServiceClient = ReturnType<typeof createServiceClient>;

const BUCKET = 'fee-proofs';
const PAGE = 100;

export async function eraseFeeProofs(
  supabase: ServiceClient,
  playerId: string,
  userId: string | null,
): Promise<{ message: string } | null> {
  const { data: rows, error: readError } = await supabase
    .from('fee_submissions')
    .select('screenshot_path')
    .eq('player_id', playerId)
    .not('screenshot_path', 'is', null);
  if (readError) return readError;

  const paths = new Set<string>(
    ((rows ?? []) as { screenshot_path: string }[]).map((r) => r.screenshot_path),
  );

  if (userId) {
    // Every page is listed before anything is removed, so removing cannot
    // shift the offsets under the listing.
    for (let offset = 0; ; offset += PAGE) {
      const { data: objects, error: listError } = await supabase.storage
        .from(BUCKET)
        .list(userId, { limit: PAGE, offset });
      if (listError) return listError;
      for (const o of objects ?? []) paths.add(`${userId}/${o.name}`);
      if (!objects || objects.length < PAGE) break;
    }
  }

  const all = [...paths];
  for (let i = 0; i < all.length; i += PAGE) {
    const { error: removeError } = await supabase.storage.from(BUCKET).remove(all.slice(i, i + PAGE));
    if (removeError) return removeError;
  }

  const { error: nullError } = await supabase
    .from('fee_submissions')
    .update({ screenshot_path: null })
    .eq('player_id', playerId)
    .not('screenshot_path', 'is', null);
  return nullError;
}
