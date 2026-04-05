import { z } from 'zod';

export const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
});

export const profileSchema = z.object({
  full_name: z.string().min(2, 'Name must be at least 2 characters'),
  display_name: z.string().optional(),
  phone: z.string().optional(),
  bio: z.string().max(500).optional(),
});

export const challengeCreateSchema = z.object({
  type: z.enum(['singles', 'doubles']),
  rated_flag: z.boolean(),
  format: z.enum(['bo3_21', 'single_21', 'single_15', 'single_11']),
  event_type: z.enum(['rated_challenge', 'casual']).default('rated_challenge'),
  opponent_id: z.string().uuid(),
  partner_id: z.string().uuid().optional(),
  opponent_partner_id: z.string().uuid().optional(),
  session_id: z.string().uuid().optional(),
  scheduled_date: z.string().optional(),
  scheduled_time: z.string().optional(),
  note: z.string().max(500).optional(),
});

export const matchResultSchema = z.object({
  match_id: z.string().uuid(),
  winner_side: z.enum(['a', 'b']),
  games: z.array(z.object({
    game_number: z.number().int().positive(),
    side_a_score: z.number().int().min(0),
    side_b_score: z.number().int().min(0),
  })).min(1).max(3),
  completed: z.boolean(),
});

export const disputeSchema = z.object({
  match_id: z.string().uuid(),
  reason_category: z.enum([
    'score_wrong', 'winner_wrong', 'format_wrong', 'incomplete', 'abuse', 'rules_violation', 'other',
  ]),
  description: z.string().min(10, 'Description must be at least 10 characters'),
});

export const sessionCreateSchema = z.object({
  name: z.string().min(2),
  date: z.string(),
  location: z.string().min(2),
  season_id: z.string().uuid().optional(),
});

export const tournamentCreateSchema = z.object({
  name: z.string().min(2),
  scope: z.enum(['open', 'eligible_only']),
  type: z.enum(['internal', 'open_official', 'invitational']),
  format: z.enum(['singles', 'doubles', 'mixed_event']),
  start_date: z.string(),
  end_date: z.string().optional(),
  bracket_size: z.number().int().min(2).default(8),
  event_multiplier: z.number().min(1).max(2).default(1.15),
  placement_bonus_enabled: z.boolean().default(true),
});

export const adminPlayerUpdateSchema = z.object({
  status: z.enum([
    'competitive', 'recreational', 'suspended', 'pending_approval',
  ]).optional(),
  role: z.enum(['player', 'admin']).optional(),
  singles_elo: z.number().int().min(800).max(2400).optional(),
  doubles_elo: z.number().int().min(800).max(2400).optional(),
  reason: z.string().min(2, 'Reason is required'),
});

export const walkoverReportSchema = z.object({
  challenge_id: z.string().uuid(),
  forfeit_player_id: z.string().uuid(),
  walkover_type: z.enum(['withdrawal', 'no_show']),
  notice_hours: z.number().int().optional(),
});

export const disputeResolveSchema = z.object({
  dispute_id: z.string().uuid(),
  resolution_type: z.enum(['accepted', 'edited', 'voided', 'converted_to_casual']),
  resolution_note: z.string().min(2),
  edited_winner_side: z.enum(['a', 'b']).optional(),
  edited_games: z.array(z.object({
    game_number: z.number().int().positive(),
    side_a_score: z.number().int().min(0),
    side_b_score: z.number().int().min(0),
  })).optional(),
});

export type LoginInput = z.infer<typeof loginSchema>;
export type ProfileInput = z.infer<typeof profileSchema>;
export type ChallengeCreateInput = z.infer<typeof challengeCreateSchema>;
export type MatchResultInput = z.infer<typeof matchResultSchema>;
export type DisputeInput = z.infer<typeof disputeSchema>;
export type SessionCreateInput = z.infer<typeof sessionCreateSchema>;
export type TournamentCreateInput = z.infer<typeof tournamentCreateSchema>;
export type AdminPlayerUpdateInput = z.infer<typeof adminPlayerUpdateSchema>;
export type WalkoverReportInput = z.infer<typeof walkoverReportSchema>;
export type DisputeResolveInput = z.infer<typeof disputeResolveSchema>;
