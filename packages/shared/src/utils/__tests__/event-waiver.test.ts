import { describe, it, expect } from 'vitest';
import { eventWaiverHash } from '../event-waiver';

describe('eventWaiverHash', () => {
  it('is deterministic — same input yields the same hash', () => {
    expect(eventWaiverHash('I agree')).toBe(eventWaiverHash('I agree'));
  });

  it('trims surrounding whitespace before hashing', () => {
    expect(eventWaiverHash('  I agree  ')).toBe(eventWaiverHash('I agree'));
    expect(eventWaiverHash('I agree\n')).toBe(eventWaiverHash('I agree'));
  });

  it('changes the hash when the text is edited', () => {
    expect(eventWaiverHash('I agree')).not.toBe(eventWaiverHash('I do not agree'));
  });

  it('outputs a 64-char lowercase hex string', () => {
    expect(eventWaiverHash('I agree')).toMatch(/^[0-9a-f]{64}$/);
  });

  it('matches the known sha256 vector for a fixed trimmed string', () => {
    expect(eventWaiverHash('I agree')).toBe(
      '99955b75e054416577b88fcec811270c93bff6f1bc421f01e3da7c1b18ec61e3'
    );
  });
});
