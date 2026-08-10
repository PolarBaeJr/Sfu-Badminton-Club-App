import { describe, it, expect } from 'vitest';
import { isApprovalEdit } from '../player-approval';

describe('isApprovalEdit', () => {
  it('treats a pending signup moving into a division as an approval', () => {
    // approvePlayer is what emails them "you're in" and files the
    // player_approved audit row. Edit is the only console control left on the
    // Needs Attention tab, so this is the only thing keeping either of those
    // from being lost.
    expect(isApprovalEdit('pending_approval', 'competitive')).toBe(true);
    expect(isApprovalEdit('pending_approval', 'recreational')).toBe(true);
  });

  it('does not welcome someone who is being deactivated or suspended instead', () => {
    expect(isApprovalEdit('pending_approval', 'inactive')).toBe(false);
    expect(isApprovalEdit('pending_approval', 'suspended')).toBe(false);
    expect(isApprovalEdit('pending_approval', 'pending_approval')).toBe(false);
  });

  it('never re-approves someone who was already in', () => {
    // A recreational member moved to competitive is an ordinary status change:
    // they have been welcomed once already, and approving them twice would file
    // a second player_approved row for an approval that never happened.
    expect(isApprovalEdit('recreational', 'competitive')).toBe(false);
    expect(isApprovalEdit('competitive', 'recreational')).toBe(false);
    expect(isApprovalEdit('suspended', 'competitive')).toBe(false);
  });

  it('says no when the stored status is unknown', () => {
    expect(isApprovalEdit(undefined, 'competitive')).toBe(false);
    expect(isApprovalEdit(null, 'competitive')).toBe(false);
  });
});
