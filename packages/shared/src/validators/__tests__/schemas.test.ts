import { describe, it, expect } from 'vitest';
import {
  loginSchema,
  profileSchema,
  challengeCreateSchema,
  matchResultSchema,
  disputeSchema,
  sessionCreateSchema,
  tournamentCreateSchema,
  tournamentSuspendSchema,
  adminPlayerUpdateSchema,
  walkoverReportSchema,
  disputeResolveSchema,
  feeMarkSchema,
  seasonFeeSchema,
  sessionGroupSchema,
  manualFeeSchema,
  feeTierSchema,
  tournamentFeeMarkSchema,
  reinstatementSchema,
  reinstatementPaymentSchema,
  adminMatchCreateSchema,
  banSchema,
  playerFlagsSchema,
  reliabilityAdjustSchema,
  legalAcceptanceSchema,
  legalDocumentUpdateSchema,
  eventWaiverTemplateUpdateSchema,
  sessionIntentSchema,
  otherIncomeSchema,
  clubExpenseSchema,
} from '../schemas';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

describe('loginSchema', () => {
  it('accepts a valid email', () => {
    expect(loginSchema.safeParse({ email: 'player@example.com' }).success).toBe(true);
  });
  it('rejects a malformed email', () => {
    expect(loginSchema.safeParse({ email: 'not-an-email' }).success).toBe(false);
  });
});

describe('profileSchema', () => {
  it('accepts a valid profile', () => {
    expect(
      profileSchema.safeParse({
        first_name: 'Alice',
        last_name: 'Lovelace',
        display_name: 'Ali',
        bio: 'Hello',
      }).success,
    ).toBe(true);
  });
  it('accepts a mononym (no last name)', () => {
    expect(profileSchema.safeParse({ first_name: 'Cher', last_name: '' }).success).toBe(true);
  });
  it('rejects an empty first name', () => {
    expect(profileSchema.safeParse({ first_name: '' }).success).toBe(false);
  });
  it('rejects a last name longer than 40 chars', () => {
    expect(
      profileSchema.safeParse({ first_name: 'Alice', last_name: 'x'.repeat(41) }).success,
    ).toBe(false);
  });
  it('rejects a bio longer than 500 chars', () => {
    expect(
      profileSchema.safeParse({ first_name: 'Alice', bio: 'x'.repeat(501) }).success,
    ).toBe(false);
  });
});

describe('challengeCreateSchema', () => {
  const base = {
    type: 'singles' as const,
    rated_flag: true,
    format: 'bo3_21' as const,
    opponent_id: UUID_A,
  };
  it('accepts a valid singles challenge', () => {
    expect(challengeCreateSchema.safeParse(base).success).toBe(true);
  });
  it('accepts a valid doubles challenge with partner', () => {
    expect(
      challengeCreateSchema.safeParse({
        ...base,
        type: 'doubles',
        partner_id: UUID_B,
      }).success,
    ).toBe(true);
  });
  it('rejects an unknown format', () => {
    expect(
      challengeCreateSchema.safeParse({ ...base, format: 'bo5_21' }).success,
    ).toBe(false);
  });
  it('rejects a non-UUID opponent_id', () => {
    expect(
      challengeCreateSchema.safeParse({ ...base, opponent_id: 'not-a-uuid' }).success,
    ).toBe(false);
  });
  it('defaults event_type to rated_challenge', () => {
    const result = challengeCreateSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.event_type).toBe('rated_challenge');
  });
});

describe('matchResultSchema', () => {
  const game = { game_number: 1, side_a_score: 21, side_b_score: 15 };
  it('accepts a 1-game result', () => {
    expect(
      matchResultSchema.safeParse({
        winner_side: 'a',
        games: [game],
        completed: true,
      }).success,
    ).toBe(true);
  });
  it('rejects 0 games', () => {
    expect(
      matchResultSchema.safeParse({
        winner_side: 'a',
        games: [],
        completed: true,
      }).success,
    ).toBe(false);
  });
  it('rejects more than 3 games', () => {
    expect(
      matchResultSchema.safeParse({
        winner_side: 'a',
        games: [game, game, game, game],
        completed: true,
      }).success,
    ).toBe(false);
  });
  it('rejects a negative score', () => {
    expect(
      matchResultSchema.safeParse({
        winner_side: 'a',
        games: [{ game_number: 1, side_a_score: -1, side_b_score: 15 }],
        completed: true,
      }).success,
    ).toBe(false);
  });
  it('rejects a score above 30', () => {
    expect(
      matchResultSchema.safeParse({
        winner_side: 'a',
        games: [{ game_number: 1, side_a_score: 31, side_b_score: 15 }],
        completed: true,
      }).success,
    ).toBe(false);
  });
  it('rejects a tied game', () => {
    expect(
      matchResultSchema.safeParse({
        winner_side: 'a',
        games: [{ game_number: 1, side_a_score: 21, side_b_score: 21 }],
        completed: true,
      }).success,
    ).toBe(false);
  });
  it('rejects a winner_side that did not win a majority of games', () => {
    expect(
      matchResultSchema.safeParse({
        winner_side: 'b',
        games: [game],
        completed: true,
      }).success,
    ).toBe(false);
    expect(
      matchResultSchema.safeParse({
        winner_side: 'b',
        games: [
          { game_number: 1, side_a_score: 21, side_b_score: 15 },
          { game_number: 2, side_a_score: 15, side_b_score: 21 },
          { game_number: 3, side_a_score: 21, side_b_score: 19 },
        ],
        completed: true,
      }).success,
    ).toBe(false);
  });
  it('accepts a valid bo3 result where the winner took 2 of 3 games', () => {
    expect(
      matchResultSchema.safeParse({
        winner_side: 'a',
        games: [
          { game_number: 1, side_a_score: 21, side_b_score: 15 },
          { game_number: 2, side_a_score: 15, side_b_score: 21 },
          { game_number: 3, side_a_score: 21, side_b_score: 19 },
        ],
        completed: true,
      }).success,
    ).toBe(true);
  });
});

describe('disputeSchema', () => {
  it('accepts a valid dispute', () => {
    expect(
      disputeSchema.safeParse({
        match_id: UUID_A,
        reason_category: 'score_wrong',
        description: 'The score was misreported as 21-19.',
      }).success,
    ).toBe(true);
  });
  it('rejects a description shorter than 10 chars', () => {
    expect(
      disputeSchema.safeParse({
        match_id: UUID_A,
        reason_category: 'score_wrong',
        description: 'too short',
      }).success,
    ).toBe(false);
  });
});

describe('sessionCreateSchema', () => {
  it('accepts a valid session', () => {
    expect(
      sessionCreateSchema.safeParse({
        name: 'Tuesday Open',
        date: '2026-04-10',
        location: 'Lorne Davies Complex',
      }).success,
    ).toBe(true);
  });
  it('rejects a name shorter than 2 chars', () => {
    expect(
      sessionCreateSchema.safeParse({
        name: 'A',
        date: '2026-04-10',
        location: 'Lorne Davies Complex',
      }).success,
    ).toBe(false);
  });
  it('accepts a valid weekly recurrence', () => {
    expect(
      sessionCreateSchema.safeParse({
        name: 'Tuesday Open',
        date: '2026-04-10',
        location: 'Lorne Davies Complex',
        repeat_until: '2026-05-08',
      }).success,
    ).toBe(true);
  });
  it('rejects a repeat_until before the start date', () => {
    expect(
      sessionCreateSchema.safeParse({
        name: 'Tuesday Open',
        date: '2026-04-10',
        location: 'Lorne Davies Complex',
        repeat_until: '2026-04-03',
      }).success,
    ).toBe(false);
  });
  it('accepts a weekly recurrence with excluded dates', () => {
    expect(
      sessionCreateSchema.safeParse({
        name: 'Tuesday Open',
        date: '2026-04-10',
        location: 'Lorne Davies Complex',
        repeat_until: '2026-05-08',
        excluded_dates: ['2026-04-17', '2026-05-01'],
      }).success,
    ).toBe(true);
  });
  it('rejects more than 40 excluded dates', () => {
    expect(
      sessionCreateSchema.safeParse({
        name: 'Tuesday Open',
        date: '2026-04-10',
        location: 'Lorne Davies Complex',
        repeat_until: '2026-05-08',
        excluded_dates: Array.from({ length: 41 }, (_, i) => `2026-04-${i}`),
      }).success,
    ).toBe(false);
  });
});

describe('tournamentCreateSchema', () => {
  const base = {
    name: 'Spring Open',
    scope: 'open' as const,
    type: 'internal' as const,
    format: 'singles' as const,
    start_date: '2026-05-01',
  };
  it('accepts a valid tournament with defaults', () => {
    const result = tournamentCreateSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.event_multiplier).toBeCloseTo(1.15);
      expect(result.data.placement_bonus_enabled).toBe(true);
    }
  });
  // The scope/type rejection tests went with 00108: those columns decided
  // nothing and were dropped, so asserting that a bad value for them is
  // refused was asserting a rule about a field that no longer exists.
});

describe('tournamentSuspendSchema', () => {
  it('accepts a valid suspension', () => {
    expect(
      tournamentSuspendSchema.safeParse({ tournament_id: UUID_A, reason: 'Venue flooded' }).success,
    ).toBe(true);
  });
  it('rejects an empty reason', () => {
    expect(
      tournamentSuspendSchema.safeParse({ tournament_id: UUID_A, reason: '' }).success,
    ).toBe(false);
  });
});

describe('adminPlayerUpdateSchema (Phase 2 enum simplification guard)', () => {
  it('accepts each of the 4 valid statuses', () => {
    for (const status of ['competitive', 'recreational', 'suspended', 'pending_approval'] as const) {
      const result = adminPlayerUpdateSchema.safeParse({ status, reason: 'test' });
      expect(result.success).toBe(true);
    }
  });
  it('rejects legacy player statuses', () => {
    for (const status of ['eligible_competitive', 'competitive_associate', 'alumni_external', 'inactive']) {
      const result = adminPlayerUpdateSchema.safeParse({ status, reason: 'test' });
      expect(result.success).toBe(false);
    }
  });
  // THE ROLE CASES ARE GONE BECAUSE THE FIELD IS. This schema used to accept
  // 'player' / 'admin' and refuse the legacy names, because updatePlayer wrote
  // `role`. It does not: role, is_exec and is_trainer ARE console access, and the
  // club owner moved that to the Permissions page alone.
  //
  // Rewritten to the new claim rather than deleted, and the claim is deliberately
  // NOT "the parse fails". Zod strips unknown keys, so a payload naming role
  // still parses — what matters is that it does not survive, and that the runtime
  // guard refuses it outright besides (see apps/admin's player-field-access
  // suite, which asserts an ADMIN is refused and that nothing is written).
  it('carries no console-access column at all, whatever a payload names', () => {
    for (const field of ['role', 'is_exec', 'is_trainer'] as const) {
      const parsed = adminPlayerUpdateSchema.parse({ [field]: field === 'role' ? 'admin' : true, reason: 'test' });
      expect(field in parsed, `${field} survived the parse`).toBe(false);
    }
    // Including the legacy role names this used to name one by one — there is no
    // enum left for them to be outside of.
    for (const role of ['moderator', 'coach_executive', 'player', 'admin']) {
      expect('role' in adminPlayerUpdateSchema.parse({ role, reason: 'test' })).toBe(false);
    }
  });
  it('requires reason', () => {
    expect(adminPlayerUpdateSchema.safeParse({ status: 'competitive' }).success).toBe(false);
  });
  it('rejects an Elo outside the 100-1500 cap', () => {
    expect(
      adminPlayerUpdateSchema.safeParse({ singles_elo: 50, reason: 'test' }).success,
    ).toBe(false);
    expect(
      adminPlayerUpdateSchema.safeParse({ singles_elo: 1600, reason: 'test' }).success,
    ).toBe(false);
  });
  it('accepts an Elo within the 100-1500 cap', () => {
    expect(
      adminPlayerUpdateSchema.safeParse({ singles_elo: 1500, reason: 'test' }).success,
    ).toBe(true);
  });
});

describe('walkoverReportSchema', () => {
  it('accepts each walkover_type', () => {
    for (const walkover_type of ['withdrawal', 'no_show'] as const) {
      const result = walkoverReportSchema.safeParse({
        challenge_id: UUID_A,
        forfeit_player_id: UUID_B,
        walkover_type,
      });
      expect(result.success).toBe(true);
    }
  });
  it('rejects an unknown walkover_type', () => {
    expect(
      walkoverReportSchema.safeParse({
        challenge_id: UUID_A,
        forfeit_player_id: UUID_B,
        walkover_type: 'noshow',
      }).success,
    ).toBe(false);
  });
  it('does not require games (walkovers legitimately have none)', () => {
    expect(
      walkoverReportSchema.safeParse({
        challenge_id: UUID_A,
        forfeit_player_id: UUID_B,
        walkover_type: 'no_show',
        notice_hours: 2,
      }).success,
    ).toBe(true);
  });
});

describe('feeMarkSchema', () => {
  it('accepts a minimal valid input', () => {
    expect(
      feeMarkSchema.safeParse({ player_id: UUID_A, season_id: UUID_B }).success,
    ).toBe(true);
  });
  it('accepts optional amount_cents and method', () => {
    expect(
      feeMarkSchema.safeParse({
        player_id: UUID_A,
        season_id: UUID_B,
        amount_cents: 1500,
        method: 'e-transfer',
      }).success,
    ).toBe(true);
  });
  it('rejects a non-UUID player_id', () => {
    expect(
      feeMarkSchema.safeParse({ player_id: 'not-a-uuid', season_id: UUID_B }).success,
    ).toBe(false);
  });
  it('rejects a non-UUID season_id', () => {
    expect(feeMarkSchema.safeParse({ player_id: UUID_A, season_id: 'not-a-uuid' }).success).toBe(false);
  });
  it('rejects a non-positive or fractional amount_cents', () => {
    expect(
      feeMarkSchema.safeParse({ player_id: UUID_A, season_id: UUID_B, amount_cents: 0 }).success,
    ).toBe(false);
    expect(
      feeMarkSchema.safeParse({ player_id: UUID_A, season_id: UUID_B, amount_cents: -100 }).success,
    ).toBe(false);
    expect(
      feeMarkSchema.safeParse({ player_id: UUID_A, season_id: UUID_B, amount_cents: 15.5 }).success,
    ).toBe(false);
  });
  it('rejects a method longer than 40 chars', () => {
    expect(
      feeMarkSchema.safeParse({
        player_id: UUID_A,
        season_id: UUID_B,
        method: 'x'.repeat(41),
      }).success,
    ).toBe(false);
  });
});

describe('seasonFeeSchema', () => {
  it('accepts non-negative integer fees', () => {
    expect(
      seasonFeeSchema.safeParse({ competitive_fee_cents: 4000, recreational_fee_cents: 0 }).success,
    ).toBe(true);
  });
  it('rejects a negative fee', () => {
    expect(
      seasonFeeSchema.safeParse({ competitive_fee_cents: -1, recreational_fee_cents: 0 }).success,
    ).toBe(false);
  });
  it('rejects a fractional fee', () => {
    expect(
      seasonFeeSchema.safeParse({ competitive_fee_cents: 40.5, recreational_fee_cents: 0 }).success,
    ).toBe(false);
  });
});

describe('sessionGroupSchema', () => {
  it('accepts the known groups', () => {
    expect(sessionGroupSchema.safeParse('competitive').success).toBe(true);
    expect(sessionGroupSchema.safeParse('recreational').success).toBe(true);
    expect(sessionGroupSchema.safeParse('all').success).toBe(true);
  });
  it('rejects an unknown group', () => {
    expect(sessionGroupSchema.safeParse('varsity').success).toBe(false);
  });
});

describe('manualFeeSchema', () => {
  it('accepts a name against a season', () => {
    expect(
      manualFeeSchema.safeParse({ season_id: UUID_A, manual_name: 'Jane Doe' }).success,
    ).toBe(true);
  });
  it('accepts optional amount_cents and method', () => {
    expect(
      manualFeeSchema.safeParse({
        season_id: UUID_A,
        manual_name: 'Jane Doe',
        amount_cents: 2500,
        method: 'cash',
      }).success,
    ).toBe(true);
  });
  it('rejects an empty name', () => {
    expect(manualFeeSchema.safeParse({ season_id: UUID_A, manual_name: '' }).success).toBe(false);
  });
  it('rejects a name longer than 80 chars', () => {
    expect(
      manualFeeSchema.safeParse({ season_id: UUID_A, manual_name: 'x'.repeat(81) }).success,
    ).toBe(false);
  });
  it('rejects a non-UUID season_id', () => {
    expect(manualFeeSchema.safeParse({ season_id: 'nope', manual_name: 'Jane' }).success).toBe(false);
  });
});

describe('feeTierSchema', () => {
  const base = {
    tournament_id: UUID_A,
    name: 'Member',
    amount_cents: 500,
    is_default: true,
  };
  it('accepts a valid tier', () => {
    expect(feeTierSchema.safeParse(base).success).toBe(true);
  });
  it('rejects an empty name', () => {
    expect(feeTierSchema.safeParse({ ...base, name: '' }).success).toBe(false);
  });
  it('rejects a negative amount_cents', () => {
    expect(feeTierSchema.safeParse({ ...base, amount_cents: -1 }).success).toBe(false);
  });
});

describe('tournamentFeeMarkSchema', () => {
  it('accepts a minimal valid input', () => {
    expect(
      tournamentFeeMarkSchema.safeParse({ tournament_id: UUID_A, player_id: UUID_B }).success,
    ).toBe(true);
  });
  it('accepts an amount_cents of 0', () => {
    expect(
      tournamentFeeMarkSchema.safeParse({
        tournament_id: UUID_A,
        player_id: UUID_B,
        amount_cents: 0,
      }).success,
    ).toBe(true);
  });
  it('rejects a non-UUID player_id', () => {
    expect(
      tournamentFeeMarkSchema.safeParse({ tournament_id: UUID_A, player_id: 'x' }).success,
    ).toBe(false);
  });
});

describe('reinstatementSchema', () => {
  it('accepts a minimal valid input', () => {
    expect(reinstatementSchema.safeParse({ player_id: UUID_A }).success).toBe(true);
  });
  it('accepts an amount_cents of 0', () => {
    expect(
      reinstatementSchema.safeParse({ player_id: UUID_A, amount_cents: 0 }).success,
    ).toBe(true);
  });
  it('rejects a non-UUID player_id', () => {
    expect(reinstatementSchema.safeParse({ player_id: 'x' }).success).toBe(false);
  });
});

describe('reinstatementPaymentSchema', () => {
  it('accepts $0 — a free reinstatement is a recorded decision, not a blank', () => {
    expect(
      reinstatementPaymentSchema.safeParse({ fee_id: UUID_A, amount_cents: 0 }).success,
    ).toBe(true);
  });
  // The row already exists by the time this is called, so a missing amount
  // would be indistinguishable from never having recorded one — which is the
  // exact state the action exists to clear.
  it('requires an amount', () => {
    expect(reinstatementPaymentSchema.safeParse({ fee_id: UUID_A }).success).toBe(false);
  });
  it('rejects a negative amount', () => {
    expect(
      reinstatementPaymentSchema.safeParse({ fee_id: UUID_A, amount_cents: -1 }).success,
    ).toBe(false);
  });
});

describe('adminMatchCreateSchema', () => {
  const base = {
    match_type: 'singles' as const,
    format: 'single_21' as const,
    rated_flag: false,
    side_a_players: [UUID_A],
    side_b_players: [UUID_B],
    winner_side: 'a' as const,
    games: [{ game_number: 1, side_a_score: 21, side_b_score: 15 }],
  };

  it('accepts two different players', () => {
    expect(adminMatchCreateSchema.safeParse(base).success).toBe(true);
  });

  // The bug this guards: the schema checked only that each side had 1-2 UUIDs,
  // so the same player on both sides passed validation, the match row was
  // committed, and the participant batch then died on
  // UNIQUE(match_id, player_id) — leaving a completed match with a winner and
  // no participants while the action reported success.
  it('rejects the same player on both sides', () => {
    expect(
      adminMatchCreateSchema.safeParse({
        ...base, side_a_players: [UUID_A], side_b_players: [UUID_A],
      }).success,
    ).toBe(false);
  });

  // Same constraint, same orphan: two of the same partner on one doubles side.
  it('rejects the same player twice on one side', () => {
    expect(
      adminMatchCreateSchema.safeParse({
        ...base, match_type: 'doubles', side_a_players: [UUID_A, UUID_A], side_b_players: [UUID_B],
      }).success,
    ).toBe(false);
  });
});

describe('banSchema', () => {
  it('accepts a valid ban', () => {
    expect(banSchema.safeParse({ player_id: UUID_A, reason: 'Repeated no-shows' }).success).toBe(true);
  });
  it('rejects a reason shorter than 2 chars', () => {
    expect(banSchema.safeParse({ player_id: UUID_A, reason: 'x' }).success).toBe(false);
  });
});

// IT CARRIED is_exec TOO, and that made updatePlayerFlags a second way to hand
// somebody a console level from the Fees page — is_exec is one of the three
// columns admin_access_level resolves from. Console access has one editing path
// now (/permissions → setConsoleAccess), so this schema is the fee flag alone.
// The assertions are rewritten to the new contract rather than deleted: the
// interesting claim is that is_exec CANNOT come back through here.
describe('playerFlagsSchema', () => {
  it('accepts either value of the fee flag', () => {
    for (const fee_exempt of [true, false]) {
      expect(playerFlagsSchema.safeParse({ fee_exempt }).success).toBe(true);
    }
  });
  it('requires the flag', () => {
    expect(playerFlagsSchema.safeParse({}).success).toBe(false);
  });
  it('rejects non-boolean values', () => {
    expect(playerFlagsSchema.safeParse({ fee_exempt: 'yes' }).success).toBe(false);
  });
  // Zod strips unknown keys rather than refusing them, so the guarantee is not
  // "the parse fails" — it is that is_exec does not survive the parse. Belt as
  // well as braces at the action: updatePlayerFlags names fee_exempt explicitly
  // in its .update() rather than spreading the payload, so an extra key has
  // nowhere to land even if this ever stopped stripping.
  it('drops is_exec instead of carrying it through', () => {
    const parsed = playerFlagsSchema.parse({ is_exec: true, fee_exempt: false });
    expect(parsed).toEqual({ fee_exempt: false });
    expect('is_exec' in parsed).toBe(false);
  });
});

describe('reliabilityAdjustSchema', () => {
  const base = {
    player_id: UUID_A,
    no_shows: 2,
    late_cancellations: 1,
    early_withdrawals: 0,
    walkover_flag: false,
    reason: 'Corrected after admin review',
  };
  it('accepts a valid adjustment', () => {
    expect(reliabilityAdjustSchema.safeParse(base).success).toBe(true);
  });
  it('rejects a negative count', () => {
    expect(reliabilityAdjustSchema.safeParse({ ...base, no_shows: -1 }).success).toBe(false);
  });
  it('rejects an empty reason', () => {
    expect(reliabilityAdjustSchema.safeParse({ ...base, reason: '' }).success).toBe(false);
  });
});

describe('legalAcceptanceSchema', () => {
  const allTrue = {
    waiver_accepted: true,
    code_of_conduct_accepted: true,
    terms_accepted: true,
    age_attestation: true,
  };
  it('accepts all four literals true', () => {
    expect(legalAcceptanceSchema.safeParse(allTrue).success).toBe(true);
  });
  it('rejects any false literal', () => {
    for (const key of ['waiver_accepted', 'code_of_conduct_accepted', 'terms_accepted', 'age_attestation'] as const) {
      expect(legalAcceptanceSchema.safeParse({ ...allTrue, [key]: false }).success).toBe(false);
    }
  });
  it('rejects a missing field', () => {
    expect(
      legalAcceptanceSchema.safeParse({ waiver_accepted: true, code_of_conduct_accepted: true, terms_accepted: true }).success,
    ).toBe(false);
  });
});

describe('legalDocumentUpdateSchema', () => {
  const base = {
    document: 'waiver' as const,
    content: 'x'.repeat(100),
    bump_version: false,
  };
  it('accepts a valid update for each document', () => {
    for (const document of ['waiver', 'code_of_conduct', 'terms_of_use', 'privacy_policy'] as const) {
      expect(legalDocumentUpdateSchema.safeParse({ ...base, document }).success).toBe(true);
    }
  });
  it('rejects an unknown document', () => {
    expect(
      legalDocumentUpdateSchema.safeParse({ ...base, document: 'refund_policy' }).success,
    ).toBe(false);
  });
  it('rejects content shorter than 50 chars', () => {
    expect(legalDocumentUpdateSchema.safeParse({ ...base, content: 'too short' }).success).toBe(false);
  });
  it('rejects content longer than 50000 chars', () => {
    expect(
      legalDocumentUpdateSchema.safeParse({ ...base, content: 'x'.repeat(50001) }).success,
    ).toBe(false);
  });
});

// The per-season event waiver template (00074). Keyed by season uuid, not a
// document name — a template is NOT a legal_documents row, and there is no
// bump_version because nobody accepts a template directly.
describe('eventWaiverTemplateUpdateSchema', () => {
  const base = {
    season_id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    content: 'x'.repeat(100),
  };
  it('accepts a valid update', () => {
    expect(eventWaiverTemplateUpdateSchema.safeParse(base).success).toBe(true);
  });
  it('rejects a season_id that is not a uuid', () => {
    // The action passes this straight to a uuid column; a document-style key
    // like 'waiver' would blow up at the database instead of here.
    expect(
      eventWaiverTemplateUpdateSchema.safeParse({ ...base, season_id: 'fall-2026' }).success,
    ).toBe(false);
  });
  it('rejects content shorter than 50 chars', () => {
    // Stops a stray keystroke becoming the wording every event that term
    // starts from.
    expect(
      eventWaiverTemplateUpdateSchema.safeParse({ ...base, content: 'too short' }).success,
    ).toBe(false);
  });
  it('rejects content longer than 50000 chars', () => {
    expect(
      eventWaiverTemplateUpdateSchema.safeParse({ ...base, content: 'x'.repeat(50001) }).success,
    ).toBe(false);
  });
});

describe('disputeResolveSchema', () => {
  it('accepts each resolution_type', () => {
    for (const resolution_type of ['accepted', 'edited', 'voided', 'converted_to_casual'] as const) {
      const result = disputeResolveSchema.safeParse({
        dispute_id: UUID_A,
        resolution_type,
        resolution_note: 'ok',
      });
      expect(result.success).toBe(true);
    }
  });
  it('rejects an unknown resolution_type', () => {
    expect(
      disputeResolveSchema.safeParse({
        dispute_id: UUID_A,
        resolution_type: 'denied',
        resolution_note: 'ok',
      }).success,
    ).toBe(false);
  });
  it('rejects edited games with a tied game', () => {
    expect(
      disputeResolveSchema.safeParse({
        dispute_id: UUID_A,
        resolution_type: 'edited',
        resolution_note: 'ok',
        edited_winner_side: 'a',
        edited_games: [{ game_number: 1, side_a_score: 21, side_b_score: 21 }],
      }).success,
    ).toBe(false);
  });
  it('rejects an edited_winner_side that did not win a majority of edited games', () => {
    expect(
      disputeResolveSchema.safeParse({
        dispute_id: UUID_A,
        resolution_type: 'edited',
        resolution_note: 'ok',
        edited_winner_side: 'b',
        edited_games: [{ game_number: 1, side_a_score: 21, side_b_score: 15 }],
      }).success,
    ).toBe(false);
  });
  it('accepts a consistent edited resolution', () => {
    expect(
      disputeResolveSchema.safeParse({
        dispute_id: UUID_A,
        resolution_type: 'edited',
        resolution_note: 'ok',
        edited_winner_side: 'a',
        edited_games: [{ game_number: 1, side_a_score: 21, side_b_score: 15 }],
      }).success,
    ).toBe(true);
  });
});

describe('sessionIntentSchema', () => {
  it('accepts the known intents', () => {
    expect(sessionIntentSchema.parse('going')).toBe('going');
    expect(sessionIntentSchema.parse('declined')).toBe('declined');
  });
  it('rejects an unknown intent, empty string, or undefined', () => {
    expect(sessionIntentSchema.safeParse('maybe').success).toBe(false);
    expect(sessionIntentSchema.safeParse('').success).toBe(false);
    expect(sessionIntentSchema.safeParse(undefined).success).toBe(false);
  });
});

// The two non-fee ledgers (00073). Both are money, so both are validated at the
// trust boundary before the service-role client — which bypasses RLS — writes
// anything.
describe('otherIncomeSchema / clubExpenseSchema', () => {
  const income = { season_id: UUID_A, category: 'donation', description: 'Alumni gift', amount_cents: 15000 };
  const expense = { season_id: UUID_A, category: 'shuttles', description: '6 tubes', amount_cents: 8400 };

  it('accepts a minimal valid entry on each', () => {
    expect(otherIncomeSchema.safeParse(income).success).toBe(true);
    expect(clubExpenseSchema.safeParse(expense).success).toBe(true);
  });

  // season_id is the ONLY thing that decides which season a row counts toward.
  // reinstatement_fees had no season column, had to be bucketed by paid_at, and
  // a payment taken between terms then belonged to no season and showed in no
  // total (00069). An optional season here would recreate that hole.
  it('requires a season on both ledgers', () => {
    expect(otherIncomeSchema.safeParse({ ...income, season_id: undefined }).success).toBe(false);
    expect(clubExpenseSchema.safeParse({ ...expense, season_id: undefined }).success).toBe(false);
    expect(clubExpenseSchema.safeParse({ ...expense, season_id: 'not-a-uuid' }).success).toBe(false);
  });

  // A category outside the list would be rejected by the database CHECK in
  // 00073 anyway; catching it here turns a 500 into a field error, and keeps
  // the console's vocabulary and the database's from drifting apart.
  it('rejects a category the database would refuse', () => {
    expect(clubExpenseSchema.safeParse({ ...expense, category: 'shuttlecocks' }).success).toBe(false);
    expect(otherIncomeSchema.safeParse({ ...income, category: 'shuttles' }).success).toBe(false);
  });

  // Cents are integers. A fractional cent is not money, and a negative amount
  // on an expense would ADD to the net position instead of subtracting from it,
  // turning a typo into a club that looks solvent.
  it('rejects fractional and negative amounts', () => {
    expect(clubExpenseSchema.safeParse({ ...expense, amount_cents: 84.5 }).success).toBe(false);
    expect(clubExpenseSchema.safeParse({ ...expense, amount_cents: -8400 }).success).toBe(false);
    expect(otherIncomeSchema.safeParse({ ...income, amount_cents: -1 }).success).toBe(false);
  });

  // $0.00 is a legitimate entry: a promised donation that came to nothing, or
  // shuttles somebody donated. Refusing it would push the admin to delete the
  // trail instead of recording the outcome.
  it('accepts a zero amount', () => {
    expect(clubExpenseSchema.safeParse({ ...expense, amount_cents: 0 }).success).toBe(true);
    expect(otherIncomeSchema.safeParse({ ...income, amount_cents: 0 }).success).toBe(true);
  });

  // A blank description makes a ledger line nobody can identify later. Trimmed,
  // so spaces do not sneak past the minimum.
  it('rejects a blank or whitespace-only description', () => {
    expect(clubExpenseSchema.safeParse({ ...expense, description: '' }).success).toBe(false);
    expect(clubExpenseSchema.safeParse({ ...expense, description: '   ' }).success).toBe(false);
  });

  // Quantity is a unit count for the spend ("6 tubes"), not an amount. Zero or
  // fractional tubes is a typo.
  it('accepts a positive quantity and rejects zero or fractional', () => {
    expect(clubExpenseSchema.safeParse({ ...expense, quantity: 6 }).success).toBe(true);
    expect(clubExpenseSchema.safeParse({ ...expense, quantity: 0 }).success).toBe(false);
    expect(clubExpenseSchema.safeParse({ ...expense, quantity: 1.5 }).success).toBe(false);
  });

  // Quantity belongs to expenses only — "3 donations" is not a thing this
  // ledger records, and an unknown key must not silently become a column.
  it('does not carry quantity through on other income', () => {
    const parsed = otherIncomeSchema.parse({ ...income, quantity: 3 } as never);
    expect('quantity' in parsed).toBe(false);
  });

  // The date the money moved, which is not the date the entry was typed: an
  // exec writing up September's receipts in October has to be able to say
  // September. It never changes which season the row counts toward.
  it('accepts an explicit ISO paid_at and rejects a bare date', () => {
    expect(clubExpenseSchema.safeParse({ ...expense, paid_at: '2026-09-15T12:00:00.000Z' }).success).toBe(true);
    expect(clubExpenseSchema.safeParse({ ...expense, paid_at: '2026-09-15' }).success).toBe(false);
  });
});
