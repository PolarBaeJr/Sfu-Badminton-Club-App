// WebAuthn rejects with DOMExceptions whose messages are written for browser
// engineers, not people: cancelling a Touch ID prompt surfaces "The request is
// not allowed by the user agent or the platform in the current context,
// possibly because the user denied permission." That reads like a failure when
// it's usually just someone dismissing a dialog.
//
// Map the handful of names WebAuthn actually throws to something that says what
// happened and what to do next. Anything unrecognised falls back to the caller's
// generic message rather than leaking the raw DOMException text.
export function friendlyPasskeyError(err: unknown, fallback: string): string {
  const name = (err as { name?: string } | null)?.name;

  switch (name) {
    case 'NotAllowedError':
      // Cancelled the prompt, dismissed it, or let it time out. By far the most
      // common case, and not an error worth alarming anyone about.
      return 'Passkey prompt was cancelled — nothing was saved. Try again when you’re ready.';
    case 'InvalidStateError':
      // The authenticator already holds a credential for this account.
      return 'This device already has a passkey for your account. Use it to sign in instead of enrolling another.';
    case 'NotSupportedError':
      return 'This device or browser doesn’t support passkeys. Try a different browser or device.';
    case 'SecurityError':
      // Origin / relying-party mismatch — e.g. after a domain change, or when
      // the page isn't on a secure origin.
      return 'This site isn’t allowed to use your passkey. If the club domain changed recently, enroll a new one.';
    case 'AbortError':
      return 'Passkey prompt was closed before it finished.';
    case 'ConstraintError':
      return 'Your device couldn’t create a passkey with the required settings.';
    default:
      return err instanceof Error && err.message ? err.message : fallback;
  }
}
