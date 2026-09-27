// TELLING AN E-TRANSFER RECEIPT FROM AN SFU REC ONE, FROM OCR TEXT.
//
// A member uploads a screenshot of how they paid and is not asked which way
// that was. The browser runs OCR over it and this makes a guess from the text:
// an Interac e-Transfer confirmation, or a receipt from the SFU Rec website.
// The guess is stored on the submission as a hint the exec checks; when it
// cannot tell, it says so (null) and the exec picks.
//
// THE FORMATS ARE UNVERIFIED, as in ./etransfer-reference.ts: every bank lays
// its confirmation out differently, and none of the fixtures in the tests is a
// real screenshot. So only words that belong to one side count as strong.
// "SFU" alone does not: it is in the club's own name, which is on an
// e-transfer confirmation as the recipient. Nor does "badminton".
//
// Dependency-free, so the client form and the server action share it.

export const RECEIPT_METHODS = ['e_transfer', 'sfu_rec'] as const;

export type ReceiptMethod = (typeof RECEIPT_METHODS)[number];

export function isReceiptMethod(value: unknown): value is ReceiptMethod {
  return typeof value === 'string' && (RECEIPT_METHODS as readonly string[]).includes(value);
}

const ETRANSFER_STRONG = [
  /\binterac\b/i,
  /\be-?\s?transfer/i,
  /\bvirement\b/i,
  /auto-?deposit/i,
  /security question/i,
];

// The SFU Rec website runs Innosoft Fusion ("Powered By Fusion").
const SFU_REC_STRONG = [
  /athletics\s*(?:and|&)\s*recreation/i,
  /\bsfu\s*rec(?:reation)?\b/i,
  /powered by fusion|innosoft/i,
];

// A card purchase. Any one could turn up anywhere; two different ones and no
// e-transfer word is a card receipt.
const SFU_REC_WEAK = [
  /\bvisa\b/i,
  /\bmastercard\b/i,
  /\bamex\b/i,
  /card ending/i,
  /\*{2,}\s?\d{4}/,
  /\border\s*(?:#|number|no\b)/i,
  /\breceipt\s*(?:#|number|no\b)/i,
];

const hits = (text: string, patterns: RegExp[]) => patterns.filter((p) => p.test(text)).length;

/** 'e_transfer', 'sfu_rec', or null when the text does not say. Never throws. */
export function classifyReceiptText(text: string | null | undefined): ReceiptMethod | null {
  if (typeof text !== 'string' || !text.trim()) return null;
  const etransfer = hits(text, ETRANSFER_STRONG);
  const sfuRec = hits(text, SFU_REC_STRONG);
  if (etransfer > 0 && sfuRec === 0) return 'e_transfer';
  if (sfuRec > 0 && etransfer === 0) return 'sfu_rec';
  if (etransfer > 0 && sfuRec > 0) return null;
  return hits(text, SFU_REC_WEAK) >= 2 ? 'sfu_rec' : null;
}
