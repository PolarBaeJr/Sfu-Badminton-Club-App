import React from 'react';
import { Toast } from '@badminton/ui';

// Toast renders `fixed bottom-4 right-4`; a transformed stage makes the
// wrapper the containing block for fixed descendants, so each toast anchors
// to the bottom-right of its own framed cell instead of the viewport.
function Stage({ children }: { children: React.ReactNode }) {
  return (
    <div
      style={{
        position: 'relative',
        height: 150,
        maxWidth: 560,
        transform: 'translateZ(0)',
        overflow: 'hidden',
        borderRadius: 12,
        border: '1px solid var(--border)',
        background: 'var(--bg)',
      }}
    >
      <p style={{ margin: 0, padding: '12px 16px', fontSize: 12, color: 'var(--text-muted)' }}>
        Sessions &middot; Spring 2026
      </p>
      {children}
    </div>
  );
}

export function MatchConfirmed() {
  return (
    <Stage>
      <Toast type="success" message="Result confirmed — ELO updated (612 → 621)" onClose={() => {}} />
    </Stage>
  );
}

export function PaymentFailed() {
  return (
    <Stage>
      <Toast type="error" message="Comp fee payment failed — card declined" onClose={() => {}} />
    </Stage>
  );
}

export function SessionReminder() {
  return (
    <Stage>
      <Toast type="info" message="Thursday drop-in starts in 45 minutes" onClose={() => {}} />
    </Stage>
  );
}
