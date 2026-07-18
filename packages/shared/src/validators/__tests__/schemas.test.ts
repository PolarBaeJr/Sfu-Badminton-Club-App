import { describe, it, expect } from 'vitest';
import {
  loginSchema,
  profileSchema,
  challengeCreateSchema,
  matchResultSchema,
  disputeSchema,
  sessionCreateSchema,
  tournamentCreateSchema,
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
  banSchema,
  playerFlagsSchema,
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
        full_name: 'Alice',
        display_name: 'Ali',
        bio: 'Hello',
      }).success,
    ).toBe(true);
  });
  it('rejects a name shorter than 2 chars', () => {
    expect(profileSchema.safeParse({ full_name: 'A' }).success).toBe(false);
  });
  it('rejects a bio longer than 500 chars', () => {
    expect(
      profileSchema.safeParse({ full_name: 'Alice', bio: 'x'.repeat(501) }).success,
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
      expect(result.data.bracket_size).toBe(8);
      expect(result.data.event_multiplier).toBeCloseTo(1.15);
      expect(result.data.placement_bonus_enabled).toBe(true);
    }
  });
  it('rejects an unknown scope', () => {
    expect(
      tournamentCreateSchema.safeParse({ ...base, scope: 'private' }).success,
    ).toBe(false);
  });
  it('rejects an unknown type', () => {
    expect(
      tournamentCreateSchema.safeParse({ ...base, type: 'world_championship' }).success,
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
  it('accepts each of the 2 valid roles', () => {
    for (const role of ['player', 'admin'] as const) {
      const result = adminPlayerUpdateSchema.safeParse({ role, reason: 'test' });
      expect(result.success).toBe(true);
    }
  });
  it('rejects legacy player statuses', () => {
    for (const status of ['eligible_competitive', 'competitive_associate', 'alumni_external', 'inactive']) {
      const result = adminPlayerUpdateSchema.safeParse({ status, reason: 'test' });
      expect(result.success).toBe(false);
    }
  });
  it('rejects legacy roles', () => {
    for (const role of ['moderator', 'coach_executive']) {
      const result = adminPlayerUpdateSchema.safeParse({ role, reason: 'test' });
      expect(result.success).toBe(false);
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

describe('banSchema', () => {
  it('accepts a valid ban', () => {
    expect(banSchema.safeParse({ player_id: UUID_A, reason: 'Repeated no-shows' }).success).toBe(true);
  });
  it('rejects a reason shorter than 2 chars', () => {
    expect(banSchema.safeParse({ player_id: UUID_A, reason: 'x' }).success).toBe(false);
  });
});

describe('playerFlagsSchema', () => {
  it('accepts all boolean combinations', () => {
    for (const is_exec of [true, false]) {
      for (const fee_exempt of [true, false]) {
        expect(playerFlagsSchema.safeParse({ is_exec, fee_exempt }).success).toBe(true);
      }
    }
  });
  it('requires both flags', () => {
    expect(playerFlagsSchema.safeParse({ is_exec: true }).success).toBe(false);
    expect(playerFlagsSchema.safeParse({ fee_exempt: true }).success).toBe(false);
  });
  it('rejects non-boolean values', () => {
    expect(
      playerFlagsSchema.safeParse({ is_exec: 'yes', fee_exempt: false }).success,
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
