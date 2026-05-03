'use client';

export default function Error({ error, reset }: { error: Error; reset: () => void }) {
  return (
    <div style={{ padding: '36px 48px' }}>
      <div
        style={{
          background: 'var(--surface1)',
          border: '1px solid rgba(204,0,0,0.25)',
          padding: 28,
          maxWidth: 640,
        }}
      >
        <div
          style={{
            fontSize: 10,
            letterSpacing: '0.2em',
            textTransform: 'uppercase',
            color: 'var(--red)',
            fontWeight: 700,
          }}
        >
          Something went wrong
        </div>
        <h2
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 700,
            fontSize: 32,
            marginTop: 10,
            color: 'var(--ink)',
            letterSpacing: '-0.01em',
          }}
        >
          We hit a snag loading this page.
        </h2>
        <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 12, lineHeight: 1.6 }}>
          {error?.message ?? 'An unknown error occurred.'}
        </p>
        <button
          type="button"
          onClick={reset}
          style={{
            marginTop: 22,
            background: 'var(--red)',
            color: '#F2F2F2',
            border: 0,
            padding: '10px 18px',
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
