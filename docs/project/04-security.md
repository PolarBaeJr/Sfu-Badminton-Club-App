# 4 · Security & Data Protection

*How members' data, the club's money, and the app itself are protected. Written in plain language — each measure is paired with **what it protects against**. Security is layered on purpose: if one layer is bypassed, others still hold.*

---

## 1. Login & identity

- **6-digit code login.** Instead of a "click this link" email (which corporate and university email systems often auto-click, silently breaking the login), members receive a **6-digit code** to enter.
  - *Protects against:* broken/hijacked login links and email-scanner interference — a real reliability-and-security fix, not just convenience.
- **Google sign-in.** One-tap login with a Google account, handled by a trusted identity provider.
  - *Protects against:* weak/reused passwords — the club never handles the Google password.
- **Secure session handling.** After login, the app establishes the member's session through a proper server-side step that sets a secure session cookie.
  - *Protects against:* sessions that don't actually stick or that could be tampered with client-side.

## 2. Who can do what (access control)

Access is enforced in **three independent layers**, so a gap in one doesn't expose anything:

- **Layer 1 — Page access.** When someone navigates to an admin page, the system checks their access level and redirects them away if they're not allowed.
- **Layer 2 — Action gate (the real boundary).** Every sensitive action (change a member, edit fees, run a tournament) re-checks the user's role on the server *before doing anything*. Even if someone got past the page check, the action itself refuses.
- **Layer 3 — Database rules (Row-Level Security).** The database itself enforces that only logged-in, authorized users can read or write data — independent of the app code.

- **Tiered roles.** There are distinct levels — regular player, executive, and admin — and sensitive areas (money, member records, disputes, settings) are reserved for admins even within the exec console.
  - *Protects against:* a member reaching admin tools, or an exec touching financial/personal data they shouldn't.
- **Change logging.** Sensitive changes (like editing a member's role) are recorded with who did it and what changed.
  - *Protects against:* untraceable changes; supports accountability.

## 3. Database-level protection

- **Everything is locked by default.** Every data table has **Row-Level Security** switched on, and the rules only allow **logged-in** users through. An anonymous visitor with no account can read or write **nothing** at the table level.
- **Public data is hand-picked.** The public pages (leaderboard, exec roster, active season) are served through a small set of **purpose-built, read-only functions** that expose only specific, safe columns — never raw table access.
  - *Protects against:* accidental data leaks. Even though the public leaderboard is open, there is no path from it to private data (emails, fees, personal records).

## 4. The self-hosting security fix (a real hole we closed)

Early on, the app used a development database setup that shipped with **publicly-known demo security keys**. That meant the master "service" key — which can read and write *everything* and bypass all protections — was effectively public knowledge. **This was a critical vulnerability.**

We migrated to a **properly self-hosted database with unique, private keys** generated for this club alone. The old public keys no longer work.
- *Protects against:* the most serious class of breach — full database access via a known key.

## 5. Server-only master key

- The powerful "service" key that can bypass protections is kept **only on the server**, never sent to phones or browsers. The app uses it for trusted server-side operations; members' devices never see it.
  - *Protects against:* key theft from the client side.

## 6. Automated background jobs "fail closed"

- The automated jobs (reminders, expiries, snapshots) require a **secret token** to run, checked in a way that's resistant to timing attacks. If the token is missing or wrong, the job **refuses to run** rather than running unprotected.
  - *Protects against:* outsiders triggering privileged automated actions.

## 7. Automated checks on every change

- **Every code change must pass the automated test suite before it can be merged.** A pull request against the deployable branch runs type checking, linting and the full test suite, and a failure blocks the merge.
  - *Protects against:* regressions and broken builds reaching members.
  - *Does **not** protect against:* a new vulnerability that the tests do not happen to cover. There is **no automated security scanner** in CI. Security here comes from review and from the specific controls listed elsewhere on this page, not from a tool that inspects each change.

## 8. Input validation

- Data coming from users is **validated against strict rules** before it's trusted or stored.
  - *Protects against:* malformed or malicious input.

## 9. Backups (data safety)

- The database is **backed up nightly**, kept for a rolling 14-day window, and copied **off-site** two ways: to cloud storage, and to a second machine.
  - *Protects against:* hardware failure, ransomware, or accidental deletion — the club can recover its data.
  - **The cloud copy is encrypted before it leaves; the copy on the second machine is not.** Those plaintext dumps hold every member's name, email, phone and waiver, so anyone with access to that machine has the member database without needing a key. This is a known open gap, tracked in `backup/README.md` under "Still open". Do not describe the backups as encrypted without that qualification.

## 10. Staging holds real member data

- The staging site (`badminton.polardev.org`) is refreshed from production every night at 04:00. The copy itself is faithful, so what arrives is real names, emails, phone numbers, officer notes and fee records.
  - **A scrub now runs at the end of that refresh**, replacing every member's name, email, phone, bio and avatar with values derived from their own row id, blanking officer notes and audit-log diffs, and deleting the bearer tokens, passkeys, push endpoints and bounce records. Ratings, matches and row counts survive, so staging stays realistic. The refresh **fails** if any real identifier is left behind, because a scrub that matched nothing looks identical to one that worked.
  - *Still open:* the snapshot script runs from a plain checkout on the Pi that nothing auto-updates, so **the scrub is not protecting anything until that checkout is pulled**. Until then there are two full copies of the membership on the public internet, not one, behind the same login and nothing more, and any breach is scoped to both.
  - *Genuinely isolated either way:* staging's outbound mail goes to a local mailpit and never leaves the Pi, so a real address in the staging database cannot be emailed by accident. That covers the mail path and nothing else.
  - *Accepted residual:* announcement bodies are not scrubbed. They are exec-authored broadcasts already shown to the whole membership and are a real rendering surface, but they can name a member. See `docs/STAGING.md`.

---

## Summary table

| Measure | Protects against |
|---------|------------------|
| 6-digit code login | Broken/scanned login links, weak passwords |
| Google sign-in | Password reuse/theft |
| 3-layer access control | Unauthorized access to admin tools/data |
| Tiered roles | Wrong people touching money/personal data |
| Database Row-Level Security | Anonymous or cross-user data access |
| Hand-picked public functions | Leaks through the public pages |
| Unique private keys (self-host fix) | Full-database breach via known keys |
| Server-only master key | Key theft from devices |
| Fail-closed automated jobs | Outsiders triggering privileged actions |
| Tests and type checks on every change | Regressions reaching members (not: new vulnerabilities — there is no security scanner) |
| Input validation | Malicious/malformed data |
| Nightly off-site backups, cloud copy encrypted | Data loss, ransomware (the second-machine copy is plaintext — see 9) |

| Known risk | Why it is listed |
|---------|------------------|
| Staging carries an unscrubbed nightly copy of production | Two full copies of the membership on the public internet, not one (see 10) |
| The second-machine backup copy is unencrypted | Plaintext member database on that machine, no key needed (see 9) |

➡️ Continue to **[05-tech-and-ops.md](05-tech-and-ops.md)** for hosting, deployment, and cost.
