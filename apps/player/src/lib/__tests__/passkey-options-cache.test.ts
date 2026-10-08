import { describe, it, expect, vi } from 'vitest';
import { createOptionsCache, onPageReturn, OPTIONS_FRESH_MS } from '../passkey-client';

// The options cache is what lets a passkey tap on iOS start the ceremony
// synchronously. Its other job is to never mint a second challenge while one is
// still usable: there is ONE challenge cookie per app and the last fetch wins.

type Options = { challenge: string };

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function clock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: (ms: number) => (t += ms) };
}

describe('passkey options cache', () => {
  it('folds concurrent primes into one fetch', async () => {
    const d = deferred<Options | null>();
    const fetcher = vi.fn(() => d.promise);
    const cache = createOptionsCache(fetcher);

    const a = cache.prime();
    const b = cache.prime();
    expect(fetcher).toHaveBeenCalledTimes(1);

    d.resolve({ challenge: 'one' });
    await expect(a).resolves.toEqual({ challenge: 'one' });
    await expect(b).resolves.toEqual({ challenge: 'one' });

    // A resolved, fresh entry is shared too.
    await cache.prime();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it('hands out options synchronously only once resolved and while fresh', async () => {
    const c = clock();
    const d = deferred<Options | null>();
    const cache = createOptionsCache(() => d.promise, c.now);

    const pending = cache.prime();
    expect(cache.takeFresh()).toBeNull();

    d.resolve({ challenge: 'one' });
    await pending;
    expect(cache.takeFresh()).toEqual({ challenge: 'one' });

    c.advance(OPTIONS_FRESH_MS - 1);
    expect(cache.takeFresh()).toEqual({ challenge: 'one' });

    c.advance(1);
    expect(cache.takeFresh()).toBeNull();
  });

  it('keeps the fresh window under the 5-minute server challenge TTL', () => {
    expect(OPTIONS_FRESH_MS).toBe(4 * 60 * 1000);
  });

  it('refetches once the cached options have gone stale', async () => {
    const c = clock();
    const fetcher = vi.fn(async () => ({ challenge: 'x' }));
    const cache = createOptionsCache(fetcher, c.now);

    await cache.prime();
    c.advance(OPTIONS_FRESH_MS);
    await cache.prime();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('invalidate forgets the options and the next prime fetches again', async () => {
    let n = 0;
    const fetcher = vi.fn(async () => ({ challenge: `c${++n}` }));
    const cache = createOptionsCache(fetcher);

    await cache.prime();
    cache.invalidate();
    expect(cache.takeFresh()).toBeNull();

    await expect(cache.prime()).resolves.toEqual({ challenge: 'c2' });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it('does not let a fetch that settles after invalidate write back', async () => {
    const d = deferred<Options | null>();
    const cache = createOptionsCache(() => d.promise);

    const pending = cache.prime();
    cache.invalidate();
    d.resolve({ challenge: 'spent' });
    await pending;

    expect(cache.takeFresh()).toBeNull();
  });

  it('resolves null on a refused or failed fetch, and allows a retry', async () => {
    const fetcher = vi
      .fn<() => Promise<Options | null>>()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce({ challenge: 'ok' });
    const cache = createOptionsCache(fetcher);

    await expect(cache.prime()).resolves.toBeNull();
    expect(cache.takeFresh()).toBeNull();

    await expect(cache.prime()).resolves.toBeNull();
    expect(cache.takeFresh()).toBeNull();

    await expect(cache.prime()).resolves.toEqual({ challenge: 'ok' });
    expect(cache.takeFresh()).toEqual({ challenge: 'ok' });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });
});

describe('re-priming when the page comes back', () => {
  function page(visibilityState: DocumentVisibilityState) {
    const win = new EventTarget();
    const doc = Object.assign(new EventTarget(), { visibilityState });
    return { win, doc };
  }

  it('fires on focus and on becoming visible, not on becoming hidden', () => {
    const { win, doc } = page('hidden');
    const callback = vi.fn();
    onPageReturn(callback, win, doc);

    doc.dispatchEvent(new Event('visibilitychange'));
    expect(callback).not.toHaveBeenCalled();

    doc.visibilityState = 'visible';
    doc.dispatchEvent(new Event('visibilitychange'));
    win.dispatchEvent(new Event('focus'));
    expect(callback).toHaveBeenCalledTimes(2);
  });

  it('stops listening after cleanup', () => {
    const { win, doc } = page('visible');
    const callback = vi.fn();
    const stop = onPageReturn(callback, win, doc);
    stop();

    doc.dispatchEvent(new Event('visibilitychange'));
    win.dispatchEvent(new Event('focus'));
    expect(callback).not.toHaveBeenCalled();
  });

  it('costs no fetch on return while the options are fresh, and one once stale', async () => {
    const c = clock();
    const fetcher = vi.fn(async () => ({ challenge: 'x' }));
    const cache = createOptionsCache(fetcher, c.now);
    const { win, doc } = page('visible');
    onPageReturn(() => void cache.prime(), win, doc);

    await cache.prime();
    win.dispatchEvent(new Event('focus'));
    doc.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(1);

    c.advance(OPTIONS_FRESH_MS);
    win.dispatchEvent(new Event('focus'));
    doc.dispatchEvent(new Event('visibilitychange'));
    await Promise.resolve();
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
});
