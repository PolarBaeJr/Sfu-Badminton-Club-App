import { describe, it, expect } from 'vitest';
import {
  DRAFT_TTL_MS,
  EMPTY_DECISIONS,
  clearDraft,
  draftKey,
  loadDraft,
  parseDraft,
  reapplyDecisions,
  saveDraft,
  sweepDrafts,
  type DraftStorage,
  type FeePasteDraft,
} from '../fee-paste-draft';
import type { FeePastePreview } from '../fee-paste';

// The unsent "Paste a list" dialog, kept for an hour. What these pin: it
// expires at exactly an hour, a bad value is thrown away rather than restored,
// and a restored decision only lands on a row that still offers it.

const SEASON = 's-1';
const NOW = 1_800_000_000_000;

function memoryStorage(initial: Record<string, string> = {}): DraftStorage & { data: Map<string, string> } {
  const data = new Map(Object.entries(initial));
  return {
    data,
    get length() { return data.size; },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => { data.set(k, v); },
    removeItem: (k: string) => { data.delete(k); },
  };
}

const blockedStorage: DraftStorage = {
  get length(): number { throw new Error('SecurityError'); },
  key: () => { throw new Error('SecurityError'); },
  getItem: () => { throw new Error('SecurityError'); },
  setItem: () => { throw new Error('QuotaExceededError'); },
  removeItem: () => { throw new Error('SecurityError'); },
};

const candidate = (playerId: string, state: 'will_mark' | 'already_paid' = 'will_mark') => ({
  playerId, name: playerId, maskedEmail: null, state, reason: null,
});

const preview = (over: Partial<FeePastePreview> = {}): FeePastePreview => ({
  season: { id: SEASON, name: 'Fall 2026', competitiveFeeCents: 3000, recreationalFeeCents: 2000 },
  willMark: [], alreadyPaid: [], waived: [], alreadyNamed: [], notBillable: [],
  ambiguous: [], notFound: [], invalid: [], namedMatches: [],
  ...over,
});

const draft = (over: Partial<FeePasteDraft> = {}): FeePasteDraft => ({
  v: 1,
  seasonId: SEASON,
  savedAt: NOW,
  text: 'Jane Doe',
  step: 'input',
  preview: null,
  decisions: EMPTY_DECISIONS,
  method: '',
  customMethod: '',
  reference: '',
  ...over,
});

describe('parseDraft', () => {
  it('restores a draft saved less than an hour ago', () => {
    const d = draft();
    expect(parseDraft(JSON.stringify(d), SEASON, NOW + DRAFT_TTL_MS - 1)).toEqual({ draft: d, discard: false });
  });

  it('expires a draft at exactly 60 minutes, and says to delete it', () => {
    expect(parseDraft(JSON.stringify(draft()), SEASON, NOW + DRAFT_TTL_MS)).toEqual({ draft: null, discard: true });
  });

  it('ignores and deletes corrupt JSON and the wrong shape', () => {
    for (const raw of ['{not json', 'null', '[]', JSON.stringify({ ...draft(), v: 2 }), JSON.stringify({ ...draft(), decisions: null })]) {
      expect(parseDraft(raw, SEASON, NOW)).toEqual({ draft: null, discard: true });
    }
  });

  it('ignores a draft for another season without deleting it', () => {
    expect(parseDraft(JSON.stringify(draft({ seasonId: 's-2' })), SEASON, NOW)).toEqual({ draft: null, discard: false });
  });

  it('has nothing to say about an empty slot', () => {
    expect(parseDraft(null, SEASON, NOW)).toEqual({ draft: null, discard: false });
  });
});

describe('reapplyDecisions', () => {
  it('keeps a decision only where the row still exists and still offers it', () => {
    const fresh = preview({
      ambiguous: [{ raw: 'Jane Doe', reason: '2 members have this name.', candidates: [candidate('a'), candidate('b')] }],
      notFound: [
        { raw: 'J. Doe', name: 'J. Doe', email: null, amountCents: null, possibleMembers: [candidate('j')] },
        { raw: 'Robin Park', name: 'Robin Park', email: null, amountCents: 2500, possibleMembers: [] },
      ],
      namedMatches: [{ feeId: 'f-1', manualName: 'JD', amountCents: 2500, paidAt: null, candidates: [] }],
    });
    const out = reapplyDecisions(fresh, {
      choices: {
        'Jane Doe': 'b',
        'J. Doe': 'x', // no longer a candidate
        'Robin Park': 'keep',
        'Sam Lee': 'skip', // the row is gone: someone marked Sam meanwhile
      },
      keep: {
        'Robin Park': { name: 'Robin Park', email: 'robin@gmail.com', amount: '25' },
        'Jane Doe': { name: 'Jane Doe', email: '', amount: '' }, // not a not-found row any more
      },
      dismissed: ['f-1', 'f-2'],
    });
    expect(out).toEqual({
      choices: { 'Jane Doe': 'b', 'Robin Park': 'keep' },
      keep: { 'Robin Park': { name: 'Robin Park', email: 'robin@gmail.com', amount: '25' } },
      dismissed: ['f-1'],
    });
  });

  it('does not carry keep onto an ambiguous row, which cannot be kept', () => {
    const fresh = preview({
      ambiguous: [{ raw: 'Jane Doe', reason: 'x', candidates: [candidate('a')] }],
    });
    expect(reapplyDecisions(fresh, { choices: { 'Jane Doe': 'keep' }, keep: {}, dismissed: [] }).choices).toEqual({});
  });
});

describe('draft storage', () => {
  it('saves, loads and clears one draft per season', () => {
    const storage = memoryStorage();
    saveDraft(storage, draft());
    saveDraft(storage, draft({ seasonId: 's-2', text: 'Sam Lee' }));
    expect(loadDraft(storage, SEASON, NOW)?.text).toBe('Jane Doe');
    expect(loadDraft(storage, 's-2', NOW)?.text).toBe('Sam Lee');
    clearDraft(storage, SEASON);
    expect(storage.data.has(draftKey(SEASON))).toBe(false);
    expect(storage.data.has(draftKey('s-2'))).toBe(true);
  });

  it('deletes an expired draft on read', () => {
    const storage = memoryStorage({ [draftKey(SEASON)]: JSON.stringify(draft()) });
    expect(loadDraft(storage, SEASON, NOW + DRAFT_TTL_MS)).toBeNull();
    expect(storage.data.size).toBe(0);
  });

  it('deletes corrupt JSON on read', () => {
    const storage = memoryStorage({ [draftKey(SEASON)]: '{oops' });
    expect(loadDraft(storage, SEASON, NOW)).toBeNull();
    expect(storage.data.size).toBe(0);
  });

  it('sweeps every expired or unreadable draft, of any season, and nothing else', () => {
    const storage = memoryStorage({
      [draftKey('old')]: JSON.stringify(draft({ seasonId: 'old', savedAt: NOW - DRAFT_TTL_MS })),
      [draftKey('bad')]: 'nope',
      [draftKey('live')]: JSON.stringify(draft({ seasonId: 'live' })),
      'something-else': 'keep me',
    });
    sweepDrafts(storage, NOW);
    expect([...storage.data.keys()].sort()).toEqual([draftKey('live'), 'something-else']);
  });

  it('works without storage at all, blocked or absent', () => {
    for (const storage of [blockedStorage, null]) {
      expect(() => saveDraft(storage, draft())).not.toThrow();
      expect(loadDraft(storage, SEASON, NOW)).toBeNull();
      expect(() => clearDraft(storage, SEASON)).not.toThrow();
      expect(() => sweepDrafts(storage, NOW)).not.toThrow();
    }
  });
});
