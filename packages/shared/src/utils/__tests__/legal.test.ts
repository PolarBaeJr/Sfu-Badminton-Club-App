import { describe, it, expect } from 'vitest';
import { getMissingLegalDocuments, sortLegalDocuments, LEGAL_DOCUMENT_ORDER } from '../legal';

const DOCS = [
  { document: 'waiver', version: '2026-07-19' },
  { document: 'code_of_conduct', version: '2026-07-19' },
  { document: 'terms_of_use', version: '2026-07-19' },
  { document: 'privacy_policy', version: '2026-07-19' },
];

const NOW = new Date('2026-07-19T12:00:00Z');

function accepted(document: string, version = '2026-07-19', accepted_at = '2026-07-01T00:00:00Z') {
  return { document, version, accepted_at };
}

describe('getMissingLegalDocuments', () => {
  it('returns every document when nothing is accepted', () => {
    expect(getMissingLegalDocuments(DOCS, [], NOW)).toEqual([
      'waiver',
      'code_of_conduct',
      'terms_of_use',
      'privacy_policy',
    ]);
  });

  it('returns nothing when all four are currently accepted', () => {
    const acceptances = DOCS.map((d) => accepted(d.document));
    expect(getMissingLegalDocuments(DOCS, acceptances, NOW)).toEqual([]);
  });

  it('flags a document accepted under an outdated version', () => {
    const acceptances = [
      accepted('waiver'),
      accepted('code_of_conduct', '2025-01-01'),
      accepted('terms_of_use'),
      accepted('privacy_policy'),
    ];
    expect(getMissingLegalDocuments(DOCS, acceptances, NOW)).toEqual(['code_of_conduct']);
  });

  it('flags a current-version waiver accepted more than a year ago', () => {
    const acceptances = [
      accepted('waiver', '2026-07-19', '2025-06-01T00:00:00Z'),
      accepted('code_of_conduct'),
      accepted('terms_of_use'),
      accepted('privacy_policy'),
    ];
    expect(getMissingLegalDocuments(DOCS, acceptances, NOW)).toEqual(['waiver']);
  });

  it('counts the most recent waiver row — a renewal resets the year', () => {
    const acceptances = [
      accepted('waiver', '2026-07-19', '2025-06-01T00:00:00Z'),
      accepted('waiver', '2026-07-19', '2026-06-01T00:00:00Z'),
      accepted('code_of_conduct'),
      accepted('terms_of_use'),
      accepted('privacy_policy'),
    ];
    expect(getMissingLegalDocuments(DOCS, acceptances, NOW)).toEqual([]);
  });

  it('does not age out the other documents', () => {
    const acceptances = [
      accepted('waiver'),
      accepted('code_of_conduct', '2026-07-19', '2020-01-01T00:00:00Z'),
      accepted('terms_of_use', '2026-07-19', '2020-01-01T00:00:00Z'),
      accepted('privacy_policy', '2026-07-19', '2020-01-01T00:00:00Z'),
    ];
    expect(getMissingLegalDocuments(DOCS, acceptances, NOW)).toEqual([]);
  });
});

describe('sortLegalDocuments', () => {
  it('orders rows terms, privacy, waiver, code of conduct', () => {
    expect(sortLegalDocuments(DOCS).map((d) => d.document)).toEqual(LEGAL_DOCUMENT_ORDER);
  });
});
