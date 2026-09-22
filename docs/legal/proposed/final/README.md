# Paste-ready text for Friday 2026-09-25

Two files, each holding one document and nothing else. No heading above it, no
commentary inside it, no effective-date line: what is in the file is exactly what
belongs in `legal_documents.content`, so it can be selected whole and pasted
without anyone having to judge where the document starts and stops.

| File | Replaces | Reasoning lives in |
| --- | --- | --- |
| `waiver.md` | `legal_documents.content` where `document = 'waiver'` | `../waiver-interim.md` |
| `privacy_policy.md` | `legal_documents.content` where `document = 'privacy_policy'` | `../privacy-policy-interim.md` |

Both were built from `docs/legal/live/`, which is a byte-exact export of what is
on production today, and `diff`ed back against it. The waiver changes four
passages in three sections; the privacy policy changes exactly four lines and was
produced by script rather than retyped, so nothing else could drift. Run the diff
yourself before publishing if you want to see it:

```
diff docs/legal/live/waiver.md docs/legal/proposed/final/waiver.md
diff docs/legal/live/privacy_policy.md docs/legal/proposed/final/privacy_policy.md
```

## Publishing

Admin console, **Legal**. For each document: select it, replace the editor
contents with the file, tick **bump version**, type a reason, publish.

**Do both in the same sitting.** Each bump re-prompts all 40 members on their
next visit, and the two documents version independently, so publishing a week
apart interrupts everyone twice for one outcome.

**Publish Friday morning, not Friday evening.** There is a session at 19:30 that
day. The gate is not a soft prompt: `assertCurrentWaiver` in
`apps/player/src/lib/actions/_shared.ts` throws on check-in, challenges and
tournament registration until every document is accepted at its current version.
Publish in the morning and most members clear it on their own during the day;
whoever does not spends about thirty seconds on it at the door, and plays that
session under the corrected release rather than the old one. Publishing after
the session instead would spare the door queue, at the cost of one more evening
played under a waiver that never names ordinary negligence. The morning is the
better trade. Either way the version still reads `2026-09-25`, because
`clubToday()` works in the club's own timezone.

**Do not type a version.** `updateLegalDocument` stamps it from the club's own
today via `clubToday()`, which is why a Friday-evening publish no longer comes
out dated Saturday. Publishing on 2026-09-25 yields version `2026-09-25`. A
second publish of the same document on the same day appends `.2`.

The reason field is stored on the audit row and is required to be at least a few
characters, enforced server-side rather than only in the form. Write something a
future reader can use. Suggested:

- Waiver: `Release now names ordinary negligence, acknowledgement states plainly that accepting gives up a right to sue, and section 5 no longer claims a guardian can accept the release for a minor.`
- Privacy policy: `Names privacy@sfubadminton.com where the document previously said only "contact a club executive", and removes the disclosure of usage analytics, which is switched off in production and collects nothing.`

## After publishing, refresh `docs/legal/live/`

`docs/legal/live/` is a byte-exact export of production. The moment these two are
published it stops being that, and the repo is back to the drafts-disagree-with-
live problem this whole directory exists to prevent. Nothing catches it on its
own: `legal-doc-version-contract.test.ts` compares the **seed migration** to
`docs/legal/*.md`, neither of which moves on Friday, and its own comment admits
it cannot reach a database. It will stay green while the drift exists.

The refresh is a copy, not a re-export, because these files are what was pasted:

```
cp docs/legal/proposed/final/waiver.md docs/legal/live/waiver.md
cp docs/legal/proposed/final/privacy_policy.md docs/legal/live/privacy_policy.md
```

Then confirm production actually holds those bytes before committing:

```
md5 docs/legal/live/waiver.md docs/legal/live/privacy_policy.md
```

and compare against the same hash taken over `legal_documents.content` on prod.
If they disagree, the console editor changed something on the way in (a trailing
newline, a smart quote) and the live export, not the paste, is the truth.

## What these are not

They are not the rewrites in `../participation-waiver.md`,
`../privacy-policy.md`, `../code-of-conduct.md` and `../terms-of-use.md`. Those
are pending SFU Recreation and Risk Management, still carry `[version]`,
`[date]` and `[SFU-approved period and disposition]` placeholders, and the
waiver's Part B needs a parent-signer model the app does not have. They cannot
be published and these do not replace them: every change here either narrows
what the club claims or states plainly something the document already relied on.

The code of conduct and the terms of use are unchanged. Nothing in them is wrong
enough to spend a version bump on this week.

## One coupling worth noticing

The new section 7 points members at the data export by name and tells them they
can run it themselves in Settings. Today's production code can. The branch
waiting to deploy cannot unless migration `00241` lands first: production is on
`00238`, and the export reads a table `00241` creates, so deploying the branch
against a `00238` database makes every member data export fail while the privacy
policy is advertising it as a right. `00241` goes before or with that deploy,
not after.
