// In-memory token buckets.
//
// THE EDGE PROXY IS THE PRIMARY LIMITER. These buckets are per process: with
// two replicas a caller gets twice the budget, and a restart refills every
// bucket. They exist so that one consumer, or one key-guesser, cannot turn this
// service into a database load generator between the edge and PostgREST.

export interface TakeResult {
  ok: boolean;
  /** Whole seconds until one token is available again. 0 when ok. */
  retryAfter: number;
}

interface Bucket {
  tokens: number;
  at: number;
}

export class TokenBuckets {
  private readonly buckets = new Map<string, Bucket>();
  private readonly perMs: number;

  constructor(
    private readonly capacity: number,
    windowMs: number,
    private readonly maxEntries: number,
    private readonly now: () => number,
  ) {
    this.perMs = capacity / windowMs;
  }

  private refill(id: string): Bucket {
    const t = this.now();
    let bucket = this.buckets.get(id);
    if (!bucket) {
      bucket = { tokens: this.capacity, at: t };
    } else {
      bucket.tokens = Math.min(this.capacity, bucket.tokens + (t - bucket.at) * this.perMs);
      bucket.at = t;
      this.buckets.delete(id);
    }
    // Re-inserted so Map order is least-recently-used first.
    this.buckets.set(id, bucket);
    while (this.buckets.size > this.maxEntries) {
      const oldest = this.buckets.keys().next().value;
      if (oldest === undefined) break;
      this.buckets.delete(oldest);
    }
    return bucket;
  }

  private retryAfter(bucket: Bucket): number {
    return Math.max(1, Math.ceil((1 - bucket.tokens) / this.perMs / 1000));
  }

  /** Spend one token if there is one. */
  take(id: string): TakeResult {
    const bucket = this.refill(id);
    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return { ok: true, retryAfter: 0 };
    }
    return { ok: false, retryAfter: this.retryAfter(bucket) };
  }

  /** Whether a token is available, without spending it. */
  check(id: string): TakeResult {
    const bucket = this.refill(id);
    return bucket.tokens >= 1 ? { ok: true, retryAfter: 0 } : { ok: false, retryAfter: this.retryAfter(bucket) };
  }
}
