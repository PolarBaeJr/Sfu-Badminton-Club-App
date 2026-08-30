import Link from 'next/link';
import { LEGAL_DOCUMENT_ORDER, LEGAL_DOCUMENT_SLUGS, LEGAL_DOCUMENT_SHORT_LABELS } from '@badminton/shared';

// Sits at the bottom of every page, inside <main> so it clears the fixed bottom
// nav via the same .pb-safe-nav padding the page content uses.
//
// Static on purpose: the links are derived from LEGAL_DOCUMENT_ORDER, not from
// a query, so this stays a server component with no database round trip on
// every single page render. A document with no row yet 404s on click, which is
// the honest outcome and one an admin fixes by publishing it.
export function LegalFooter() {
  return (
    <footer
      style={{
        marginTop: 48,
        paddingTop: 20,
        borderTop: '1px solid var(--line)',
        display: 'flex',
        flexWrap: 'wrap',
        alignItems: 'center',
        justifyContent: 'center',
        gap: '4px 14px',
        textAlign: 'center',
      }}
    >
      {LEGAL_DOCUMENT_ORDER.map((document) => (
        <Link
          key={document}
          href={`/legal/${LEGAL_DOCUMENT_SLUGS[document]}`}
          className="muted"
          style={{ fontSize: 12, textDecoration: 'none' }}
        >
          {LEGAL_DOCUMENT_SHORT_LABELS[document]}
        </Link>
      ))}
      <span className="muted" style={{ fontSize: 12, width: '100%', marginTop: 4 }}>
        SFU Badminton Club · Lorne Davies Complex
      </span>
    </footer>
  );
}
