import { describe, expect, it } from 'vitest';
import { authErrorCode, buildAuthFailureEvent, scrubAuthText } from '../auth-telemetry';

describe('scrubAuthText', () => {
  it('removes an email address and a 6-digit code', () => {
    expect(scrubAuthText('code 123456 for someone@sfu.ca is bad')).toBe('code <code> for <email> is bad');
  });

  it('leaves ordinary error text alone', () => {
    expect(scrubAuthText('Token has expired or is invalid')).toBe('Token has expired or is invalid');
  });
});

describe('buildAuthFailureEvent', () => {
  it('reports a cancelled passkey sheet at info, with its timing', () => {
    const e = buildAuthFailureEvent({
      flow: 'passkey_signin',
      stage: 'ceremony',
      error: 'NotAllowedError',
      elapsedMs: 40,
    });
    expect(e.level).toBe('info');
    expect(e.tags).toEqual({ auth_flow: 'passkey_signin', auth_stage: 'ceremony', auth_error: 'NotAllowedError' });
    expect(e.extra.elapsed_ms).toBe(40);
  });

  it('reports anything else at warning, grouped by flow, stage and error', () => {
    const e = buildAuthFailureEvent({ flow: 'email_code_verify', stage: 'verify', error: 'otp_expired' });
    expect(e.level).toBe('warning');
    expect(e.fingerprint).toEqual(['auth-failure', 'email_code_verify', 'verify', 'otp_expired']);
  });

  it('scrubs the message it sends', () => {
    const e = buildAuthFailureEvent({
      flow: 'email_code_send',
      stage: 'send',
      error: '429',
      message: 'rate limited for a@b.co',
    });
    expect(e.extra.message).toBe('rate limited for <email>');
  });
});

describe('authErrorCode', () => {
  it('prefers the GoTrue code, then the status', () => {
    expect(authErrorCode({ code: 'otp_expired', status: 403 })).toBe('otp_expired');
    expect(authErrorCode({ status: 429 })).toBe('429');
    expect(authErrorCode(null)).toBe('unknown');
  });
});
