import { getMissingLegalDocuments } from '@badminton/shared';

export type SignatureDoc = {
  document: string;
  version: string;
  reacceptance_required_since: string | null;
};

export type Acceptance = { document: string; version: string; accepted_at: string };

export type SignatureMemberInput = {
  id: string;
  full_name: string | null;
  waiver_reset_at: string | null;
  waiver_acceptances: Acceptance[] | null;
};

export type SignatureStatus = 'current' | 'outdated' | 'unsigned';

export type DocumentSignature = {
  document: string;
  lastVersion: string | null;
  lastSignedAt: string | null;
  status: SignatureStatus;
};

export type MemberSignatureRow = {
  id: string;
  name: string;
  documents: DocumentSignature[];
  lastSignedAt: string | null;
};

// One row per member, one cell per document in the order given. "Current" is
// decided by the SHARED helper rather than by comparing versions here, so it
// stays identical to the player app's gate: the waiver expires after a year,
// reacceptance_required_since invalidates anything older than its stamp, and
// waiver_reset_at does the same for one member. A member marked current here
// is exactly a member the player app lets through.
export function buildMemberSignatureRows(
  docs: SignatureDoc[],
  members: SignatureMemberInput[],
  now: Date
): MemberSignatureRow[] {
  return members.map((member) => {
    const acceptances = member.waiver_acceptances ?? [];
    const documents = docs.map((doc): DocumentSignature => {
      const forDoc = acceptances.filter((a) => a.document === doc.document);
      const latest = forDoc.reduce<Acceptance | null>(
        (best, a) => (best === null || new Date(a.accepted_at) > new Date(best.accepted_at) ? a : best),
        null
      );
      let status: SignatureStatus = 'unsigned';
      if (latest) {
        status =
          getMissingLegalDocuments([doc], acceptances, now, member.waiver_reset_at).length === 0
            ? 'current'
            : 'outdated';
      }
      return {
        document: doc.document,
        lastVersion: latest?.version ?? null,
        lastSignedAt: latest?.accepted_at ?? null,
        status,
      };
    });
    const lastSignedAt = documents.reduce<string | null>(
      (best, d) =>
        d.lastSignedAt !== null && (best === null || new Date(d.lastSignedAt) > new Date(best))
          ? d.lastSignedAt
          : best,
      null
    );
    return { id: member.id, name: member.full_name ?? '', documents, lastSignedAt };
  });
}

// Matches the name or the version each member LAST signed, not every version
// they ever signed: the table shows only the last one, and a row matching on a
// version nowhere on screen would look like a broken search.
export function matchesSignatureSearch(row: MemberSignatureRow, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  if (row.name.toLowerCase().includes(needle)) return true;
  return row.documents.some((d) => d.lastVersion !== null && d.lastVersion.toLowerCase().includes(needle));
}

// ilike treats % and _ as wildcards and \ as their escape.
export function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

// The external signings search, as a PostgREST .or() string over the name and
// both versions. Each value is double-quoted because a name can contain , . ( )
// which PostgREST reserves inside .or(); inside the quotes \ and " must be
// backslash-escaped. escapeLike runs first so a typed % or _ stays literal.
export function guestSearchFilter(q: string): string {
  const v = escapeLike(q).replace(/[\\"]/g, (c) => `\\${c}`);
  return `full_name.ilike."%${v}%",waiver_version.ilike."%${v}%",privacy_version.ilike."%${v}%"`;
}
