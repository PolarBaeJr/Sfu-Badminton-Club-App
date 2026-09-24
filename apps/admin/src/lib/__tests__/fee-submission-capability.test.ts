import { describe, expect, it } from 'vitest';
import { submissionCapability } from '../fee-submissions';

// Who may settle an e-transfer receipt is decided from the fee it points at
// (00248), never from anything the browser sends. Dues and club events are
// club fees; a tournament entry is entry money; nothing else is settled by a
// receipt at all.
describe('submissionCapability', () => {
  it('maps dues and club events to the club-fee payment capability', () => {
    expect(submissionCapability('dues')).toBe('fees.clubfees.markpaid.write');
    expect(submissionCapability('event')).toBe('fees.clubfees.markpaid.write');
  });

  it('maps a tournament entry to the entry-money capability', () => {
    expect(submissionCapability('tournament')).toBe('tournaments.fees.markpaid.write');
  });

  it('refuses a reinstatement and anything unknown', () => {
    expect(submissionCapability('reinstatement')).toBeNull();
    expect(submissionCapability('something_new')).toBeNull();
    expect(submissionCapability(null)).toBeNull();
    expect(submissionCapability(undefined)).toBeNull();
  });
});
