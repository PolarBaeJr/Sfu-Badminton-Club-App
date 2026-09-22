# Liability Waiver & Assumption of Risk

> **The live text is in the database, not in this file.** Members read and
> accept `legal_documents.content`, edited in Admin → Settings → Legal
> documents. This file is the source it was drafted from, kept for history.
> Where the two differ, the database is what members agreed to.

> **Nobody with legal standing has reviewed this, and that is still true of the
> live text.** A liability release in British Columbia turns on its wording, and
> two limits apply no matter how it is worded: a release cannot cover gross
> negligence or willful misconduct, and in BC a parent cannot waive a minor's
> own claim. Section 5 below asks under-19 members to confirm a guardian's
> consent, which is worth having, but it is consent to participate and is not
> the same thing as a release. Getting this in front of SFSS or SFU club risk
> resources is the outstanding item.

**Participant:** the member accepting this waiver in the app.
**Organization:** SFU Badminton Club ("the Club").

---

## 1. Assumption of risk

I understand that badminton and related physical activity involve inherent risks, including but not limited to: muscle strains, sprains, falls, collisions, contact with equipment (rackets, shuttles), and other injuries. I voluntarily choose to participate and **accept these risks**.

## 2. Fitness to participate

I confirm that I am physically able to participate, or have obtained medical clearance to do so. I am responsible for stopping if I feel unwell or injured.

## 3. Release

To the extent permitted by law, I release SFU Badminton Club, its executives, volunteers, and the venues where club activities take place from liability for injury, loss, or damage arising from my participation, **except** where caused by gross negligence or willful misconduct.

## 4. Emergency care

I consent to the Club arranging emergency medical care if needed. I am responsible for any resulting costs.

## 5. Media consent (NOT ADOPTED)

Drafted, never shipped. The live waiver has no media-consent clause and the app
asks for no such consent, so the club currently has no permission on record to
use photos or video of a member for promotion. If that is wanted it belongs in
its own optional checkbox, not bundled into the release: consent buried inside a
document somebody must accept to play is not freely given.

> I `[ ] consent / [ ] do not consent` to the Club using photos/video of me from club activities for club promotion.

## 6. Emergency contact (NOT ADOPTED)

Drafted, never shipped. The live waiver does not collect one and there is no
field for it, so in an emergency the club has nobody to call. Worth fixing, and
it is a profile field rather than waiver text.

> I will provide an emergency contact: `[Name] — [Phone]`.

## 7. Acknowledgement

I have read and understood this waiver. I am accepting it freely. I confirm that
I am 19 years of age or older, or that I have my parent or guardian's consent to
participate in club activities and to accept this waiver.

By accepting in the app, I agree to the above, and this acceptance is recorded with the date and the version of this document.

---

## Notes for implementation (delete before publishing)

- The app **records** waiver acceptance with a **version number** and **timestamp**, as append-only records, so re-acceptance can be required when the document changes each season/term. The waiver must be re-signed every 365 days. This shipped on 2026-07-19; it is no longer a plan.
- Keep **media consent** and **emergency contact** as separate optional fields — don't bundle non-essential consent into the core waiver.
- **Age of majority: settled 2026-09-22.** BC's is 19, and the club takes the
  self-declared confirmation above rather than a hard age floor or a separate
  guardian signature. The wording here is the wording already live in prod, so a
  reviewer is looking at what members actually accepted, not at a draft.

*Template drafted for the Club's own use. Legal review required.*
