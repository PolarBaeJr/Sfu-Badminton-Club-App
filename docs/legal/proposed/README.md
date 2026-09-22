# Proposed legal documents

The intended replacements for what members currently accept. **None of these is
in force, and none can be published as it stands.**

There are now three states under `docs/legal/`, and keeping them apart is the
point:

| Where | What it is |
| --- | --- |
| `docs/legal/live/` | Byte-exact export of `legal_documents.content` on production. What members actually accepted. Do not edit as a draft. |
| `docs/legal/*.md` | The older source drafts the live text was written from. Superseded by this directory, kept for history. |
| `docs/legal/proposed/` | These files. Pending SFU Recreation and Risk Management review. |

They are here rather than over `docs/legal/*.md` for two reasons: the drift test
at `apps/admin/src/lib/__tests__/legal-doc-version-contract.test.ts` pins a real
effective date in those files against the version seeded in the migrations, and
these carry `[version]` and `[date]` placeholders that cannot be filled until a
version is approved.

## What blocks publication

**Needs Recreation or Risk Management, and the club cannot supply it:**

- Approval of the release wording, the signers, the electronic signing method, and
  record retention. The waiver says so on its own first line.
- Four retention periods in the privacy policy, each `[SFU-approved period and
  disposition]`.
- The FIPPA collection notice wording and legal authority.
- Service-provider storage and access locations, specifically the out-of-Canada
  assessment.
- Confirmation that `sport_clubs@sfu.ca` is current, and that the Club is a body
  a release can actually run to.

**Needs app work, and no wording change fixes it:**

- **No parent-signer model.** The proposed waiver forbids a minor confirming on a
  parent's behalf. That is exactly what the app does today: one acceptance row per
  member per document plus an `age_attestation` boolean the member ticks, 156 rows
  on production with every one set true. Part B cannot be recorded at all until
  this is built.
- **No "save a copy" at signing.**
- **Media consent does not exist yet.** It is being built on `feat/media-consent`.
  Until it ships, the sections describing it are describing a control members
  cannot use.
- **The coverage period is a different model from the one implemented.** These
  drafts define a fixed club-wide window with a start and an end. The app
  re-prompts 365 days after each individual signature, so members are on
  independent clocks. Pick one; they behave differently for every member.

## Changes made to the supplied drafts

1. **Contacts are the club's own routed addresses** (`exec@`, `privacy@`,
   `conduct@` `sfubadminton.com`) instead of `badminton@sfu.ca`, which may not
   exist. `sport_clubs@sfu.ca` and `privacy@sfu.ca` are kept only as escalation to
   a different body, never as the club's own contact, because a route that lands
   with the same executives a complaint is about is not a route.
2. **The leaderboard paragraph now describes opt-out, because that is what the app
   does.** The supplied draft asked for this to be confirmed and said "only if you
   choose public visibility". Checked on production: `hide_from_leaderboard`
   defaults to false, `profile_visibility` defaults to `public`, and 38 of 40
   members are publicly visible. Opt-in would be an app change plus a re-prompt.
3. **The FIPPA question is marked open rather than answered.** The supplied drafts
   routed everything through SFU, which quietly settles a question that is still
   with Recreation. The consequence is stated: 30 business days under FIPPA against
   30 calendar days under PIPA, and PIPA additionally requires a designated privacy
   officer.
4. **Media consent added** to the privacy policy sections 2 and 4, the waiver
   (section 6, saying explicitly that it is *not* part of the release), and the
   terms section 10.
5. **The self-serve data export and self-serve deletion are now stated.** The
   supplied draft said to email for access. The app is better than that and the
   document should say so.
6. **Service providers are named** rather than left as a placeholder: Resend,
   Sentry, Discord, Google, Cloudflare, Google Drive, with what each receives. The
   location assessment stays a placeholder because only SFU can do it.
7. **The backup retention row is stated flatly as 14 days,** with the conditional
   removed, because it became true on 2026-09-22. It was not before: the sweep
   trashed rather than deleted, leaving roughly 30 extra days.
8. **App gaps are flagged inline** at the point they bite, and collected at the end
   of the waiver, so a reviewer is not asked to approve text the software cannot
   honour.
