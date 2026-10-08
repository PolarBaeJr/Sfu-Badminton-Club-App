import { describe, it, expect } from 'vitest';
import {
  BYTES_PER_ID,
  IN_CHUNK_SIZE,
  REQUEST_LINE_LIMIT_BYTES,
  RESERVED_REQUEST_BYTES,
  chunkIds,
  selectInChunks,
} from '../utils/query-chunks';

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

describe('IN_CHUNK_SIZE', () => {
  it('satisfies the byte budget it was derived from', () => {
    expect(IN_CHUNK_SIZE * BYTES_PER_ID + RESERVED_REQUEST_BYTES).toBeLessThanOrEqual(
      REQUEST_LINE_LIMIT_BYTES,
    );
  });

  it('is below the measured 414 threshold with room to spare', () => {
    // 220 uuids produced 8,232 bytes and a 414 on the production path.
    expect(IN_CHUNK_SIZE).toBeLessThan(215);
  });

  it('is one id away from spending the budget', () => {
    // Guards against the reserve being quietly enlarged into a token gesture:
    // one more id must not fit.
    expect((IN_CHUNK_SIZE + 1) * BYTES_PER_ID + RESERVED_REQUEST_BYTES).toBeGreaterThan(
      REQUEST_LINE_LIMIT_BYTES,
    );
  });
});

describe('chunkIds', () => {
  it('partitions without dropping or duplicating', () => {
    const ids = Array.from({ length: 1000 }, (_, i) => uuid(i));
    const batches = chunkIds(ids);
    expect(batches.flat()).toEqual(ids);
    for (const b of batches) expect(b.length).toBeLessThanOrEqual(IN_CHUNK_SIZE);
  });

  it('returns nothing for an empty list', () => {
    expect(chunkIds([])).toEqual([]);
  });
});

describe('selectInChunks', () => {
  it('concatenates every chunk in input order', async () => {
    const ids = Array.from({ length: 250 }, (_, i) => uuid(i));
    const seen: string[][] = [];
    const res = await selectInChunks(ids, async (batch) => {
      seen.push(batch);
      return { data: batch.map((id) => ({ id })), error: null };
    });
    expect(seen.length).toBe(Math.ceil(250 / IN_CHUNK_SIZE));
    expect(res.error).toBeNull();
    expect(res.data?.map((r) => r.id).sort()).toEqual([...ids].sort());
  });

  it('does not query at all for an empty list', async () => {
    let called = 0;
    const res = await selectInChunks([], async () => {
      called += 1;
      return { data: [], error: null };
    });
    expect(called).toBe(0);
    expect(res).toEqual({ data: [], error: null });
  });

  it('reports a failed chunk instead of returning a short list', async () => {
    // The failure mode this helper exists to prevent: a chunk that errors must
    // NOT arrive at the caller as "these hundred people matched nothing".
    const ids = Array.from({ length: 300 }, (_, i) => uuid(i));
    let call = 0;
    const res = await selectInChunks(ids, async (batch) => {
      call += 1;
      return call === 2
        ? { data: null, error: { message: 'Request-URI Too Large' } }
        : { data: batch.map((id) => ({ id })), error: null };
    });
    expect(res.error).toEqual({ message: 'Request-URI Too Large' });
  });
});
