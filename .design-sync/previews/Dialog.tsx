import React from 'react';
import { Dialog, Button, Input } from '@badminton/ui';

// The Dialog positions with `fixed inset-0`. The preview wraps it in a
// transformed stage so the overlay anchors to the stage box (a transform makes
// the wrapper the containing block for fixed descendants) — the modal then
// centers inside the card instead of escaping the cell.
export function ConfirmResult() {
  return (
    <div
      style={{
        position: 'relative',
        height: 520,
        transform: 'translateZ(0)',
        overflow: 'hidden',
        borderRadius: 12,
        background: 'var(--bg)',
      }}
    >
      <Dialog open onClose={() => {}} title="Confirm match result">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <p style={{ fontSize: 14, color: 'var(--text-secondary)', margin: 0 }}>
            Jordan Lee reported <strong>21–17, 19–21, 21–18</strong> in your singles match.
            Confirming applies the ELO change to both players.
          </p>
          <Input label="Comment (optional)" placeholder="Good match!" />
          <div style={{ display: 'flex', gap: 10, justifyContent: 'flex-end' }}>
            <Button variant="ghost">Dispute</Button>
            <Button variant="success">Confirm result</Button>
          </div>
        </div>
      </Dialog>
    </div>
  );
}
