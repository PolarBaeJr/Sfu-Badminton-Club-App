# Privacy Policy

> 🚧 **DRAFT — REVIEW REQUIRED.** This is a starting-point template, **not legal advice**. Before publishing, have it reviewed by the club executive and, ideally, SFU student-club resources or a legal advisor. Fill in every `[PLACEHOLDER]`.
>
> **Which law applies is an open question, and it is with SFU Recreation.** The two candidates are **FIPPA**, if the membership data counts as an SFU record because the club sits under Recreation, and BC's **PIPA**, if the club is a private organisation holding its own records. The app is currently built and documented on the **FIPPA** reading, as the more conservative of the two. The facts point the other way (the club manages itself, collects its own records, holds them on its own hardware, Recreation has no access, and this is not an official SFU application), which is exactly why it is being asked rather than assumed. It matters here: the deadline for answering a member's request for their own data is **30 business days under FIPPA and 30 calendar days under PIPA**, and PIPA additionally requires the club to designate a privacy officer and maintain a written privacy management program.

**Effective date:** `[DATE]`
**Applies to:** the `[CLUB LEGAL NAME]` app and website (`[APP URL]`).
**Contact:** `[PRIVACY CONTACT EMAIL]`

---

## 1. Who we are

`[CLUB LEGAL NAME]` ("the Club", "we") operates a members' app for managing club activities — a competitive ladder, sessions, tournaments, and membership. This policy explains what personal information we collect and how we handle it.

## 2. What we collect

| Data | Why we collect it |
|------|-------------------|
| **Name** (and display name) | Identify you on the ladder, sessions, and to other members |
| **Email address** | Sign-in, reminders, announcements |
| **Phone number** (optional) | Contact for sessions/events, if provided |
| **Match & rating data** | Run the ladder (scores, wins/losses, ELO) |
| **Attendance data** | Session and tournament check-ins |
| **Fee/payment status** | Track membership dues |
| **Account/technical data** | Login sessions, and — if enabled — basic error and usage analytics |

We collect this when you sign up, use the app, play matches, and attend sessions.

## 3. How we use it

- To operate the ladder, sessions, tournaments, and membership.
- To send you sign-in codes, reminders, and club announcements.
- To keep the app secure and working (error monitoring, abuse prevention).
- To produce club statistics (e.g. standings, participation).

We do **not** sell your personal information.

## 4. Who can see what

- **Other members / the public:** your **name and rating** appear on the ladder and may appear on the public leaderboard — unless you opt out (you can be hidden from the public leaderboard).
- **Executives:** club-activity data (sessions, tournaments, matches).
- **Admins:** the above **plus** sensitive data (email, phone, fee status, member records).
- **Service providers:** the club's data does not all sit on its own machines. These are the outside organisations it reaches, what each one gets, and why. They process it only to provide their service.
  - **Resend** — your email address and the delivery result, because that is how the app sends you mail at all (sign-in codes, session reminders, notices about your account).
  - **Sentry** — technical error reports when something breaks. These can include identifiers tied to your account, which is why it is named here rather than treated as anonymous.
  - **Discord** — your Discord user ID, if you choose to link your Discord account, so the bot can match you to your membership and assign roles.
  - **Google** — your Google account identifier and email address, if you choose to sign in with Google.
  - **Cloudflare** — your IP address and request details, because all traffic to the site passes through it.
  - **Google Drive** — a nightly encrypted backup of the club database, which includes your record. Google holds only ciphertext and cannot read it.

  This list is kept honest by a test in the codebase: if the app ever ships a new third-party service, that test fails until the service is named here and in the member data export. Analytics (PostHog) is present in the code but **switched off in production and collecting nothing**, which is why it is not on this list; if it is ever switched on, it gets added in the same change.

## 5. How we protect it

We use multiple safeguards, including secure login, role-based access, database-level access controls, encryption of off-site backups, and ongoing security review. See our security overview for detail. No system is perfectly secure, but we take reasonable measures.

## 6. How long we keep it

We keep your information while you're a member and as needed for club records (e.g. past-season standings). You can request deletion — see below. Some anonymized/aggregate statistics may be retained.

## 7. Your rights

You may:
- **Access** the personal information we hold about you.
- **Correct** inaccurate information.
- **Request deletion** of your account and personal information (some records may be retained where required for legitimate club purposes).
- **Opt out** of the public leaderboard.
- **Withdraw** from notifications.

**Two of these you can do yourself, right now, without asking anyone:**

- **Download everything held about you.** Settings → your data. It produces a single file covering every table the club holds about you, and it also lists what is *not* included and why, so you can see the limits of it rather than having to trust that it is complete.
- **Delete your account.** Settings → delete account. Your account is deactivated immediately and permanently anonymised after 30 days, so you have 30 days to change your mind by signing back in.

For anything else, or if you would rather not do it yourself, contact `[PRIVACY CONTACT EMAIL]`.

## 8. Children / eligibility

The app is intended for `[eligibility, e.g. SFU students and club members 16+]`. `[Adjust as needed.]`

## 9. Changes

We may update this policy. Material changes will be communicated to members. The "Effective date" above reflects the current version.

## 10. Contact

Questions or requests: `[PRIVACY CONTACT EMAIL]`.

---

*Template drafted for the Club's own use. Review and adapt before publishing.*
