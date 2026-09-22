# Participation waiver: interim correction

**This is the one that can ship on Friday 2026-09-25.** It is not the rewrite in
`participation-waiver.md`. That one is pending SFU Recreation and Risk
Management, carries unfilled placeholders, and its Part B needs a parent-signer
model the app does not have. Waiting for all three means the live waiver keeps
its current defects for as long as Recreation takes to answer.

This file is the live waiver (`docs/legal/live/waiver.md`, version `2026-07-19`)
with three corrections and nothing else. Every change narrows what the document
claims or states plainly something it already relied on. None of them needs
Recreation's approval, because none of them asks members to give up anything the
current text does not already ask for, and none needs app work.

## How it gets published

Admin console, **Legal**, select the waiver, paste the text below, tick
**bump version**, give a reason, publish.

The version string is stamped automatically from the club's own today, so
publishing on Friday makes it `2026-09-25`. Do not type a version.

A bump forces all 40 members to re-accept on their next visit. That is the point,
and it is also why the privacy policy's corrections should go in the **same
sitting**: two bumps in one week is two interruptions for one outcome.

## The three corrections

**1. Section 3 now says what the release covers.** The live text releases the
club "from liability for injury, loss, or damage" and then carves out gross
negligence. It never says the word negligence in the part that grants the
release. A release is read narrowly against the party relying on it, so a release
that does not name ordinary negligence is at real risk of not covering it, which
is the main thing a waiver exists to cover. Naming it is not a widening: the
carve-out for gross negligence and willful misconduct stays exactly as it was.

**2. Section 6 says out loud that this is a release.** The live acknowledgement
says the member has read and understood the document. It does not tell them what
accepting it does. Where a release contains a term a signer would not expect, the
party relying on it is expected to have taken reasonable steps to bring it to
their attention. A conspicuous line costs nothing and is the cheapest thing on
this entire list.

**3. Section 5 stops claiming a guardian can accept the release.** The live text
reads "or that I have my parent or guardian's consent to participate in club
activities **and to accept this waiver**". The trailing phrase is the problem. A
parent or guardian cannot give up a minor's own legal claims. The sentence as
written asks a member to confirm something that is not true and that the club
cannot rely on, and it does it through a checkbox the minor ticks themselves.

Dropping the phrase does not create a parent-signer model and does not pretend
to. It stops the document overstating what the club holds. The replacement says
what is actually true today: the guardian's permission covers participation, the
release does not reach a minor's claims, and the club is not treating a
checkbox as a signature.

**The sentence has to stay one clause, joined by "or".** There is a single
checkbox behind all four documents (`age_attestation`), so whatever section 5
asserts, a member asserts all of it at once. An earlier draft of this correction
split it into a flat "I am 19 or older" followed by a separate "if I am under
19" paragraph. That reads fine to an adult and is a trap for anyone else: a
17-year-old ticking the one box would be asserting they are 19, which is a false
statement the live document never asked for. The live text was disjunctive for a
reason and the correction keeps it that way. Fixing this properly needs the
parent-signer model, which is app work, not wording.

## The text to paste

**It lives in `final/waiver.md`, not here.** That file holds the document and
nothing else: no heading, no commentary, no effective date line. What is in it is
exactly what goes into `legal_documents.content`, so it can be selected whole and
pasted without anyone having to judge where the document starts and stops.

A copy follows for reading. `final/waiver.md` is the authoritative one; if these
ever disagree, that file wins.

---

## 1. Assumption of risk

I understand that badminton and related physical activity involve inherent risks, including but not limited to: muscle strains, sprains, falls, collisions, contact with equipment (rackets, shuttles), and other injuries. I voluntarily choose to participate and **accept these risks**.

## 2. Fitness to participate

I confirm that I am physically able to participate, or have obtained medical clearance to do so. I am responsible for stopping if I feel unwell or injured.

## 3. Release

To the extent permitted by law, I release SFU Badminton Club, its executives, volunteers, and the venues where club activities take place from liability for injury, loss, or damage arising from my participation, **including where it is caused by their ordinary negligence**.

This release does **not** apply to gross negligence or willful misconduct, and it does not apply to any right I cannot give up by law.

## 4. Emergency care

I consent to the club arranging emergency medical care if needed. I am responsible for any resulting costs.

## 5. Age and participation

I confirm that I am 19 years of age or older, or that I am under 19 and my parent or guardian knows I take part in club activities and permits it.

A parent or guardian cannot give up a minor's own legal claims, so the release in section 3 does not release the claims of a participant under 19.

## 6. Acknowledgement

**This is a legal release. By accepting it I am agreeing to take on the risks of playing badminton with the club, and I may be giving up my right to sue the club, its executives, its volunteers, or the venues if I am injured.**

I have read and understood this waiver. I am accepting it freely. By accepting in the app, I agree to the above, and this acceptance is recorded with the date and the version of this document.

---

## What this deliberately does not do

- **It does not add media consent.** That control does not exist yet. A document
  describing a checkbox members cannot find is worse than one that stays quiet.
- **It does not add a parent signer.** Section 5 now describes the limit honestly
  instead of asserting a permission the club does not hold, which is the most the
  wording can do on its own.
- **It does not set a fixed coverage period.** The app re-prompts each member 365
  days after their own signature. Changing that is an app change and a separate
  decision.
- **It does not resolve FIPPA against PIPA.** That is Recreation's to answer and
  it does not touch the waiver.
