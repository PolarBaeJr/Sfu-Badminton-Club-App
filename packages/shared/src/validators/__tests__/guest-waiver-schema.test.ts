import { describe, it, expect } from 'vitest';
import { guestMediaConsentSchema, guestWaiverSchema, mediaConsentSchema } from '../schemas';

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

describe('guestWaiverSchema: photo and video consent (00255)', () => {
  // Off unless ticked, and a form from before the checkbox still validates.
  it('defaults media_consent to false', () => {
    expect(guestWaiverSchema.parse(valid).media_consent).toBe(false);
    expect(guestWaiverSchema.parse({ ...valid, media_consent: true }).media_consent).toBe(true);
  });

  it('refuses a non-boolean', () => {
    expect(guestWaiverSchema.safeParse({ ...valid, media_consent: 'yes' }).success).toBe(false);
    expect(guestWaiverSchema.safeParse({ ...valid, media_consent: 1 }).success).toBe(false);
  });
});

describe('guestMediaConsentSchema', () => {
  const token = 'a1'.repeat(24);

  it('accepts a 48-character lowercase hex token and a boolean', () => {
    expect(guestMediaConsentSchema.safeParse({ token, media_consent: false }).success).toBe(true);
    expect(guestMediaConsentSchema.safeParse({ token, media_consent: true }).success).toBe(true);
  });

  it('refuses a token of the wrong shape', () => {
    for (const bad of [token.slice(1), `${token}0`, token.toUpperCase(), 'g'.repeat(48), '']) {
      expect(guestMediaConsentSchema.safeParse({ token: bad, media_consent: true }).success, bad).toBe(false);
    }
  });

  it('requires the consent to be a boolean', () => {
    expect(guestMediaConsentSchema.safeParse({ token }).success).toBe(false);
    expect(guestMediaConsentSchema.safeParse({ token, media_consent: 'true' }).success).toBe(false);
  });
});

describe('mediaConsentSchema', () => {
  it('takes a boolean and nothing else', () => {
    expect(mediaConsentSchema.safeParse({ media_consent: true }).success).toBe(true);
    expect(mediaConsentSchema.safeParse({ media_consent: null }).success).toBe(false);
    expect(mediaConsentSchema.safeParse({}).success).toBe(false);
  });
});
