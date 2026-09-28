// What to do after one attempt to save a password. Pure, so it can be tested
// without the browser client.
//
// GoTrue asking for reauthentication again after a code was already sent is
// shown as a failure (AUTH-213), not answered with another automatic email:
// that would loop.

export type PasswordSaveOutcome = 'saved' | 'needs-code' | 'failed';

export function passwordSaveOutcome(
  res: { ok: true } | { ok: false; needsReauth: boolean },
  { withNonce }: { withNonce: boolean },
): PasswordSaveOutcome {
  if (res.ok) return 'saved';
  if (res.needsReauth && !withNonce) return 'needs-code';
  return 'failed';
}
