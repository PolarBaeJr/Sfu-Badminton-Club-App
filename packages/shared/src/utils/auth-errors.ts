// Supabase auth errors reach the client as raw strings; a gateway 503 arrives
// with a "{}" body and rate limits phrase themselves oddly. Map both to
// something a human can act on instead of leaking the raw payload.
//
// Lives here rather than in either login page because both of them sign people
// in with the same auth gateway and hit the same unhelpful strings.
export function friendlyAuthError(message: string): string {
  const msg = (message ?? '').trim();
  if (!msg || msg === '{}' || msg === '[object Object]') {
    return 'Something went wrong reaching the server. Please try again in a moment.';
  }
  // GoTrue allows one email per address per minute and says how long is left
  // ("you can only request this after 32 seconds"). That refusal means a code
  // WAS sent moments ago, so point at the inbox and keep the countdown.
  const wait = msg.match(/after (\d+) seconds?/i);
  if (wait) {
    const n = Number(wait[1]);
    return `A code was sent to this email moments ago. Check your inbox, or ask for a new one in ${n} second${n === 1 ? '' : 's'}.`;
  }
  if (/rate|security purposes|too many/i.test(msg)) {
    return 'Too many attempts. Please wait a minute before trying again.';
  }
  return msg;
}
