import React from 'react';
import { Dropdown } from '@badminton/ui';

// The menu only opens on trigger click and there is no controlled prop, so
// the preview auto-clicks the trigger on mount — capture is static and the
// menu portals to document.body as position:fixed, which the full-page
// screenshot still includes.
function AutoOpen({ children }: { children: React.ReactNode }) {
  const ref = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    ref.current?.querySelector<HTMLElement>('.cursor-pointer')?.click();
  }, []);
  return <div ref={ref}>{children}</div>;
}

const kebab = (
  <span style={{ fontSize: 18, lineHeight: 1, color: 'var(--text-muted)', letterSpacing: 2 }}>
    &#8942;
  </span>
);

export function MemberRowActions() {
  return (
    <div style={{ height: 300, maxWidth: 460 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 14px',
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 12,
        }}
      >
        <div>
          <p style={{ margin: 0, fontSize: 14, color: 'var(--text-primary)' }}>Priya Sandhu</p>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>
            ELO 612 &middot; Competitive
          </p>
        </div>
        <AutoOpen>
          <Dropdown
            trigger={kebab}
            items={[
              { label: 'View profile', onClick: () => {} },
              { label: 'Adjust ELO', onClick: () => {} },
              { label: 'Record match', onClick: () => {} },
              { label: 'Remove from roster', onClick: () => {}, danger: true },
            ]}
          />
        </AutoOpen>
      </div>
    </div>
  );
}

export function SessionCardActions() {
  return (
    <div style={{ height: 260, maxWidth: 460 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 14px',
          background: 'var(--bg-surface)',
          border: '1px solid var(--border)',
          borderRadius: 12,
        }}
      >
        <div>
          <p style={{ margin: 0, fontSize: 14, color: 'var(--text-primary)' }}>
            Thursday drop-in &middot; 7&ndash;10pm
          </p>
          <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>
            Lorne Davies Complex &middot; 18 / 24 checked in
          </p>
        </div>
        <AutoOpen>
          <Dropdown
            trigger={kebab}
            items={[
              { label: 'Edit session', onClick: () => {} },
              { label: 'Duplicate to next week', onClick: () => {} },
              { label: 'Cancel session', onClick: () => {}, danger: true },
            ]}
          />
        </AutoOpen>
      </div>
    </div>
  );
}
