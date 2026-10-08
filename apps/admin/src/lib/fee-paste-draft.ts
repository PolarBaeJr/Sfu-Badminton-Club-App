// The unsent "Paste a list" dialog, kept for an hour.
//
// An exec who closes the dialog, reloads, or is navigated away half way through
// a thirty-line e-transfer export should not have to paste and decide it all
// again. So the dialog's work is written to localStorage, one key per season,
// and restored when it is opened again within the hour.
//
// PRIVACY. A draft holds member names and emails (the pasted text, and the
// matched names in the preview) in this browser's storage. That is why it is
// bounded: a draft older than an hour is deleted the next time the console
// reads it, every expired draft of every season is swept whenever the "Paste a
// list" button renders (the /fees tab, for an officer who may mark fees paid),
// and a confirmed list or "Start over" deletes it at once. A draft for a season
// nobody opens again lingers in this browser until that button next renders.
//
// NOT a 'use server' module and no React: the rules here are tested without a
// browser, and every storage call is wrapped, so private mode or blocked
// storage makes the dialog forget and nothing else.

import type { FeePastePreview } from './fee-paste';

export const DRAFT_TTL_MS = 60 * 60 * 1000;
export const DRAFT_PREFIX = 'fees-paste-draft:';
const DRAFT_VERSION = 1;

export interface PasteKeepFields {
  name: string;
  email: string;
  /** Dollars as typed. Blank means the batch price. */
  amount: string;
}

/** What the exec decided on the Review step, keyed so it survives a re-check. */
export interface PasteDecisions {
  /** By pasted line: a candidate's player id, 'keep', or 'skip'. */
  choices: Record<string, string>;
  /** By pasted line: the fields of a row being kept as a named payment. */
  keep: Record<string, PasteKeepFields>;
  /** Named payments the exec said were not the member offered. */
  dismissed: string[];
}

export interface FeePasteDraft {
  v: typeof DRAFT_VERSION;
  seasonId: string;
  savedAt: number;
  text: string;
  step: 'input' | 'preview';
  preview: FeePastePreview | null;
  decisions: PasteDecisions;
  method: string;
  customMethod: string;
  reference: string;
}

export type DraftStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem' | 'key' | 'length'>;

export const EMPTY_DECISIONS: PasteDecisions = { choices: {}, keep: {}, dismissed: [] };

export const draftKey = (seasonId: string) => `${DRAFT_PREFIX}${seasonId}`;

/** Exactly an hour old is expired. */
export function isDraftExpired(savedAt: number, now: number): boolean {
  return now - savedAt >= DRAFT_TTL_MS;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function isDraftShape(v: unknown): v is FeePasteDraft {
  if (!isRecord(v)) return false;
  const d = v.decisions;
  return (
    v.v === DRAFT_VERSION &&
    typeof v.seasonId === 'string' &&
    typeof v.savedAt === 'number' &&
    Number.isFinite(v.savedAt) &&
    typeof v.text === 'string' &&
    (v.step === 'input' || v.step === 'preview') &&
    (v.preview === null || (isRecord(v.preview) && Array.isArray(v.preview.willMark))) &&
    isRecord(d) &&
    isRecord(d.choices) &&
    isRecord(d.keep) &&
    Array.isArray(d.dismissed) &&
    typeof v.method === 'string' &&
    typeof v.customMethod === 'string' &&
    typeof v.reference === 'string'
  );
}

/**
 * Read one stored draft. `discard` says the stored value should be deleted:
 * it is unreadable, the wrong shape, or expired. A draft for another season is
 * ignored but left alone; it is that season's.
 */
export function parseDraft(
  raw: string | null,
  seasonId: string,
  now: number,
): { draft: FeePasteDraft | null; discard: boolean } {
  if (raw == null) return { draft: null, discard: false };
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { draft: null, discard: true };
  }
  if (!isDraftShape(value)) return { draft: null, discard: true };
  if (value.seasonId !== seasonId) return { draft: null, discard: false };
  if (isDraftExpired(value.savedAt, now)) return { draft: null, discard: true };
  return { draft: value, discard: false };
}

/**
 * Carry saved decisions onto a fresh preview of the same text. A decision
 * survives only where its row is still there and still offers it: somebody may
 * have marked a member paid or removed a named payment since the draft was
 * saved, and a choice made against the old list must not act on the new one.
 */
export function reapplyDecisions(preview: FeePastePreview, saved: PasteDecisions): PasteDecisions {
  const out: PasteDecisions = { choices: {}, keep: {}, dismissed: [] };
  const offers = new Map<string, { ids: Set<string>; canKeep: boolean }>();
  for (const a of preview.ambiguous) {
    offers.set(a.raw, { ids: new Set(a.candidates.map((c) => c.playerId)), canKeep: false });
  }
  for (const n of preview.notFound) {
    offers.set(n.raw, { ids: new Set(n.possibleMembers.map((c) => c.playerId)), canKeep: true });
  }
  for (const [raw, choice] of Object.entries(saved.choices)) {
    const offer = offers.get(raw);
    if (!offer) continue;
    if (choice === 'skip' || (choice === 'keep' && offer.canKeep) || offer.ids.has(choice)) {
      out.choices[raw] = choice;
    }
  }
  for (const [raw, fields] of Object.entries(saved.keep)) {
    if (offers.get(raw)?.canKeep) out.keep[raw] = fields;
  }
  const namedIds = new Set(preview.namedMatches.map((m) => m.feeId));
  out.dismissed = saved.dismissed.filter((id) => namedIds.has(id));
  return out;
}

// ─── STORAGE ──────────────────────────────────────────────────────────────────
//
// Every call is wrapped. A browser with storage blocked throws on access, and
// a full one throws on write; either way the dialog carries on without a draft.

export function loadDraft(storage: DraftStorage | null, seasonId: string, now: number): FeePasteDraft | null {
  if (!storage) return null;
  try {
    const { draft, discard } = parseDraft(storage.getItem(draftKey(seasonId)), seasonId, now);
    if (discard) storage.removeItem(draftKey(seasonId));
    return draft;
  } catch {
    return null;
  }
}

export function saveDraft(storage: DraftStorage | null, draft: FeePasteDraft): void {
  if (!storage) return;
  try {
    storage.setItem(draftKey(draft.seasonId), JSON.stringify(draft));
  } catch {
    // Nothing to do: the dialog works without a draft.
  }
}

export function clearDraft(storage: DraftStorage | null, seasonId: string): void {
  if (!storage) return;
  try {
    storage.removeItem(draftKey(seasonId));
  } catch {
    // As above.
  }
}

/** Delete every expired or unreadable draft, whichever season it was for. */
export function sweepDrafts(storage: DraftStorage | null, now: number): void {
  if (!storage) return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i);
      if (key?.startsWith(DRAFT_PREFIX)) keys.push(key);
    }
    for (const key of keys) {
      const { draft, discard } = parseDraft(storage.getItem(key), key.slice(DRAFT_PREFIX.length), now);
      if (discard || !draft) storage.removeItem(key);
    }
  } catch {
    // As above.
  }
}
