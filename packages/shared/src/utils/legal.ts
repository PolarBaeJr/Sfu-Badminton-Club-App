import type { WaiverDocument } from '../types/database';

// A waiver acceptance is only good for a year — the club requires an annual
// re-signature. The other documents stay accepted until their version bumps.
export const WAIVER_VALIDITY_DAYS = 365;

// Display order wherever the documents are listed together for acceptance
// (waiver gate, onboarding, public /legal pages).
export const LEGAL_DOCUMENT_ORDER: WaiverDocument[] = [
  'terms_of_use',
  'privacy_policy',
  'waiver',
  'code_of_conduct',
];

export const LEGAL_DOCUMENT_LABELS: Record<WaiverDocument, string> = {
  terms_of_use: 'Terms of Use',
  privacy_policy: 'Privacy & Data Retention Policy',
  waiver: 'Liability Waiver & Assumption of Risk',
  code_of_conduct: 'Code of Conduct',
};

// Public URL slug for each document. The documents are keyed by their database
// enum everywhere else, but those names are not what belongs in a link a member
// reads or a regulator follows, so /legal/privacy resolves to privacy_policy.
// Kept here rather than in the page that renders them because the footer, the
// index and the document page all have to agree on one spelling.
export const LEGAL_DOCUMENT_SLUGS: Record<WaiverDocument, string> = {
  terms_of_use: 'terms',
  privacy_policy: 'privacy',
  waiver: 'waiver',
  code_of_conduct: 'conduct',
};

// The inverse, built from the map above so the two can never drift apart.
export const SLUG_TO_LEGAL_DOCUMENT: Record<string, WaiverDocument> = Object.fromEntries(
  Object.entries(LEGAL_DOCUMENT_SLUGS).map(([document, slug]) => [slug, document as WaiverDocument])
) as Record<string, WaiverDocument>;

// Short label for the footer and the index. LEGAL_DOCUMENT_LABELS is the formal
// title ("Liability Waiver & Assumption of Risk") — correct at the top of the
// document itself, too long for a row of links.
export const LEGAL_DOCUMENT_SHORT_LABELS: Record<WaiverDocument, string> = {
  terms_of_use: 'Terms of Use',
  privacy_policy: 'Privacy Policy',
  waiver: 'Liability Waiver',
  code_of_conduct: 'Code of Conduct',
};

// Sort fetched legal_documents rows into LEGAL_DOCUMENT_ORDER.
export function sortLegalDocuments<T extends { document: string }>(docs: T[]): T[] {
  return [...docs].sort(
    (a, b) =>
      LEGAL_DOCUMENT_ORDER.indexOf(a.document as WaiverDocument) -
      LEGAL_DOCUMENT_ORDER.indexOf(b.document as WaiverDocument)
  );
}

// Which season's event-waiver template an event should start from (00074).
//
// An existing tournament uses ITS OWN season, not the active one: editing a
// tournament left over from last term must not silently offer this term's
// venue and insurer wording. A tournament being created has no season row yet
// — createTournament stamps the active season — so the active season is the
// answer there, and also the fallback for a tournament whose season_id is NULL
// (seasons.id is ON DELETE SET NULL, and createTournament writes NULL when no
// season is active).
//
// Returns null when there is nothing to offer, which the caller shows as a
// disabled button rather than pasting an empty waiver into the box.
export function resolveEventWaiverTemplate(
  templates: { season_id: string; content: string }[],
  tournamentSeasonId: string | null | undefined,
  activeSeasonId: string | null | undefined
): string | null {
  const seasonId = tournamentSeasonId ?? activeSeasonId;
  if (!seasonId) return null;
  return templates.find((t) => t.season_id === seasonId)?.content ?? null;
}

// The single source of truth for acceptance validity, shared by the player
// gate (assertCurrentWaiver, the layout's needsWaiver) and the admin players
// table's Waiver column so the three call sites can't drift:
// - 'waiver': needs a current-version acceptance no older than
//   WAIVER_VALIDITY_DAYS (the most recent row counts — acceptances are
//   append-only, annual renewal adds a new row).
// - every other document: needs a current-version acceptance, any age.
// - any document: an admin can force re-acceptance by stamping
//   reacceptance_required_since; a member's latest acceptance must post-date
//   it. For the waiver, playerWaiverResetAt does the same for a single member.
// Returns the document keys the player still has to accept.
export function getMissingLegalDocuments(
  docs: { document: string; version: string; reacceptance_required_since?: string | null }[],
  acceptances: { document: string; version: string; accepted_at: string }[],
  now: Date = new Date(),
  playerWaiverResetAt?: string | null
): WaiverDocument[] {
  const missing: WaiverDocument[] = [];
  for (const doc of docs) {
    const current = acceptances.filter(
      (a) => a.document === doc.document && a.version === doc.version
    );
    let valid = current.length > 0;
    if (valid) {
      const latest = Math.max(...current.map((a) => new Date(a.accepted_at).getTime()));
      if (doc.document === 'waiver') {
        valid = now.getTime() - latest <= WAIVER_VALIDITY_DAYS * 24 * 60 * 60 * 1000;
      }
      // Forced re-acceptance: the latest acceptance must post-date the
      // threshold. reacceptance_required_since applies to any document; the
      // per-player waiver_reset_at additionally forces the waiver.
      let threshold: number | null = doc.reacceptance_required_since
        ? new Date(doc.reacceptance_required_since).getTime()
        : null;
      if (doc.document === 'waiver' && playerWaiverResetAt) {
        const reset = new Date(playerWaiverResetAt).getTime();
        threshold = threshold === null ? reset : Math.max(threshold, reset);
      }
      if (valid && threshold !== null && latest < threshold) valid = false;
    }
    if (!valid) missing.push(doc.document as WaiverDocument);
  }
  return missing;
}
