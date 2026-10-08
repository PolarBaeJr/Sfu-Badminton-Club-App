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

## 4. The demo-key fix (a real hole we closed)

Early on, the app used a development database setup that shipped with **publicly-known demo security keys**. That meant the master "service" key — which can read and write *everything* and bypass all protections — was effectively public knowledge. **This was a critical vulnerability.**

We moved to a **database with unique, private keys** generated for this club alone. The old public keys no longer work.
- *Protects against:* the most serious class of breach — full database access via a known key.

## 5. Server-only master key

- The powerful "service" key that can bypass protections is kept **only on the server**, never sent to phones or browsers. The app uses it for trusted server-side operations; members' devices never see it.
  - *Protects against:* key theft from the client side.

## 6. Automated background jobs "fail closed"

- The automated jobs (reminders, expiries, snapshots) require a **secret token** to run, checked in a way that's resistant to timing attacks. If the token is missing or wrong, the job **refuses to run** rather than running unprotected.
  - *Protects against:* outsiders triggering privileged automated actions.

## 7. Automated checks on every change

- **Every code change is held to the automated test suite.** Type checking, linting and the full test suite run on each change before it is released, and a failure blocks the release.
  - *Protects against:* regressions and broken builds reaching members.
  - *Does **not** protect against:* a new vulnerability that the tests do not happen to cover. There is **no automated security scanner** among those checks. Security here comes from review and from the specific controls listed elsewhere on this page, not from a tool that inspects each change.

## 8. Input validation

- Data coming from users is **validated against strict rules** before it's trusted or stored.
  - *Protects against:* malformed or malicious input.

## 9. Backups (data safety)

- The database is **backed up nightly**, kept for a rolling 14-day window, and copied **off-site**. The off-site copies are **encrypted at rest**.
  - *Protects against:* hardware failure, ransomware, or accidental deletion: the club can recover its data.
  - **Encryption does not extend the retention clock.** A backup the club can still decrypt is still the club holding that member's data, so the 14-day sweep applies to the encrypted copies unchanged.

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
| Unique private keys (demo-key fix) | Full-database breach via known keys |
| Server-only master key | Key theft from devices |
| Fail-closed automated jobs | Outsiders triggering privileged actions |
| Tests and type checks on every change | Regressions reaching members (not: new vulnerabilities — there is no security scanner) |
| Input validation | Malicious/malformed data |
| Nightly off-site backups, encrypted at rest | Data loss, ransomware, and a stolen backup device (see 9) |

| Known risk | Why it is listed |
|---------|------------------|
| No automated security scanning | Tests catch regressions, not new vulnerabilities (see 7) |

Continue to **[06-tech-stack.md](06-tech-stack.md)** for the tools and technologies the app is built on.
