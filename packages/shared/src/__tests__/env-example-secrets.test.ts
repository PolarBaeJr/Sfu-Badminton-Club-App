// `.env.example` is the only thing that tells a deployer a variable exists.
//
// EMAIL_UNSUBSCRIBE_SECRET has never been set on production, and the reason is
// not that somebody skipped it: it was absent from this file, so nothing ever
// asked for it. The consequence is silent by construction — safeUnsubscribeUrl
// catches the "not set" throw and returns null, so every notification email the
// club has ever sent went out with no List-Unsubscribe header AND no footer
// link, leaving "Report spam" as the recipient's only option.
//
// This test is the mechanism that stops the next one of these. A secret whose
// absence degrades quietly must be named here.

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const envExample = readFileSync(
  fileURLToPath(new URL('../../../../.env.example', import.meta.url)),
  'utf8',
);

// Secrets whose absence does NOT fail a build, a health check, or a request —
// the feature simply stops working with no error anywhere.
const FAIL_SOFT_SECRETS = [
  // Unsubscribe links and RFC 8058 headers vanish from all ten senders.
  'EMAIL_UNSUBSCRIBE_SECRET',
  // Every scheduled job (pg_cron and the Pi host crontab) 401s; reminders,
  // digests and expiry sweeps just stop, with nothing logged anywhere.
  'CRON_SECRET',
  // Passkey sign-in answers 503 and the member blames their device.
  'PASSKEY_COOKIE_SECRET',
  'ADMIN_PASSKEY_COOKIE_SECRET',
  // Bounces and spam complaints are discarded — the route 503s, Resend retries
  // and then gives up, and email_suppressions stays empty while the club keeps
  // mailing addresses that permanently rejected it.
  'RESEND_WEBHOOK_SECRET',
  // Push is a silent no-op without all three.
  'NEXT_PUBLIC_VAPID_PUBLIC_KEY',
  'VAPID_PRIVATE_KEY',
  'VAPID_EMAIL',
];

describe('.env.example', () => {
  it.each(FAIL_SOFT_SECRETS)('documents %s', (name) => {
    expect(new RegExp(`^${name}=`, 'm').test(envExample)).toBe(true);
  });

  it('says what breaks when the unsubscribe secret is unset', () => {
    // The comment block is the contiguous run of `#` lines immediately above
    // the assignment. Walking up from the variable rather than splitting on a
    // blank line, because the block uses bare `#` separators and a blank-line
    // split would silently reach into an earlier section and pass whatever
    // this file said.
    const lines = envExample.split('\n');
    const at = lines.findIndex((l) => l.startsWith('EMAIL_UNSUBSCRIBE_SECRET='));
    expect(at).toBeGreaterThan(0);
    const comment: string[] = [];
    for (let i = at - 1; i >= 0 && lines[i]!.startsWith('#'); i -= 1) comment.unshift(lines[i]!);
    expect(comment.length).toBeGreaterThan(0);
    expect(comment.join('\n')).toMatch(/List-Unsubscribe/);
  });
});
