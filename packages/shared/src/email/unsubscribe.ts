import { createHmac, timingSafeEqual } from 'crypto';
import type { NotificationCategory } from '../utils/notifications';

// Unsubscribe links have to work with no session — the whole point is that a
// recipient who cannot or will not log in can still stop the mail, and RFC 8058
// one-click is a machine POST from the mail client with no cookies at all.
//
// So the link carries its own authority: a signed payload rather than a random
// token looked up in a table. Stateless means no row to insert at send time, no
// cleanup, and no way for a token table to drift out of sync with what was
// actually mailed.
//
// Signed, NOT encrypted. The address is visible in the link, which is fine —
// it is the recipient's own address, in an email already sitting in their
// inbox. What the signature prevents is someone editing the address in the URL
// to unsubscribe a person who never asked.

const SEP = '.';

function secret(): string {
  const s = process.env.EMAIL_UNSUBSCRIBE_SECRET;
  if (!s) {
    // Deliberately fatal rather than falling back to a constant. A default
    // secret would make every link forgeable by anyone reading this repo.
    throw new Error('EMAIL_UNSUBSCRIBE_SECRET not set');
  }
  return s;
}

function b64url(input: string): string {
  return Buffer.from(input, 'utf8').toString('base64url');
}

function sign(payload: string): string {
  return createHmac('sha256', secret()).update(payload).digest('base64url');
}

/**
 * A token authorising "stop sending <category> to <email>".
 *
 * `category` omitted means every category — the "unsubscribe from everything"
 * link, which is what List-Unsubscribe should point at.
 */
export function signUnsubscribeToken(
  email: string,
  category?: NotificationCategory,
): string {
  // Normalised here so the signature covers exactly the string the verifier
  // will compare against the database.
  const payload = b64url(JSON.stringify({ e: email.trim().toLowerCase(), c: category ?? '*' }));
  return `${payload}${SEP}${sign(payload)}`;
}

export interface UnsubscribeClaim {
  email: string;
  /** null means "all categories". */
  category: NotificationCategory | null;
}

/** Returns null for anything not carrying a valid signature from this secret. */
export function verifyUnsubscribeToken(token: string): UnsubscribeClaim | null {
  if (typeof token !== 'string' || token.length > 512) return null;

  const idx = token.lastIndexOf(SEP);
  if (idx <= 0) return null;
  const payload = token.slice(0, idx);
  const provided = token.slice(idx + 1);

  let expected: string;
  try {
    expected = sign(payload);
  } catch {
    return null; // secret missing — fail closed rather than accept anything
  }

  // Compare as fixed-length buffers. Lengths must match before timingSafeEqual,
  // which throws on a mismatch rather than returning false.
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    const email = typeof parsed?.e === 'string' ? parsed.e : null;
    const c = typeof parsed?.c === 'string' ? parsed.c : null;
    if (!email || !c) return null;
    return { email, category: c === '*' ? null : (c as NotificationCategory) };
  } catch {
    return null;
  }
}

/** The link put in the footer and the List-Unsubscribe header. */
export function buildUnsubscribeUrl(
  baseUrl: string | null | undefined,
  email: string,
  category?: NotificationCategory,
): string | null {
  if (!baseUrl) return null;
  const base = baseUrl.replace(/\/+$/, '');
  if (!base) return null;
  return `${base}/unsubscribe?token=${encodeURIComponent(signUnsubscribeToken(email, category))}`;
}
