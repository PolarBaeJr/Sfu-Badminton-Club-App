// Supabase auth errors reach the client as raw strings; a gateway 503 arrives
// with a "{}" body and rate limits phrase themselves oddly. Map both to
// something a human can act on instead of leaking the raw payload.
//
// Lives here rather than in either login page because both of them sign people
// in with the same auth gateway and hit the same unhelpful strings.
export function friendlyAuthError(message: string): string {
  const msg = (message ?? '').trim();
  if (!msg || msg === '{}' || msg === '[object Object]') {
    return 'Something went wrong reaching the server — please try again in a moment.';
  }
  if (/rate|after \d|security purposes|too many/i.test(msg)) {
    return 'Too many attempts — please wait a moment before trying again.';
  }
  return msg;
}
