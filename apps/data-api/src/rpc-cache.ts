// A short-lived cache in front of the read RPCs.
//
// Every read the API serves goes through one of a few SECURITY DEFINER
// functions, and most of them build their answer from data_api_match_rows(),
// which is a scan of the club's whole match history. Ten consumers asking for
// the same standings at once were ten scans. With this cache they are one:
// identical calls in flight share a single database call, and its answer is
// reused for TTL_MS.
//
// The key is the function name and its exact arguments, and every public read
// function takes the consumer id first, so one consumer's refs can never be
// served to another. Failures are not kept: a rejected call is dropped as soon
// as it settles, so the next request asks the database again.
//
// Key verification does NOT go through here. It has its own cache, with its own
// 30-second contract for revocation (auth.ts).

export const RPC_CACHE_TTL_MS = 15_000;
const MAX_ENTRIES = 1000;

interface Entry {
  expires: number;
  value: Promise<unknown[]>;
}

export class RpcCache {
  private readonly entries = new Map<string, Entry>();

  constructor(
    private readonly now: () => number,
    private readonly ttlMs = RPC_CACHE_TTL_MS,
    private readonly maxEntries = MAX_ENTRIES,
  ) {}

  get(fn: string, args: Record<string, unknown>, load: () => Promise<unknown[]>): Promise<unknown[]> {
    const key = fn + '\u0000' + JSON.stringify(args);
    const t = this.now();
    const hit = this.entries.get(key);
    if (hit && hit.expires > t) return hit.value;
    if (hit) this.entries.delete(key);

    const value = load();
    const entry: Entry = { expires: t + this.ttlMs, value };
    this.entries.set(key, entry);
    value.catch(() => {
      if (this.entries.get(key) === entry) this.entries.delete(key);
    });
    this.evict();
    return value;
  }

  get size(): number {
    return this.entries.size;
  }

  // Map iterates in insertion order, so the first entries are the oldest.
  private evict(): void {
    for (const key of this.entries.keys()) {
      if (this.entries.size <= this.maxEntries) break;
      this.entries.delete(key);
    }
  }
}
