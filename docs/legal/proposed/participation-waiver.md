# SFU Badminton Club: Participation Waiver and Parent Permission

**Draft for SFU Recreation and Risk Management review. Do not collect signatures
on this version until they approve the activity, release wording, signers,
electronic process, and record retention.**

Version: `[version]`
Effective date: `[date]`
Covered activities: `[regular badminton sessions, warmups, ladder matches, tournaments, or other specifically approved activities]`
Covered venues: `[list venues]`
Coverage period: `[start date]` to `[end date]`

> **Two things in this document cannot be implemented by the app as it stands.**
> They are flagged inline at the points where they bite, and collected in
> "Implementation gaps" at the end. Neither is a wording problem, so neither is
> fixed by approving different wording.

## Part A: Adult participant release (age 19 or older)

### 1. Participation and risks

I choose to take part in the activities listed above. I understand that badminton
and related activities involve physical exertion and risks, including muscle
strains, sprains, falls, collisions with other players, and contact with rackets,
shuttles, courts, and equipment. Injuries may be serious. Risks may arise from my
actions, the actions of other participants, the condition of a venue or equipment,
and the way an activity is organized or supervised.

I will follow the Club's Code of Conduct, applicable SFU Recreation and venue
rules, and reasonable safety instructions. I will use equipment suitable for the
activity, play within my abilities, and stop and tell an organizer if I feel
unwell, am injured, or see a hazard. I understand that the Club cannot remove
every risk of participation.

### 2. Voluntary assumption of risk

I understand the risks described above and voluntarily accept the risks ordinarily
associated with my participation in the covered activities. I have had an
opportunity to ask questions before signing.

### 3. Release of claims

In consideration of being allowed to participate in the covered activities, I
release SFU Badminton Club and its executives and volunteers acting in connection
with those activities (the Released Parties) from claims for personal injury,
death, property loss, or damage arising from my participation, **including claims
caused by the ordinary negligence of a Released Party**, to the extent the law
permits. This release does not apply to gross negligence, wilful misconduct, or
claims that cannot legally be waived.

**I understand that this section may give up my right to sue the Released Parties
for claims within its scope.**

This draft names only the Club, its executives, and volunteers. Any addition of
Simon Fraser University, SFU Recreation, a venue, a sponsor, or another party
requires that party's and SFU Risk Management's review and approval.

> **For the reviewer.** The Club is a student-led Sport Club and may not be a
> separate legal entity. Please confirm who the release actually runs to, and
> whether an unincorporated club can hold one, before this is relied on.

### 4. Emergency response

If I am injured or become ill during an activity, I authorize a Club organizer to
call campus security or emergency services and provide responders with information
reasonably needed to assist me. Medical professionals will make treatment
decisions under applicable law. I am responsible for costs lawfully charged to me
for my care or transport.

### 5. Club participation

The Club uses completion of this form as a requirement for access to the covered
Club activities. Once the Club confirms completion, I may participate subject to
the activity's published eligibility, capacity, and safety rules. The Club will
tell me before a particular activity if its venue or organizer requires an
additional registration or form.

### 6. Photographs and video are not covered by this form

This form does not ask for, and does not give, permission to photograph or film
me or to publish images of me. That permission is a separate, optional choice in
the app, it is off unless I turn it on, and I can withdraw it at any time in
Settings without affecting my participation. Nothing about my access to club
activities depends on it.

Consent bundled into a document somebody must accept in order to play is not
freely given, which is why it is kept out of this one.

### 7. Adult acknowledgement and signature

I confirm that I am at least 19 years old, have read this entire document,
understand its effect, and am signing voluntarily.

Full legal name: `[participant name]`
Signature: `[method approved by SFU Recreation and Risk Management]`
Date and time: `[recorded timestamp]`
Document version: `[recorded version]`

For an electronic process, present the full document before signature, use a
separate unchecked acceptance control, allow the signer to save a copy, and retain
an auditable record of the exact version accepted. SFU Recreation and Risk
Management must approve the electronic method before use.

> **Gap 1: the app does not let a signer save a copy.** The acceptance is recorded
> with its version and timestamp, and the member can download their own data
> export, but there is no "save this document" step at the point of signing.

## Part B: Parent or guardian permission for a participant under 19

**This section gives permission to participate and acknowledges the activity's
risks. It is not a release of the young participant's legal claims. Use the
process and form approved by SFU Recreation and Risk Management for minors.**

Young participant's full name: `[name]`
Date of birth or age: `[collect only what SFU approves]`
Parent or legal guardian's full name: `[name]`
Relationship to participant: `[relationship]`
Parent or guardian contact: `[approved contact information]`

I am the parent or legal guardian of the participant named above. I have read the
activity description and risks in Part A, section 1. I give permission for the
young participant to take part in the covered activities during the period stated
above, subject to SFU Recreation's eligibility and facility rules. I understand
that badminton involves physical exertion and risks of injury. I will ensure the
participant knows to follow safety instructions, stop if unwell or injured, and
tell an organizer about a hazard.

I authorize a Club organizer to call campus security or emergency services if the
participant is injured or becomes ill. I understand that any additional
medical-consent or emergency-contact form required by SFU Recreation must be
completed separately.

Parent or guardian signature: `[method approved by SFU Recreation and Risk Management]`
Date and time: `[recorded timestamp]`
Document version: `[recorded version]`

The Club must verify that the required parent or guardian permission has been
completed before allowing an under-19 participant to join the covered activity. A
minor's own checkbox is not a substitute for parent or guardian approval.

If this is completed in the app, send the form to the parent or guardian through
an approved signing flow. Record the parent or guardian as the signer separately
from the young participant. Do not let the participant confirm on a parent's
behalf.

> **Gap 2, and it is the serious one: the app currently does the exact thing the
> paragraph above forbids.** Acceptance is one row per member per document plus an
> `age_attestation` boolean that the *member* ticks, covering all four documents
> at once. Measured on production: 156 acceptance rows, every one with
> `age_attestation = true`, which is four documents times thirty-nine members.
> There is no parent record, no second signer, and no way to represent one. Part B
> is a schema and flow change, not a wording change, and until it is built the
> club has no parent permission on record for anybody.

## Implementation gaps

Collected so the reviewer and the club see the same list.

1. **No parent-signer model.** Part B cannot be recorded. See Gap 2 above.
2. **No "save a copy" at signing.** See Gap 1 above.
3. **The coverage period is a different model from the one the app implements.**
   This document defines a fixed window with a start and an end date. The app
   re-prompts 365 days after each individual signature and gates access on the
   version string, so two members who signed in different months are on different
   clocks. A fixed club-wide period means re-prompting everyone at the same
   moment instead. Pick one before this ships, because they produce different
   behaviour for every member.
4. **Media consent does not exist yet.** Section 6 above describes a control that
   is being built, not one that ships today. Do not publish section 6 before that
   control is live, or the document describes a choice members cannot make.
