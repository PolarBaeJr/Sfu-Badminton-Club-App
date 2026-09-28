// A session made with nothing but a password. The member app offers password
// sign-in and shares its auth cookie with the console, so without a check a
// password alone would open the console for anyone still inside the 14 days
// without an admin-enrolled passkey (lib/passkey/grace.ts, 00262). The console accepts an email code, Google or a
// passkey; a password is a weaker factor than owning the inbox.
//
// Reads the access token's `amr` claim, which auth-js hands back as
// getAuthenticatorAssuranceLevel().currentAuthenticationMethods: either
// { method, timestamp } entries or, from a custom access token hook, bare
// RFC 8176 strings. Both shapes are accepted.
//
// Only the name 'password' matters to this rule ('password' in auth-js's
// AMRMethods and GoTrue's password grant). The names a code, recovery,
// passkey or Google session carry do not: anything that is not solely
// 'password' passes. That name must still be confirmed on the local stack
// before this ships, by decoding a real password-grant token AND the token
// after a refresh: if a refresh adds any other method to the claim, this rule
// stops matching after the first refresh and that method must be ignored here.
//
// An empty or missing claim passes too: that is a session this rule cannot
// judge, and refusing it would lock out every token that predates the claim.

export const PASSWORD_AMR_METHOD = 'password';

function methodOf(entry: unknown): string | null {
  if (typeof entry === 'string') return entry;
  if (entry && typeof entry === 'object') {
    const method = (entry as { method?: unknown }).method;
    if (typeof method === 'string') return method;
  }
  return null;
}

export function isPasswordOnlySession(amr: unknown): boolean {
  if (!Array.isArray(amr) || amr.length === 0) return false;
  return amr.every((entry) => methodOf(entry) === PASSWORD_AMR_METHOD);
}
