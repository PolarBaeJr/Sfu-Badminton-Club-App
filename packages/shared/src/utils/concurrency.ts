// Bounded parallelism.
//
// `Promise.all(xs.map(f))` starts EVERY task at once. That is right for a
// handful of independent reads and wrong for anything that scales with the
// roster: Node's default HTTPS agent is `maxSockets: Infinity`, so a fan-out
// over 650 push subscriptions opens 650 TLS handshakes and runs 650 ECDSA
// P-256 signings at the same instant, on a Pi that is also hosting three
// Supabase stacks, the reverse proxy and both Next apps, with the memory
// cgroup disabled and no container limits to contain the result.

/**
 * Run `task` over every item with at most `limit` in flight at a time.
 *
 * Results come back in input order. Rejection semantics match `Promise.all`:
 * the first rejection propagates. Tasks already in flight are allowed to
 * settle before the error surfaces, so no send is left dangling — but no
 * further tasks are started, which is what makes this safe to use on a path
 * where a failure means "stop", not "keep hammering".
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const width = Math.max(1, Math.min(Math.floor(limit), items.length));
  const results = new Array<R>(items.length);
  let next = 0;
  let failure: unknown;
  let failed = false;

  // One worker per slot, each pulling the next index off a shared cursor.
  // A fixed-size pool rather than batches of `limit`: batching would idle the
  // whole pool waiting on the slowest member of each batch, which for push is
  // the one endpoint whose provider is timing out.
  const worker = async (): Promise<void> => {
    for (;;) {
      if (failed) return;
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await task(items[index] as T, index);
      } catch (err) {
        // First failure wins and stops the pool. Recorded rather than
        // rethrown here so the other in-flight workers finish their current
        // task instead of being abandoned mid-request.
        if (!failed) {
          failed = true;
          failure = err;
        }
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: width }, () => worker()));
  if (failed) throw failure;
  return results;
}
