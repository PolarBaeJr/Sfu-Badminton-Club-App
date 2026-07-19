-- ============================================================
-- 00010_waivers.sql — Liability waiver & code of conduct
--
-- Adds legal_documents (the live, admin-editable text of the
-- liability waiver and code of conduct, one row per document)
-- and waiver_acceptances (immutable per-player acceptance
-- evidence: document, version, timestamp, 19+/guardian-consent
-- attestation). Bumping a document's version requires members
-- to re-accept before playing.
-- ============================================================

-- ============================================================
-- LEGAL DOCUMENTS
-- ============================================================

CREATE TABLE legal_documents (
  document TEXT PRIMARY KEY CHECK (document IN ('waiver', 'code_of_conduct')),
  version TEXT NOT NULL,
  content TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_by UUID REFERENCES players(id) ON DELETE SET NULL
);

-- Seed the live text (adapted from docs/legal/liability-waiver.md and
-- docs/legal/code-of-conduct.md drafts). Editable in Admin → Settings.
INSERT INTO legal_documents (document, version, content) VALUES
('waiver', '2026-07-19', $waiver$## 1. Assumption of risk

I understand that badminton and related physical activity involve inherent risks, including but not limited to: muscle strains, sprains, falls, collisions, contact with equipment (rackets, shuttles), and other injuries. I voluntarily choose to participate and **accept these risks**.

## 2. Fitness to participate

I confirm that I am physically able to participate, or have obtained medical clearance to do so. I am responsible for stopping if I feel unwell or injured.

## 3. Release

To the extent permitted by law, I release SFU Badminton Club, its executives, volunteers, and the venues where club activities take place from liability for injury, loss, or damage arising from my participation, **except** where caused by gross negligence or willful misconduct.

## 4. Emergency care

I consent to the club arranging emergency medical care if needed. I am responsible for any resulting costs.

## 5. Age and consent

I confirm that I am 19 years of age or older, or that I have my parent or guardian's consent to participate in club activities and to accept this waiver.

## 6. Acknowledgement

I have read and understood this waiver. I am accepting it freely. By accepting in the app, I agree to the above, and this acceptance is recorded with the date and the version of this document.$waiver$),
('code_of_conduct', '2026-07-19', $conduct$## Our commitment

SFU Badminton Club is a welcoming, inclusive community for players of all skill levels. Everyone deserves to play and participate free from harassment and discrimination. This Code of Conduct applies to all members, at all club activities (sessions, tournaments, socials) and in the club app.

## Expected behaviour

- **Respect** everyone — teammates, opponents, execs, and staff.
- **Play fairly** — honest scoring, honest results, no cheating.
- **Be inclusive** — welcome new and less-experienced players.
- **Look after the space** — the venue, equipment, and shuttles.
- **Follow** venue rules and exec instructions.

## Fair play & the ladder

Because the club runs a competitive ladder, integrity matters:

- **Report results honestly.** Don't inflate or fabricate scores.
- **No sandbagging** — don't deliberately lose or manipulate your rating.
- **No collusion** — don't arrange fake results to move ratings.
- **Show up** for challenges and events you commit to; repeated no-shows affect your reliability.

Violations of ladder integrity may result in rating corrections, match voids, or loss of ladder eligibility.

## Unacceptable behaviour

- Harassment, discrimination, or bullying of any kind (including on the basis of race, gender, sexual orientation, religion, disability, or skill level).
- Threats, intimidation, or violence.
- Unwanted physical contact or sexual harassment.
- Cheating or deliberate manipulation of the ladder.
- Damaging the venue or equipment.
- Any conduct that violates SFU policies or the law.

## Reporting

If you experience or witness a violation, contact a club executive. Reports will be handled discreetly and taken seriously.

## Consequences

Depending on severity, consequences may include a warning, temporary suspension from activities or the ladder, or removal from the club. Serious matters may be escalated to SFU or the appropriate authorities.

## Acknowledgement

By participating in club activities and using the app, members agree to follow this Code of Conduct.$conduct$);

-- ============================================================
-- WAIVER ACCEPTANCES
-- ============================================================

CREATE TABLE waiver_acceptances (
  id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  document TEXT NOT NULL CHECK (document IN ('waiver', 'code_of_conduct')),
  version TEXT NOT NULL,
  accepted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  age_attestation BOOLEAN NOT NULL DEFAULT false,
  user_agent TEXT,
  UNIQUE(player_id, document, version)
);

-- ============================================================
-- RLS
-- ============================================================

ALTER TABLE legal_documents ENABLE ROW LEVEL SECURITY;
ALTER TABLE waiver_acceptances ENABLE ROW LEVEL SECURITY;

-- Legal documents: read-only for authenticated users. Writes go through the
-- admin app's service-role client (bypasses RLS), so there are deliberately
-- no INSERT/UPDATE policies.
CREATE POLICY legal_docs_select ON legal_documents FOR SELECT TO authenticated USING (TRUE);

-- Players can read their own acceptances; admins can read all
CREATE POLICY wa_select ON waiver_acceptances FOR SELECT TO authenticated
  USING (player_id = get_player_id(auth.uid()) OR is_admin(auth.uid()));

-- Players can insert their own acceptance rows
CREATE POLICY wa_insert ON waiver_acceptances FOR INSERT TO authenticated
  WITH CHECK (player_id = get_player_id(auth.uid()));

-- Deliberately NO UPDATE/DELETE policies for anyone: acceptance rows are
-- immutable evidence of what was accepted, when, and under which version.
