import { describe, it, expect } from 'vitest';
import { getMissingLegalDocuments } from '@badminton/shared';
import {
  buildMemberSignatureRows,
  escapeLike,
  guestSearchFilter,
  matchesSignatureSearch,
  type Acceptance,
  type MemberSignatureRow,
  type SignatureDoc,
  type SignatureMemberInput,
} from '../legal-signatures';

// The pure half of /legal/signatures. What these pin is that "Current" means
// exactly what the player app's gate means, since an exec reads this page to
// decide who to chase, and that the search only ever matches what is on screen.

const NOW = new Date('2026-09-27T12:00:00Z');
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 60 * 60 * 1000).toISOString();

const DOCS: SignatureDoc[] = [
  { document: 'terms_of_use', version: '2026-07-01', reacceptance_required_since: null },
  { document: 'privacy_policy', version: '2026-07-01', reacceptance_required_since: null },
  { document: 'waiver', version: '2026-07-01', reacceptance_required_since: null },
  { document: 'code_of_conduct', version: '2026-07-01', reacceptance_required_since: null },
];

function member(acceptances: Acceptance[] | null, extra: Partial<SignatureMemberInput> = {}): SignatureMemberInput {
  return { id: 'p1', full_name: 'Ann Lee', waiver_reset_at: null, waiver_acceptances: acceptances, ...extra };
}

// One member in, one row out.
function buildOne(docs: SignatureDoc[], members: SignatureMemberInput[], now: Date): MemberSignatureRow {
  const [row] = buildMemberSignatureRows(docs, members, now);
  if (!row) throw new Error('no row');
  return row;
}

function cell(row: MemberSignatureRow, document: string) {
  const found = row.documents.find((d) => d.document === document);
  if (!found) throw new Error(`no cell for ${document}`);
  return found;
}

describe('buildMemberSignatureRows', () => {
  it('reports a document never signed as unsigned, with nothing to show', () => {
    const row = buildOne(DOCS, [member([])], NOW);
    for (const d of row.documents) {
      expect(d).toEqual({ document: d.document, lastVersion: null, lastSignedAt: null, status: 'unsigned' });
    }
    expect(row.lastSignedAt).toBeNull();
  });

  it('reports the current version signed recently as current', () => {
    const at = daysAgo(10);
    const row = buildOne(DOCS, [member([{ document: 'waiver', version: '2026-07-01', accepted_at: at }])], NOW);
    expect(cell(row, 'waiver')).toEqual({ document: 'waiver', lastVersion: '2026-07-01', lastSignedAt: at, status: 'current' });
  });

  it('expires the waiver after a year but not the terms', () => {
    const at = daysAgo(366);
    const row = buildOne(
      DOCS,
      [
        member([
          { document: 'waiver', version: '2026-07-01', accepted_at: at },
          { document: 'terms_of_use', version: '2026-07-01', accepted_at: at },
        ]),
      ],
      NOW
    );
    expect(cell(row, 'waiver')).toMatchObject({ lastVersion: '2026-07-01', status: 'outdated' });
    expect(cell(row, 'terms_of_use')).toMatchObject({ lastVersion: '2026-07-01', status: 'current' });
  });

  it('shows the newest version signed when it is behind the current one', () => {
    const docs: SignatureDoc[] = [{ document: 'terms_of_use', version: 'v3', reacceptance_required_since: null }];
    const row = buildOne(
      docs,
      [
        member([
          { document: 'terms_of_use', version: 'v2', accepted_at: daysAgo(20) },
          { document: 'terms_of_use', version: 'v1', accepted_at: daysAgo(200) },
        ]),
      ],
      NOW
    );
    expect(cell(row, 'terms_of_use')).toMatchObject({ lastVersion: 'v2', lastSignedAt: daysAgo(20), status: 'outdated' });
  });

  it('marks a signature older than a forced re-acceptance as outdated', () => {
    const docs: SignatureDoc[] = [
      { document: 'code_of_conduct', version: '2026-07-01', reacceptance_required_since: daysAgo(5) },
    ];
    const row = buildOne(
      docs,
      [member([{ document: 'code_of_conduct', version: '2026-07-01', accepted_at: daysAgo(10) }])],
      NOW
    );
    expect(cell(row, 'code_of_conduct').status).toBe('outdated');
  });

  it('lets a per-member waiver reset outdate the waiver and nothing else', () => {
    const at = daysAgo(10);
    const row = buildOne(
      DOCS,
      [
        member(
          [
            { document: 'waiver', version: '2026-07-01', accepted_at: at },
            { document: 'privacy_policy', version: '2026-07-01', accepted_at: at },
          ],
          { waiver_reset_at: daysAgo(5) }
        ),
      ],
      NOW
    );
    expect(cell(row, 'waiver').status).toBe('outdated');
    expect(cell(row, 'privacy_policy').status).toBe('current');
  });

  it('handles null acceptances and a null name', () => {
    const row = buildOne(DOCS, [member(null, { full_name: null })], NOW);
    expect(row.name).toBe('');
    expect(row.documents.every((d) => d.status === 'unsigned')).toBe(true);
  });

  it('keeps the documents in the order given and takes the newest signing overall', () => {
    const newest = daysAgo(3);
    const row = buildOne(
      DOCS,
      [
        member([
          { document: 'code_of_conduct', version: '2026-07-01', accepted_at: daysAgo(30) },
          { document: 'privacy_policy', version: '2026-07-01', accepted_at: newest },
          { document: 'terms_of_use', version: '2026-07-01', accepted_at: daysAgo(60) },
        ]),
      ],
      NOW
    );
    expect(row.documents.map((d) => d.document)).toEqual(DOCS.map((d) => d.document));
    expect(row.lastSignedAt).toBe(newest);
  });

  it('calls a cell current exactly when the shared gate finds nothing missing', () => {
    const cases: SignatureMemberInput[] = [
      member([]),
      member([{ document: 'waiver', version: '2026-07-01', accepted_at: daysAgo(10) }]),
      member([{ document: 'waiver', version: '2026-07-01', accepted_at: daysAgo(400) }]),
      member([{ document: 'waiver', version: 'old', accepted_at: daysAgo(10) }]),
      member([{ document: 'waiver', version: '2026-07-01', accepted_at: daysAgo(10) }], { waiver_reset_at: daysAgo(1) }),
      member([{ document: 'terms_of_use', version: '2026-07-01', accepted_at: daysAgo(900) }]),
    ];
    for (const m of cases) {
      const row = buildOne(DOCS, [m], NOW);
      for (const doc of DOCS) {
        const missing = getMissingLegalDocuments([doc], m.waiver_acceptances ?? [], NOW, m.waiver_reset_at);
        expect(cell(row, doc.document).status === 'current').toBe(missing.length === 0);
      }
    }
  });
});

describe('matchesSignatureSearch', () => {
  const row = buildOne(
    [{ document: 'terms_of_use', version: '2026-07-01', reacceptance_required_since: null }],
    [
      member([
        { document: 'terms_of_use', version: '2026-07-01', accepted_at: daysAgo(10) },
        { document: 'terms_of_use', version: '2025-01-15', accepted_at: daysAgo(400) },
      ]),
    ],
    NOW
  );

  it('matches everything on an empty or blank query', () => {
    expect(matchesSignatureSearch(row, '')).toBe(true);
    expect(matchesSignatureSearch(row, '   ')).toBe(true);
  });

  it('matches the name case-insensitively', () => {
    expect(matchesSignatureSearch(row, 'aNN')).toBe(true);
  });

  it('matches the version last signed', () => {
    expect(matchesSignatureSearch(row, '2026-07')).toBe(true);
  });

  it('does not match a version only in an older signing', () => {
    expect(matchesSignatureSearch(row, '2025-01')).toBe(false);
  });

  it('does not match anything else', () => {
    expect(matchesSignatureSearch(row, 'zed')).toBe(false);
  });
});

describe('guestSearchFilter', () => {
  it('searches the name and both versions', () => {
    expect(guestSearchFilter('Ann')).toBe(
      'full_name.ilike."%Ann%",waiver_version.ilike."%Ann%",privacy_version.ilike."%Ann%"'
    );
  });

  it('escapes wildcards, backslashes and quotes, and keeps commas and parens inside the quotes', () => {
    const v = String.raw`O'Neil, (Jr.) \"A\" 50\\%\\_\\\\`;
    expect(guestSearchFilter('O\'Neil, (Jr.) "A" 50%_\\')).toBe(
      `full_name.ilike."%${v}%",waiver_version.ilike."%${v}%",privacy_version.ilike."%${v}%"`
    );
  });
});

describe('escapeLike', () => {
  it('escapes the backslash and both wildcards', () => {
    expect(escapeLike(String.raw`a\b%c_d`)).toBe(String.raw`a\\b\%c\_d`);
  });
});
