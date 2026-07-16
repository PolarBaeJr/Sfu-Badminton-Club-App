import { z } from 'zod';

// Empty optional strings come from form fields where the user left the input blank.
// Coerce them to undefined so downstream code doesn't have to discriminate "" vs unset.
const blankAsUndefined = (schema: z.ZodTypeAny) =>
  z.preprocess((val) => (val === '' ? undefined : val), schema.optional());

const phoneSchema = blankAsUndefined(
  z.string().regex(/^\+?[0-9 ()-]{7,20}$/, 'Invalid phone number')
);
const displayNameSchema = blankAsUndefined(
  z.string().min(2, 'Display name must be at least 2 characters').max(40)
);
// HTML <input type="date"> emits YYYY-MM-DD; <input type="time"> emits HH:MM (with optional :SS).
const isoDateSchema = blankAsUndefined(
  z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Invalid date')
);
const isoTimeSchema = blankAsUndefined(
  z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/, 'Invalid time')
);

export const loginSchema = z.object({
  email: z.string().email('Invalid email address'),
});

export const profileSchema = z.object({
  full_name: z.string().min(2, 'Name must be at least 2 characters').max(80),
  display_name: displayNameSchema,
  phone: phoneSchema,
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
  scheduled_date: isoDateSchema,
  scheduled_time: isoTimeSchema,
  note: z.string().max(500).optional(),
});

const matchGameSchema = z.object({
  game_number: z.number().int().positive(),
  side_a_score: z.number().int().min(0).max(30),
  side_b_score: z.number().int().min(0).max(30),
});

// Server-side integrity checks mirroring apply_match_result: no tied games,
// and the claimed winner must have won a strict majority of the games.
const refineGamesMatchWinner = (
  games: z.infer<typeof matchGameSchema>[],
  winnerSide: 'a' | 'b',
  ctx: z.RefinementCtx,
  gamesPath: string,
  winnerPath: string
) => {
  let aWins = 0;
  let bWins = 0;
  games.forEach((g, i) => {
    if (g.side_a_score === g.side_b_score) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Game scores cannot be tied',
        path: [gamesPath, i],
      });
    } else if (g.side_a_score > g.side_b_score) {
      aWins++;
    } else {
      bWins++;
    }
  });
  const winnerGames = winnerSide === 'a' ? aWins : bWins;
  const loserGames = winnerSide === 'a' ? bWins : aWins;
  if (winnerGames <= loserGames) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'winner_side does not match game scores',
      path: [winnerPath],
    });
  }
};

// match_id is intentionally absent: submitMatchResult creates the match from challengeId,
// so the caller cannot have a match_id at submit time. confirmMatchResult / disputeMatchResult
// take the matchId as a separate argument.
export const matchResultSchema = z.object({
  winner_side: z.enum(['a', 'b']),
  games: z.array(matchGameSchema).min(1).max(3),
  completed: z.boolean(),
}).superRefine((val, ctx) => {
  refineGamesMatchWinner(val.games, val.winner_side, ctx, 'games', 'winner_side');
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
  edited_games: z.array(matchGameSchema).optional(),
}).superRefine((val, ctx) => {
  if (val.edited_games && val.edited_games.length > 0 && val.edited_winner_side) {
    refineGamesMatchWinner(val.edited_games, val.edited_winner_side, ctx, 'edited_games', 'edited_winner_side');
  }
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
