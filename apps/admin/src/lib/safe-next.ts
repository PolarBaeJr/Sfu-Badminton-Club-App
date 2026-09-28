// Only allow same-app relative paths (no protocol-relative '//', no
// backslash tricks) so ?next= can't be used as an open redirect. Shared by
// /unavailable and /passkey-required.
export function sanitizeNext(next: string | null | undefined): string {
  if (!next) return '/dashboard';
  if (!next.startsWith('/') || next.startsWith('//') || next.includes('\\')) return '/dashboard';
  return next;
}
