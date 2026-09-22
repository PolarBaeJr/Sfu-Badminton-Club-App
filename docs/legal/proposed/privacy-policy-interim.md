# Privacy policy: interim correction

**Ship this in the same sitting as `waiver-interim.md`, on Friday 2026-09-25.**
Each published document bumps its own version independently, and each bump
prompts all 40 members again. Doing the waiver on Friday and the privacy policy
next week is two interruptions for one outcome.

This is not the rewrite in `privacy-policy.md`. That one is pending SFU
Recreation and the SFU Access and Privacy Program, and it cannot be published
while four retention periods are still `[SFU-approved period and disposition]`.

## What is being corrected

Two things, both small, neither needing anyone's approval.

**1. The document tells members to "contact a club executive" and gives them no
way to do it.** It says this twice, at the end of section 7 (Your rights) and
again as the whole of section 10 (Contact), which are the two places a member
goes when they want their data or want to complain. The club now
has routed addresses, so the policy can name one. A privacy request that has to
be guessed at is a privacy request that does not get made.

**2. It discloses analytics the club does not actually collect.** Section 4 lists
"usage analytics" among the third-party services in use. The analytics package is
in the app's code but is switched off in production and collects nothing.
Over-disclosure is the less dangerous direction to be wrong in, but it is still
wrong, and it makes the list of who receives member data unreliable in the one
document whose job is to be reliable about that.

The 14-day backup retention line in section 6 needed correcting last week and no
longer does. It became true on 2026-09-22, when the off-site sweep started
actually deleting rather than trashing. Leave it as it stands.

## How to apply it

**Paste `final/privacy_policy.md` whole.** It is the live document with these
four lines changed and nothing else, built by script from the live export rather
than retyped, and `diff`ed against it to prove only those four lines moved. Give
a reason, and press **Publish and require re-sign**, not **Publish
quietly**. See `final/README.md` for what those two buttons differ on.

The four edits are listed below so a reviewer can see what changed without
diffing, and so they can be applied by hand if the console's editor is easier to
work in that way. If you do it by hand, note that the two lines carrying an em
dash keep it: the surrounding list uses that punctuation throughout, and one
bullet in a different style is a visible defect in a document members read.

### Section 2, the account and technical data line

Find:

> - **Account & technical data** — login sessions and, where enabled, basic error and usage analytics.

Replace with:

> - **Account & technical data** — login sessions and basic error reports.

### Section 4, the service providers line

Find:

> - **Service providers:** we use third-party services to run the app — email delivery, error monitoring and usage analytics, and our hosting and database infrastructure. They process data only to provide their service.

Replace with:

> - **Service providers:** we use third-party services to run the app — email delivery, error monitoring, sign-in, and our hosting, network and backup infrastructure. They process data only to provide their service. We do **not** run usage analytics: the software is present in the app's code but is switched off and collects nothing.

### Section 7, the closing line of Your rights

Find:

> To exercise any of these, use the app's Settings or contact a club executive.

Replace with:

> Three of these you can do yourself in Settings right now, without asking anyone: download everything we hold about you, delete your account, and change your visibility. For anything else, email `privacy@sfubadminton.com`.

### Section 10, Contact

Find:

> Questions or requests: contact a club executive.

Replace with:

> Privacy questions and requests: `privacy@sfubadminton.com`. Anything else about the club or the app: `exec@sfubadminton.com`. If your concern is about the club's own executives, SFU Recreation can be reached at `sport_clubs@sfu.ca`.

## What this deliberately does not do

- **It does not add retention periods.** Those are Recreation's, and the live
  document is currently silent rather than wrong, which is the safer of the two.
- **It does not settle FIPPA against PIPA.** The live document does not claim an
  answer, so nothing needs correcting until Recreation gives one.
- **It does not name the six service providers individually.** That belongs with
  the out-of-Canada assessment in the full rewrite. Correcting the analytics
  claim is separable from it and does not have to wait.
