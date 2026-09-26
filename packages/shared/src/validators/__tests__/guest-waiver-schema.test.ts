import { describe, it, expect } from 'vitest';
import { guestWaiverSchema } from '../schemas';

// A guest's signing is the one form anybody on the internet can submit, so the
// schema is the first thing between a POST body and the database.

const valid = {
  full_name: 'Alex Guest',
  email: 'alex@example.com',
  age_attestation: true,
  documents_accepted: true,
};

function messages(input: unknown): string[] {
  const result = guestWaiverSchema.safeParse(input);
  return result.success ? [] : result.error.issues.map((i) => i.message);
}

describe('guestWaiverSchema', () => {
  it('trims the name and trims and lowercases the email', () => {
    const parsed = guestWaiverSchema.parse({ ...valid, full_name: '  Alex Guest ', email: '  Alex@Example.COM ' });
    expect(parsed.full_name).toBe('Alex Guest');
    expect(parsed.email).toBe('alex@example.com');
  });

  it('refuses a bad email and one over 254 characters', () => {
    expect(guestWaiverSchema.safeParse({ ...valid, email: 'not-an-email' }).success).toBe(false);
    expect(guestWaiverSchema.safeParse({ ...valid, email: `${'a'.repeat(250)}@x.com` }).success).toBe(false);
  });

  it('refuses a name under 2 or over 100 characters', () => {
    expect(messages({ ...valid, full_name: ' A ' })).toContain('Enter your full name');
    expect(guestWaiverSchema.safeParse({ ...valid, full_name: 'a'.repeat(101) }).success).toBe(false);
    expect(guestWaiverSchema.safeParse({ ...valid, full_name: 'a'.repeat(100) }).success).toBe(true);
  });

  it('refuses a missing or false age attestation with the 19+ message', () => {
    expect(messages({ ...valid, age_attestation: false })).toEqual(['You must be 19 or older to sign as a guest']);
    const { age_attestation: _age, ...missing } = valid;
    expect(messages(missing)).toEqual(['You must be 19 or older to sign as a guest']);
  });

  it('refuses the documents unaccepted', () => {
    expect(messages({ ...valid, documents_accepted: false })).toEqual([
      'Please accept the waiver and privacy policy',
    ]);
  });

  // The versions signed are read inside sign_guest_waiver, never taken from
  // the form, so a posted version is dropped rather than trusted.
  it('strips a version the client sends', () => {
    const parsed = guestWaiverSchema.parse({ ...valid, waiver_version: '1999-01-01', privacy_version: 'x' });
    expect(parsed).not.toHaveProperty('waiver_version');
    expect(parsed).not.toHaveProperty('privacy_version');
  });
});
