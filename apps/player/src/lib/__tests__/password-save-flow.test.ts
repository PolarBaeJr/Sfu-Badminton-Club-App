import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { passwordSaveOutcome } from '../password-save-flow';

describe('passwordSaveOutcome', () => {
  it('a save that went through is saved', () => {
    expect(passwordSaveOutcome({ ok: true }, { withNonce: false })).toBe('saved');
    expect(passwordSaveOutcome({ ok: true }, { withNonce: true })).toBe('saved');
  });

  // same_password is folded into ok by setMemberPassword, so it arrives here
  // as ok: true.
  it('reusing the current password counts as saved', () => {
    expect(passwordSaveOutcome({ ok: true }, { withNonce: false })).toBe('saved');
  });

  it('GoTrue asking for reauthentication with no code yet means send a code', () => {
    expect(passwordSaveOutcome({ ok: false, needsReauth: true }, { withNonce: false })).toBe('needs-code');
  });

  it('asking again after a code was supplied is a failure, not another email', () => {
    expect(passwordSaveOutcome({ ok: false, needsReauth: true }, { withNonce: true })).toBe('failed');
  });

  it('any other refusal fails', () => {
    expect(passwordSaveOutcome({ ok: false, needsReauth: false }, { withNonce: false })).toBe('failed');
    expect(passwordSaveOutcome({ ok: false, needsReauth: false }, { withNonce: true })).toBe('failed');
  });
});

// The forgot-password dead end: forgot and signup once called
// setMemberPassword themselves and had no path for GoTrue's "needs a code".
// Every password form goes through the shared hook now.
describe('every password form uses the shared save hook', () => {
  const root = join(__dirname, '..', '..');
  const code = (rel: string) =>
    readFileSync(join(root, rel), 'utf8')
      .split('\n')
      .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
      .join('\n');

  for (const rel of [
    'app/login/forgot/forgot-form.tsx',
    'app/signup/signup-form.tsx',
    'components/password-manager.tsx',
  ]) {
    it(rel, () => {
      const src = code(rel);
      expect(src).toContain('usePasswordSave(');
      expect(src).not.toContain('setMemberPassword(');
    });
  }
});
