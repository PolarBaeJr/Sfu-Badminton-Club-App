'use client';

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div style={{ padding: '32px 24px' }}>
      <div
        style={{
          background: 'var(--bg-card)',
          border: '1px solid var(--red-border)',
          padding: 24,
        }}
      >
        <div
          style={{
            fontSize: 10,
            letterSpacing: '0.18em',
            textTransform: 'uppercase',
            color: 'var(--red)',
            fontWeight: 700,
          }}
        >
          Something went wrong
        </div>
        <div style={{ fontSize: 18, fontWeight: 700, marginTop: 8, color: 'var(--ink)' }}>
          We hit a snag loading this page.
        </div>
        <p style={{ fontSize: 12, color: 'var(--text-secondary)', marginTop: 10, lineHeight: 1.5 }}>
          {error?.message ?? 'An unknown error occurred.'}
        </p>
        <button
          type="button"
          onClick={reset}
          style={{
            marginTop: 18,
            background: 'var(--red)',
            color: '#fff',
            border: 0,
            padding: '10px 16px',
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: '0.16em',
            textTransform: 'uppercase',
            cursor: 'pointer',
            fontFamily: 'inherit',
          }}
        >
          Retry
        </button>
      </div>
    </div>
  );
}
