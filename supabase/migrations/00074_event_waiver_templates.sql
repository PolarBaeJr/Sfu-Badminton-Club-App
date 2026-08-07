-- ============================================================
-- 00074_event_waiver_templates.sql — a per-season starting point
-- for the optional per-tournament event waiver
-- ============================================================
-- The problem: creating a tournament offers an "Event waiver (optional)"
-- free-text box (tournaments.waiver_text, 00015). It starts blank, so every
-- exec either retypes a waiver from memory or leaves it empty. The club owner
-- asked for a template in Legal, "by season".
--
-- ------------------------------------------------------------
-- WHY NOT A FIFTH legal_documents ROW
-- ------------------------------------------------------------
-- The obvious-looking model — INSERT a row with document =
-- 'event_waiver_template' — would lock every member out of the app on the next
-- page load. legal_documents is not a document store; it is the list of things
-- every member MUST have accepted. Three call sites read it unfiltered
-- (apps/player/src/app/layout.tsx, apps/player/src/lib/actions/_shared.ts
-- assertCurrentWaiver, apps/player/src/lib/actions/profile.ts) and hand every
-- row straight to getMissingLegalDocuments, which reports any row without a
-- current acceptance as missing and blocks check-in, challenges and
-- registration. A fifth row is instantly "missing" for all 100% of members —
-- and unfixable, because waiver_acceptances_document_check (00014) only admits
-- the four real documents, so nobody could ever record an acceptance for it.
-- Club-wide deadlock from an INSERT. The two CHECK constraints are the schema
-- saying out loud that legal_documents holds exactly four things.
--
-- Beyond that: legal_documents is keyed by `document` alone, so it has nowhere
-- to put a season. The requirement's second half has no home there at all.
--
-- ------------------------------------------------------------
-- WHY THE TEMPLATE IS COPIED, NEVER REFERENCED
-- ------------------------------------------------------------
-- tournaments.waiver_text keeps holding the literal text, and this table is
-- only ever read to pre-fill that box. It is deliberately NOT a foreign key on
-- tournaments.
--
-- event_waiver_acceptances (00015) pins each acceptance to a SHA-256 hash of
-- the exact text accepted, precisely so an edit re-requires acceptance. If a
-- tournament pointed at a template row, then editing the template — an
-- ordinary act, the club refines its wording — would retroactively change what
-- people had already agreed to, and would invalidate every acceptance hash for
-- every tournament in that season at once, mid-event. Copy-on-use means the
-- text a participant accepted is frozen on the tournament from the moment it
-- was created, which is the only defensible behaviour for a signed document.
-- The template is a drafting aid; the tournament's copy is the agreement.
--
-- ------------------------------------------------------------
-- WHY season_id IS THE PRIMARY KEY
-- ------------------------------------------------------------
-- One template per season, and the season IS the identity — there is no
-- separate surrogate id, because a second row for the same season has no
-- meaning: the "pull in the template" button would have nothing to choose
-- between. As a PK this also gives the UNIQUE that the admin action's
-- upsert(..., { onConflict: 'season_id' }) needs to be legal.
--
-- Season-scoped because that is where the text actually changes: venue,
-- insurer and SFU policy wording are renegotiated per term, and a tournament
-- already carries season_id (00001), so an event created in Fall 2026 pulls
-- Fall 2026's wording without anyone choosing it. ON DELETE CASCADE: a
-- template for a deleted season is unreachable by construction.
--
-- ------------------------------------------------------------
-- WHY RLS IS ON WITH NO POLICIES
-- ------------------------------------------------------------
-- Not an oversight, and deliberately NOT a copy of legal_docs_select's
-- USING (TRUE). No player-app path reads this table and none should: what a
-- participant is shown at registration is the tournament's own copy of the
-- text, never the template. Both readers (admin /legal, admin /tournaments)
-- and the single writer go through createAdminClient(), the service-role
-- client, which bypasses RLS. Enabling RLS with no policy therefore denies
-- every ordinary authenticated request while costing the app nothing — an
-- unreleased template for next term is club-internal drafting.
--
-- Editing stays ADMIN-ONLY in updateEventWaiverTemplate(), matching
-- updateLegalDocument(). Execs read it, exactly as they read the four
-- documents. There is no re-signature counterpart: requireReacceptance()
-- exists because the four documents are accepted club-wide, whereas a template
-- is accepted by nobody — acceptance happens per tournament, against the
-- copied text, via event_waiver_acceptances.
-- ============================================================

CREATE TABLE IF NOT EXISTS event_waiver_templates (
  season_id  UUID PRIMARY KEY REFERENCES seasons(id) ON DELETE CASCADE,
  content    TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_by UUID REFERENCES players(id) ON DELETE SET NULL
);

COMMENT ON TABLE event_waiver_templates IS
  'Per-season starting text for a tournament''s optional event waiver. Copied into tournaments.waiver_text when an exec creates an event; never referenced from it, so editing a template can never alter what a participant already accepted (event_waiver_acceptances pins a hash of the accepted text).';

COMMENT ON COLUMN event_waiver_templates.season_id IS
  'The season this wording applies to, and the primary key: one template per season. Tournaments carry season_id, so an event pulls its own season''s wording.';

ALTER TABLE event_waiver_templates ENABLE ROW LEVEL SECURITY;

-- No policies on purpose — see the header. Service-role only.

-- ============================================================
-- SEED — active season only
-- ============================================================
-- A blank template is exactly the blank box the owner complained about, so the
-- active season gets a skeleton to edit. Deliberately a fill-in-the-blanks
-- SKELETON with [BRACKETED] placeholders rather than invented indemnity prose:
-- this is a drafting aid for an exec, not reviewed legal text, and shipping
-- confident-sounding liability wording nobody's lawyer has read would be worse
-- than shipping nothing. The admin UI says the same thing above the editor.
--
-- Active season only. Templates for finished seasons are archaeology, and
-- back-filling every historical season would put placeholder text on records
-- of events that already happened. A season with no row simply offers no
-- template — the UI disables the button and says so.
INSERT INTO event_waiver_templates (season_id, content)
SELECT s.id, $tpl$## Event waiver — [EVENT NAME]

**Event:** [EVENT NAME]
**Date:** [DATE]
**Venue:** [VENUE]

> Exec: replace every [BRACKETED] placeholder and delete this line before
> publishing. Review the wording with the club executive each term — venue and
> SFU requirements change.

## 1. Assumption of risk

I understand that badminton involves inherent risks, including muscle strains,
sprains, falls, collisions, and contact with equipment. I am choosing to take
part in [EVENT NAME] voluntarily and **accept those risks**.

## 2. Fitness to participate

I confirm I am physically able to take part, or have medical clearance to do
so. I am responsible for stopping if I feel unwell or injured.

## 3. Venue rules

I agree to follow the rules of [VENUE] and any instructions given by club
executives or venue staff for the duration of this event.

## 4. Release

To the extent permitted by law, I release SFU Badminton Club, its executives
and volunteers, and [VENUE] from liability for injury, loss, or damage arising
from my participation in this event, **except** where caused by gross
negligence or willful misconduct.

## 5. Emergency care

I consent to the club arranging emergency medical care if needed, and I am
responsible for any resulting costs.

## 6. Acknowledgement

I have read and understood this waiver and accept it freely. My acceptance is
recorded with the date and a fingerprint of this text as it stood when I
accepted it.$tpl$
  FROM seasons s
 WHERE s.active_flag = TRUE
    ON CONFLICT (season_id) DO NOTHING;
