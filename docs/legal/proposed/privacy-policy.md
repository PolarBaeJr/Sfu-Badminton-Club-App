# SFU Badminton Club app: Privacy and Data Retention Policy

**Draft for SFU Recreation and SFU Access and Privacy Program review.**

Effective date: `[date]`
Version: `[version]`
Club contact: `exec@sfubadminton.com`
Privacy contact: `privacy@sfubadminton.com`
SFU privacy contact: `privacy@sfu.ca`

> Contacts are the club's own routed addresses. `privacy@sfu.ca` is kept only as
> the route for records that turn out to be in SFU's custody or control, which is
> the open question in section 1, not as the club's own contact.

## 1. Who operates the app

SFU Badminton Club (the Club) operates this app as a student-led Sport Club within
SFU Recreation. It uses the app to manage membership, badminton sessions and
tournaments, and a competitive ladder.

Information in SFU's custody or control is governed by British Columbia's Freedom
of Information and Protection of Privacy Act (FIPPA) and SFU's privacy
requirements. Other privacy duties may apply to records the Club controls
independently. To ask who is responsible for a particular record, contact
`privacy@sfubadminton.com` or `privacy@sfu.ca`.

> **This is not settled, and the document should not pretend it is.** Whether
> these records are SFU's or the Club's own is the question in front of
> Recreation. The app is built on the more conservative FIPPA reading. The facts
> point the other way: the club manages itself, collects its own records, holds
> them on its own hardware, and Recreation has no access. It matters, because the
> deadline for answering a member's request for their own data is 30 business days
> under FIPPA and 30 calendar days under BC's PIPA, and PIPA additionally requires
> a designated privacy officer and a written privacy management program.

## 2. Information we collect

We collect information you provide and information created when you use the Club
or app:

| Category | Examples | Main purpose |
| --- | --- | --- |
| Identity and profile | Name, display name, optional photo | Identify members and players in the app and at activities. |
| Contact and account | Email, optional phone number, sign-in and account status | Create and secure your account; send service messages and contact you about activities. |
| Badminton activity | Match scores, opponents, wins and losses, rating, ladder position, challenges | Run the ladder, publish standings according to your visibility setting, and resolve disputes. |
| Events and attendance | Registrations, check-ins, attendance, cancellations, no-shows | Manage spaces, events, and participation records. |
| Membership and fees | Membership status, fee or payment status | Check eligibility and administer dues or events. Any payment service used will be identified in section 5. |
| Agreements and decisions | Document version, acceptance date, confirmation record, complaint or decision records where applicable | Show which club rules or approved participation forms were accepted and document decisions. |
| Photograph and video consent | Whether you have given permission for photos or video of you to be used for club promotion, and when you last changed that choice | Record an optional permission that is off unless you turn it on. See section 4. |
| Technical and security | Login sessions, security events, basic error information | Keep the app working, investigate misuse, and protect accounts. |

We obtain most information from you. A match result or attendance record may also
be submitted by another player or a club executive. You may ask us to correct a
result that is wrong.

## 3. Collection notice and permitted uses

We use information to provide the app, run sessions and tournaments, maintain the
ladder, communicate about your account and activities, address disputes and safety
concerns, maintain accurate records, and protect the service. We may use combined
or de-identified information to understand club participation, provided the
results do not identify a member.

Where FIPPA applies to SFU-controlled information, the collection notice shown
when the information is requested must identify the purpose, the legal authority
for collection, and an SFU contact who can answer questions. The authority and
exact notice for this app are: `[insert wording approved by SFU Recreation and the
SFU Access and Privacy Program]`. This policy does not replace a required
collection notice at signup or at a new point of collection.

We will not use information for a materially different purpose without the notice,
authority, or consent required for that use. Optional promotional messages are a
separate choice from essential account, safety, or event messages. You can turn
optional notifications off in Settings.

## 4. Visibility within and outside the Club

Signed-in members may see your display name, rating, ladder position, and match
information needed to use the ladder. Other participants may see your name in an
event roster or match schedule when needed for that activity.

**Your name and rating appear on the public leaderboard by default.** You can turn
that off in Settings at any time, which stops future display by the app. Copies or
screenshots made by other people may remain outside our control.

> **Written to match the app, not to flatter it.** The earlier draft said the
> leaderboard was opt-in. It is not. `hide_from_leaderboard` defaults to false and
> `profile_visibility` defaults to `public`, and on production 38 of 40 members are
> publicly visible, almost certainly because they never changed a setting rather
> than because they chose to. Reviewer: if opt-in is required, this is an app
> change plus a re-prompt of the existing members, not a wording change.

**Photographs and video are opt-in and are not published without your permission.**
Photo and video consent is off unless you turn it on, it is separate from the
participation waiver, and you can withdraw it at any time in Settings. Withdrawing
it does not affect your membership or your access to any club activity. Images
already published before you withdrew may remain in circulation outside our
control.

Club executives may access activity information needed for their duties.
Administrators may also access contact details, membership and fee status, and
records needed for support or oversight. Access is assigned by role and is removed
when a person no longer needs it.

## 5. Sharing and service providers

We may share information with SFU Recreation or an appropriate University office
to administer the club, respond to a safety or conduct matter, meet a legal
requirement, or handle a privacy request. We may share information with emergency
services or other authorities when necessary and legally permitted. We do not sell
member information.

The app relies on these outside services, which process information only to provide
their service:

| Provider | What it receives | Why |
| --- | --- | --- |
| Resend | Your email address and the delivery result | Sending you mail at all: sign-in codes, session reminders, notices about your account. |
| Sentry | Technical error reports, which can include identifiers tied to your account | Diagnosing failures. Named here rather than treated as anonymous, because those identifiers exist. |
| Discord | Your Discord user ID, only if you link your Discord account | Matching you to your membership and assigning roles. |
| Google | Your Google account identifier and email address, only if you sign in with Google | Sign-in. |
| Cloudflare | Your IP address and request details | All traffic to the site passes through it. |
| Google Drive | A nightly encrypted backup of the club database, which includes your record | Off-site backup. Google holds ciphertext only and cannot read it. |

`[Storage and access locations require SFU review. Every provider above is likely
to store or access information outside Canada, which is the specific point SFU
must assess for information in its custody or control.]`

Analytics software is present in the app's code but is **switched off in
production and collects nothing**, which is why it is not listed above. If it is
ever switched on it gets added here in the same change, and a test in the codebase
fails until a newly added third-party service is named both here and in the member
data export.

## 6. Security and incident response

We use secure sign-in, access restrictions, database controls, encrypted off-site
backups, and review of administrative access. We limit access to people who need
the information for a club or Recreation role. If you suspect unauthorized access,
an exposed record, or an account takeover, contact `privacy@sfubadminton.com`
promptly. We will work with SFU Recreation and SFU's privacy office to assess and
respond to a suspected breach involving SFU-controlled information.

## 7. Retention, deletion, and backups

You can delete your account yourself in Settings, or ask us at
`privacy@sfubadminton.com`. The app deactivates the account immediately and lets
you restore it by signing back in for 30 days. After that window, sign-in access
and direct profile identifiers are removed from the active account. Member-visible
history may show "Deleted Player". A match, attendance, or decision record may
still be identifiable through its context, so we will not call all retained
records anonymous.

| Record | Retention and disposition |
| --- | --- |
| Active account and profile | Kept while the account is active. After a deletion request, held for the 30-day restoration period, then direct identifiers are removed from the active account, subject to required retention. |
| Off-site database backups | Kept 14 days, then permanently deleted. A deletion must be reapplied if a backup is restored. |
| Match, rating, and event history | Retained for `[SFU-approved period and disposition]`; member-visible history may be de-identified after account deletion. |
| Attendance, fee, and reliability records | Retained for `[SFU-approved period and disposition]`. |
| Acceptance, audit, dispute, and incident records | Retained for `[SFU-approved period and disposition for each record type]`. |

Information used to make a decision directly affecting a person will be retained
for at least the period required by applicable law and the relevant SFU schedule.
An active investigation, legal hold, or other legal obligation may require longer
retention. When retention ends, we will securely delete or de-identify the
information as the approved schedule requires.

> **The backup row is now accurate and was not before.** The off-site sweep used
> to send expired backups to the storage provider's trash rather than deleting
> them, where they sat for roughly 30 further days: 30 in the trash against 15
> live when it was measured. Fixed 2026-09-22, and the stale copies were
> permanently removed. A retention window is a privacy control, because a member's
> deletion is only real once the backups holding them age out, so this row has to
> state the real number.

## 8. Your choices and requests

Three of these you can do yourself, right now, without asking anyone:

- **Download everything held about you.** Settings, then your data. It produces a
  single file covering every table the club holds about you, and it also lists
  what is *not* included and why, so you can see the limits of it rather than
  having to trust that it is complete.
- **Delete your account.** Settings, then delete account. See section 7.
- **Change your visibility and your photo consent.** Settings.

You may also update profile information and manage optional notifications in
Settings. For anything else, including a correction you cannot make yourself, a
request for how your information has been used or disclosed, or a privacy concern,
email `privacy@sfubadminton.com`. For SFU-controlled information you may also
contact `privacy@sfu.ca`. We may need to verify your identity before giving access
or making a change. Account deletion does not erase records that must be kept under
an applicable retention requirement.

## 9. Participants under 19

Eligibility and required participation forms are determined under SFU Recreation's
rules. If a participant is under 19, the Club will follow the process specified by
Recreation and Risk Management for any parent or guardian permission or
acknowledgement. A minor's in-app checkbox will not be treated as a legal waiver.

> The app does not currently implement this. See "Implementation gaps" in the
> participation waiver: there is no parent-signer model, and the only age record
> today is a checkbox the member ticks themselves.

## 10. Changes and questions

The app shows the current version and effective date. We will notify members of
material changes and seek a new choice or consent before a new use or disclosure
when required. Send questions about this policy or the app's handling of
information to `privacy@sfubadminton.com`. For formal questions about
SFU-controlled information, contact `privacy@sfu.ca`.
