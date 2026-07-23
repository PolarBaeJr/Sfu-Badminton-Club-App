import { describe, it, expect } from 'vitest';
import { getMissingLegalDocuments, sortLegalDocuments, LEGAL_DOCUMENT_ORDER } from '../legal';

const DOCS = [
  { document: 'waiver', version: '2026-07-19', reacceptance_required_since: null },
  { document: 'code_of_conduct', version: '2026-07-19', reacceptance_required_since: null },
  { document: 'terms_of_use', version: '2026-07-19', reacceptance_required_since: null },
  { document: 'privacy_policy', version: '2026-07-19', reacceptance_required_since: null },
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

  it('flags a document when reacceptance_required_since is after the last acceptance', () => {
    const docs = DOCS.map((d) =>
      d.document === 'code_of_conduct'
        ? { ...d, reacceptance_required_since: '2026-07-10T00:00:00Z' }
        : d
    );
    // Everyone accepted 2026-07-01 — before the 2026-07-10 threshold.
    const acceptances = DOCS.map((d) => accepted(d.document));
    expect(getMissingLegalDocuments(docs, acceptances, NOW)).toEqual(['code_of_conduct']);
  });

  it('clears a forced re-accept once re-accepted after the threshold', () => {
    const docs = DOCS.map((d) =>
      d.document === 'code_of_conduct'
        ? { ...d, reacceptance_required_since: '2026-07-10T00:00:00Z' }
        : d
    );
    const acceptances = [
      accepted('waiver'),
      accepted('code_of_conduct', '2026-07-19', '2026-07-15T00:00:00Z'),
      accepted('terms_of_use'),
      accepted('privacy_policy'),
    ];
    expect(getMissingLegalDocuments(docs, acceptances, NOW)).toEqual([]);
  });

  it('forces re-acceptance of a non-waiver document', () => {
    const docs = DOCS.map((d) =>
      d.document === 'terms_of_use'
        ? { ...d, reacceptance_required_since: '2026-07-10T00:00:00Z' }
        : d
    );
    const acceptances = DOCS.map((d) => accepted(d.document));
    expect(getMissingLegalDocuments(docs, acceptances, NOW)).toEqual(['terms_of_use']);
  });

  it('per-player waiver_reset_at forces only the waiver to be re-signed', () => {
    const acceptances = DOCS.map((d) => accepted(d.document));
    expect(
      getMissingLegalDocuments(DOCS, acceptances, NOW, '2026-07-10T00:00:00Z')
    ).toEqual(['waiver']);
  });

  it('clears a per-player waiver reset once re-signed after the reset', () => {
    const acceptances = [
      accepted('waiver', '2026-07-19', '2026-07-15T00:00:00Z'),
      accepted('code_of_conduct'),
      accepted('terms_of_use'),
      accepted('privacy_policy'),
    ];
    expect(
      getMissingLegalDocuments(DOCS, acceptances, NOW, '2026-07-10T00:00:00Z')
    ).toEqual([]);
  });

  it('waiver must beat the later of global reacceptance (T1) and player reset (T2) when T2 > T1', () => {
    const docs = DOCS.map((d) =>
      d.document === 'waiver'
        ? { ...d, reacceptance_required_since: '2026-07-05T00:00:00Z' } // T1
        : d
    );
    // Accepted 2026-07-08 — after T1 but before the later T2 (2026-07-12).
    const between = [
      accepted('waiver', '2026-07-19', '2026-07-08T00:00:00Z'),
      accepted('code_of_conduct'),
      accepted('terms_of_use'),
      accepted('privacy_policy'),
    ];
    expect(getMissingLegalDocuments(docs, between, NOW, '2026-07-12T00:00:00Z')).toEqual(['waiver']);
    // Accepted 2026-07-15 — after the later T2.
    const after = [
      accepted('waiver', '2026-07-19', '2026-07-15T00:00:00Z'),
      accepted('code_of_conduct'),
      accepted('terms_of_use'),
      accepted('privacy_policy'),
    ];
    expect(getMissingLegalDocuments(docs, after, NOW, '2026-07-12T00:00:00Z')).toEqual([]);
  });

  it('waiver threshold is the later global reacceptance (T1) when T1 > T2', () => {
    const docs = DOCS.map((d) =>
      d.document === 'waiver'
        ? { ...d, reacceptance_required_since: '2026-07-12T00:00:00Z' } // T1
        : d
    );
    // Accepted 2026-07-08 — after T2 (2026-07-05) but before the later T1.
    const between = [
      accepted('waiver', '2026-07-19', '2026-07-08T00:00:00Z'),
      accepted('code_of_conduct'),
      accepted('terms_of_use'),
      accepted('privacy_policy'),
    ];
    expect(getMissingLegalDocuments(docs, between, NOW, '2026-07-05T00:00:00Z')).toEqual(['waiver']);
  });

  it('returns an empty array when there are no documents', () => {
    expect(getMissingLegalDocuments([], [], NOW)).toEqual([]);
  });
});

describe('sortLegalDocuments', () => {
  it('orders rows terms, privacy, waiver, code of conduct', () => {
    expect(sortLegalDocuments(DOCS).map((d) => d.document)).toEqual(LEGAL_DOCUMENT_ORDER);
  });
});
