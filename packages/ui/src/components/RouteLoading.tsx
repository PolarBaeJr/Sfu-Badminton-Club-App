import React from 'react';

/** Default loading.tsx skeleton for app routes. Renders a generic
 * page-shell skeleton: a header bar + three card placeholders.
 * Co-located with RouteError so adopting both is one import each. */
export function RouteLoading() {
  return (
    <div data-screen-label="Loading">
      <div className="page-header">
        <div style={{ flex: 1, minWidth: 0 }}>
          <div className="skeleton" style={{ height: 12, width: 140, marginBottom: 12 }} />
          <div className="skeleton" style={{ height: 36, width: 'min(420px, 80%)', marginBottom: 10 }} />
          <div className="skeleton" style={{ height: 14, width: 'min(560px, 100%)' }} />
        </div>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {[0, 1, 2].map((i) => (
          <div key={i} className="card-base">
            <div className="skeleton" style={{ height: 16, width: 180, marginBottom: 14 }} />
            <div className="skeleton" style={{ height: 12, width: '90%', marginBottom: 8 }} />
            <div className="skeleton" style={{ height: 12, width: '70%' }} />
          </div>
        ))}
      </div>
    </div>
  );
}
