-- ============================================================
-- 00014_legal_docs_expand.sql — Terms of Use & Privacy Policy,
-- annual waiver renewal
--
-- Expands the legal-documents system (00010) from two agreed-to
-- documents to four: adds 'terms_of_use' and 'privacy_policy' to
-- both CHECK constraints and seeds their live text (adapted from
-- docs/legal/terms-of-use.md and privacy-policy.md). Also drops
-- the UNIQUE(player_id, document, version) constraint on
-- waiver_acceptances: acceptances are append-only history, and
-- the annual waiver re-signature creates a NEW row (same
-- document, same version, later accepted_at) so the original
-- evidence is preserved.
-- ============================================================

-- ============================================================
-- CHECK CONSTRAINTS — admit the two new documents
-- ============================================================

ALTER TABLE legal_documents DROP CONSTRAINT IF EXISTS legal_documents_document_check;
ALTER TABLE legal_documents ADD CONSTRAINT legal_documents_document_check
  CHECK (document IN ('waiver', 'code_of_conduct', 'terms_of_use', 'privacy_policy'));

ALTER TABLE waiver_acceptances DROP CONSTRAINT IF EXISTS waiver_acceptances_document_check;
ALTER TABLE waiver_acceptances ADD CONSTRAINT waiver_acceptances_document_check
  CHECK (document IN ('waiver', 'code_of_conduct', 'terms_of_use', 'privacy_policy'));

-- ============================================================
-- ANNUAL WAIVER RENEWAL — append-only acceptances
-- ============================================================

-- The waiver must be re-signed every year. Re-signing inserts a new
-- acceptance row rather than touching the old one, so the unique key from
-- 00010 has to go. A plain index keeps the per-player lookups fast.
ALTER TABLE waiver_acceptances DROP CONSTRAINT IF EXISTS waiver_acceptances_player_id_document_version_key;
CREATE INDEX idx_wa_player_document ON waiver_acceptances(player_id, document);

-- ============================================================
-- SEED — Terms of Use & Privacy Policy
-- ============================================================

INSERT INTO legal_documents (document, version, content) VALUES
('terms_of_use', '2026-07-19', $terms$## 1. Eligibility & accounts

The app is for SFU Badminton Club members and prospective members. You are responsible for keeping your account secure and for activity under it. Provide accurate information (name, email) and keep it current.

## 2. Acceptable use

You agree not to:

- Cheat, manipulate, or falsify results, ratings, or attendance.
- Harass, abuse, or harm other members (see the Code of Conduct).
- Attempt to gain unauthorized access to the app, other accounts, or club data.
- Disrupt or attack the service (e.g. scraping at scale, automated abuse).
- Use the app for anything unlawful.

## 3. The ladder & fair play

The competitive ladder depends on honest play. Sandbagging, collusion, and false results undermine it and may result in **rating corrections, voided matches, or loss of ladder eligibility**. Executive/admin decisions on ladder integrity and disputes are final within the club.

## 4. Fees

Membership and event fees, where applicable, are described in the app.

## 5. Content & conduct

By participating you agree to the Code of Conduct and, where applicable, the Liability Waiver.

## 6. Availability

The app is provided "as is." We aim to keep it running but don't guarantee uninterrupted availability. Features may change.

## 7. Suspension & termination

We may suspend or remove access for violations of these terms, the Code of Conduct, or SFU/club policy.

## 8. Privacy

Your use is also governed by the Privacy & Data Retention Policy.

## 9. Changes

We may update these terms; material changes will be communicated to members. Continued use after changes means you accept them.

## 10. Contact

Questions about these terms? Contact a club executive.$terms$),
('privacy_policy', '2026-07-19', $privacy$## 1. Who we are

SFU Badminton Club ("the Club", "we") operates a members' app for managing club activities — a competitive ladder, sessions, tournaments, and membership. This policy explains what personal information we collect and how we handle it.

## 2. What we collect

- **Name and display name** — to identify you on the ladder, at sessions, and to other members.
- **Email address** — sign-in, reminders, and announcements.
- **Phone number** (optional) — contact for sessions and events, if provided.
- **Match & rating data** — to run the ladder (scores, wins/losses, ELO).
- **Attendance data** — session and tournament check-ins.
- **Fee/payment status** — to track membership dues.
- **Account & technical data** — login sessions and, where enabled, basic error and usage analytics.

We collect this when you sign up, use the app, play matches, and attend sessions.

## 3. How we use it

- To operate the ladder, sessions, tournaments, and membership.
- To send you sign-in codes, reminders, and club announcements.
- To keep the app secure and working (error monitoring, abuse prevention).
- To produce club statistics (e.g. standings, participation).

We do **not** sell your personal information.

## 4. Who can see what

- **Other members / the public:** your **name and rating** appear on the ladder and may appear on the public leaderboard — unless you opt out (you can hide yourself from the public leaderboard in Settings).
- **Executives:** club-activity data (sessions, tournaments, matches).
- **Admins:** the above **plus** sensitive data (email, phone, fee status, member records).
- **Service providers:** we use third-party services to run the app — email delivery, error monitoring and usage analytics, and our hosting and database infrastructure. They process data only to provide their service.

## 5. How we protect it

We use multiple safeguards, including secure login, role-based access, database-level access controls, encryption of off-site backups, and ongoing security review. No system is perfectly secure, but we take reasonable measures.

## 6. Data retention

- **While you're a member:** we keep your information for as long as you have an account, to run the ladder, sessions, and membership.
- **Account deletion:** you can delete your account yourself in Settings. Your account is deactivated immediately and held for a **30-day** window, during which you can sign back in and restore it yourself. After 30 days, your account is permanently anonymized: your name, email, phone number, and profile photo are removed and your sign-in is deleted. This cannot be undone.
- **What remains after deletion:** match results, ratings, session attendance, and legal-acceptance records are kept under an anonymous identity ("Deleted Player") so the ladder's history and the club's records stay accurate.
- **Backups:** encrypted off-site database backups are kept for **14 days** and then deleted automatically. A deleted account ages out of backups the same way.
- **Audit logs:** administrative audit logs (records of admin and executive actions) are kept indefinitely for accountability.
- **Legal acceptances:** records of your acceptance of the waiver, code of conduct, terms of use, and this policy are kept permanently as evidence of what was accepted, when, and under which version.
- **Attendance & reliability:** session attendance and reliability records are kept as club records.

## 7. Your rights

You may:

- **Access** the personal information we hold about you.
- **Correct** inaccurate information (most of it directly in Settings).
- **Delete** your account and personal information (see Data retention above for what is kept).
- **Opt out** of the public leaderboard.
- **Withdraw** from notifications.

To exercise any of these, use the app's Settings or contact a club executive.

## 8. Eligibility

The app is intended for SFU students and club members. Members under 19 need a parent or guardian's consent (see the Liability Waiver).

## 9. Changes

We may update this policy. Material changes will be communicated to members and may require re-acceptance in the app. The version shown with this document reflects the current revision.

## 10. Contact

Questions or requests: contact a club executive.$privacy$);
