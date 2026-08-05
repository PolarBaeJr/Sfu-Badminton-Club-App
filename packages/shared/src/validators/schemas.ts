import { z } from 'zod';
import { MIN_ELO, MAX_ELO } from '../utils/constants';

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
// players.first_name / last_name (00023). Mononyms are real names, so a
// single character is enough and a last name is optional.
const firstNameSchema = z.string().min(1, 'First name is required').max(40);
const lastNameSchema = blankAsUndefined(z.string().max(40));
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
  first_name: firstNameSchema,
  last_name: lastNameSchema,
  display_name: displayNameSchema,
  phone: phoneSchema,
  bio: z.string().max(500).optional(),
  hide_from_leaderboard: z.boolean().optional(),
  show_activity_status: z.boolean().optional(),
});

export const challengeCreateSchema = z.object({
  type: z.enum(['singles', 'doubles']),
  rated_flag: z.boolean(),
  format: z.enum(['bo3_21', 'single_21', 'single_15', 'single_11']),
  // Optional custom shape: "best of X games to Y points". When set these win
  // over the preset (see migration 00031). Best-of must be odd so a majority
  // always exists; bounds keep a "best of 99 to 500" off the ladder.
  games_per_match: z.number().int().min(1).max(7).refine((n) => n % 2 === 1, 'Games must be an odd number').optional(),
  points_per_game: z.number().int().min(5).max(30).optional(),
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

export const sessionGroupSchema = z.enum(['competitive', 'recreational', 'all']);

export const sessionCreateSchema = z.object({
  name: z.string().min(2),
  date: z.string(),
  time: isoTimeSchema,
  end_time: isoTimeSchema,
  location: z.string().min(2),
  notes: z.string().max(500).optional(),
  season_id: z.string().uuid().optional(),
  track: sessionGroupSchema.default('all'),
  // Weekly recurrence: when set, sessions repeat on the same weekday up to and
  // including this date. YYYY-MM-DD strings compare correctly lexicographically.
  repeat_until: z.string().optional(),
  // Dates to skip within the weekly series (same YYYY-MM-DD format as `date`).
  // Only meaningful alongside repeat_until; stray exclusions without a series
  // are ignored server-side rather than rejected. Capped at the series max.
  excluded_dates: z.array(z.string()).max(40).optional(),
  // When both times are present, the session must end after it starts.
  // Zero-padded HH:MM[:SS] strings compare correctly lexicographically.
}).refine((d) => !d.time || !d.end_time || d.end_time > d.time, {
  message: 'End time must be after start time',
  path: ['end_time'],
}).refine((d) => !d.repeat_until || d.repeat_until >= d.date, {
  message: 'Repeat-until date must be on or after the start date',
  path: ['repeat_until'],
});

// Admin-only attendance marks; players self-insert 'checked_in' rows via RLS.
export const attendanceStatusSchema = z.enum(['present', 'no_show', 'excused']);

export const attendanceMarkSchema = z.object({
  session_id: z.string().uuid(),
  player_id: z.string().uuid(),
  status: attendanceStatusSchema,
});

// Ahead-of-time session RSVP: players signal whether they intend to attend.
export const sessionIntentSchema = z.enum(['going', 'declined']);

export const tournamentCreateSchema = z.object({
  name: z.string().min(2),
  scope: z.enum(['open', 'eligible_only']),
  type: z.enum(['internal', 'open_official', 'invitational']),
  format: z.enum(['singles', 'doubles', 'mixed_event']),
  start_date: z.string(),
  end_date: z.string().optional(),
  // Upper bound matters: bracket_size feeds nextPowerOf2 bracket generation,
  // so an unbounded value is a DoS lever into a very expensive insert loop.
  bracket_size: z.number().int().min(2).max(128).default(8),
  event_multiplier: z.number().min(1).max(2).default(1.15),
  placement_bonus_enabled: z.boolean().default(true),
  // Which membership groups may register. Defaults to all three so a tournament
  // created without touching this stays open, matching the column default.
  // Rejects the empty array: that bars everyone, and is only ever the shape you
  // get from a form with nothing ticked.
  allowed_memberships: z
    .array(z.enum(['internal', 'alumni', 'external']))
    .min(1, 'Pick at least one group')
    .default(['internal', 'alumni', 'external']),
  waiver_text: z.string().max(50000).optional(),
});

export const tournamentSuspendSchema = z.object({
  tournament_id: z.string().uuid(),
  reason: z.string().min(2, 'Reason is required').max(500),
});

export const adminPlayerUpdateSchema = z.object({
  status: z.enum([
    'competitive', 'recreational', 'suspended', 'pending_approval',
  ]).optional(),
  role: z.enum(['player', 'admin']).optional(),
  // Which group of the club they belong to. Independent of role/is_exec —
  // an exec is still an internal member. Drives tournament eligibility.
  membership_type: z.enum(['internal', 'alumni', 'external']).optional(),
  singles_elo: z.number().int().min(MIN_ELO).max(MAX_ELO).optional(),
  doubles_elo: z.number().int().min(MIN_ELO).max(MAX_ELO).optional(),
  // Club-executive markers (no gameplay effect). is_exec adds the player to the
  // executive team (shown on the public /exec page) and exempts them from fees;
  // exec_title is their role label; fee_exempt exempts non-exec contributors.
  is_exec: z.boolean().optional(),
  exec_title: blankAsUndefined(z.string().max(60)),
  fee_exempt: z.boolean().optional(),
  reason: z.string().min(2, 'Reason is required'),
});

export const eventFeedbackSchema = z
  .object({
    tournament_id: z.string().uuid(),
    rating: z.number().int().min(1).max(5).optional(),
    comment: blankAsUndefined(z.string().max(2000)),
  })
  .refine((d) => d.rating !== undefined || (d.comment != null && d.comment.length > 0), {
    message: 'Add a rating or a comment',
  });
export type EventFeedbackInput = z.infer<typeof eventFeedbackSchema>;

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

export const adminPlayerCreateSchema = z.object({
  first_name: firstNameSchema,
  last_name: lastNameSchema,
  email: z.string().email('Invalid email address'),
  status: z.enum([
    'competitive', 'recreational', 'suspended', 'pending_approval',
  ]).optional(),
  // 'admin' intentionally absent: admin accounts are promoted from existing
  // members (updatePlayer), never created directly.
  role: z.enum(['player']).optional(),
  is_exec: z.boolean().optional(),
});

export const adminMatchCreateSchema = z.object({
  match_type: z.enum(['singles', 'doubles']),
  format: z.enum(['bo3_21', 'single_21', 'single_15', 'single_11']),
  rated_flag: z.boolean(),
  side_a_players: z.array(z.string().uuid()).min(1).max(2),
  side_b_players: z.array(z.string().uuid()).min(1).max(2),
  winner_side: z.enum(['a', 'b']),
  games: z.array(matchGameSchema).min(1).max(3),
  admin_note: z.string().max(500).optional(),
});

export const feeMarkSchema = z.object({
  player_id: z.string().uuid(),
  season_id: z.string().uuid(),
  amount_cents: z.number().int().positive().optional(),
  method: z.string().max(40).optional(),
  reference: z.string().max(120).optional(),
});

// One-time season-fee waiver: stored as a paid row with amount_cents 0 and
// method 'waived', so income sums stay correct without a schema migration.
export const feeWaiveSchema = z.object({
  player_id: z.string().uuid(),
  season_id: z.string().uuid(),
});

export const seasonFeeSchema = z.object({
  competitive_fee_cents: z.number().int().min(0),
  recreational_fee_cents: z.number().int().min(0),
});

// A manual fee entry: someone who paid the club fee without an account. The
// admin records just a name against the active season.
export const manualFeeSchema = z.object({
  season_id: z.string().uuid(),
  manual_name: z.string().min(1).max(80),
  amount_cents: z.number().int().positive().optional(),
  method: z.string().max(40).optional(),
  reference: z.string().max(120).optional(),
});

export const feeTierSchema = z.object({
  tournament_id: z.string().uuid(),
  name: z.string().min(1).max(40),
  amount_cents: z.number().int().min(0),
  is_default: z.boolean(),
});

export const tournamentFeeMarkSchema = z.object({
  tournament_id: z.string().uuid(),
  player_id: z.string().uuid(),
  tier_id: z.string().uuid().optional(),
  amount_cents: z.number().int().nonnegative().optional(),
  method: z.string().max(40).optional(),
  reference: z.string().max(120).optional(),
});

export const reinstatementSchema = z.object({
  player_id: z.string().uuid(),
  amount_cents: z.number().int().nonnegative().optional(),
  method: z.string().max(40).optional(),
});

export const banSchema = z.object({
  player_id: z.string().uuid(),
  reason: z.string().min(2),
});

export const playerFlagsSchema = z.object({
  is_exec: z.boolean(),
  fee_exempt: z.boolean(),
});

export const varsityNoteSchema = z.object({
  player_id: z.string().uuid(),
  note: z.string().min(2, 'Note must be at least 2 characters').max(2000),
});

export const reliabilityAdjustSchema = z.object({
  player_id: z.string().uuid(),
  no_shows: z.number().int().min(0),
  late_cancellations: z.number().int().min(0),
  early_withdrawals: z.number().int().min(0),
  walkover_flag: z.boolean(),
  reason: z.string().min(2, 'Reason must be at least 2 characters').max(500),
});

export const announcementSchema = z.object({
  title: z.string().min(1, 'Title is required').max(200),
  body: z.string().min(1, 'Body is required').max(5000),
  type: z.enum(['info', 'warning', 'urgent', 'event']),
  target_audience: z.enum(['all', 'competitive', 'recreational', 'eligible_only']),
  pinned: z.boolean(),
  send_push: z.boolean(),
  status: z.enum(['draft', 'published']),
  // Edit forms round-trip the stored timestamptz, so this is looser than isoDateSchema.
  expires_at: z.string().optional(),
});

// All four must be literally true — accepting is an affirmative act, so the
// server rejects anything short of an explicit check on every box.
export const legalAcceptanceSchema = z.object({
  waiver_accepted: z.literal(true, {
    errorMap: () => ({ message: 'You must accept the liability waiver' }),
  }),
  code_of_conduct_accepted: z.literal(true, {
    errorMap: () => ({ message: 'You must accept the code of conduct' }),
  }),
  terms_accepted: z.literal(true, {
    errorMap: () => ({ message: 'You must accept the terms of use and privacy policy' }),
  }),
  age_attestation: z.literal(true, {
    errorMap: () => ({ message: 'You must confirm you are 19 or older, or have your parent/guardian\'s consent' }),
  }),
});

// Typing DELETE is an affirmative act — the server rejects anything else.
export const accountDeletionSchema = z.object({
  confirmation: z.literal('DELETE', {
    errorMap: () => ({ message: 'Type DELETE to confirm' }),
  }),
});

export const legalDocumentUpdateSchema = z.object({
  document: z.enum(['waiver', 'code_of_conduct', 'terms_of_use', 'privacy_policy']),
  content: z.string().min(50, 'Content must be at least 50 characters').max(50000),
  bump_version: z.boolean(),
});

// Just the document key — validated when an admin forces re-acceptance.
export const waiverDocumentSchema = z.enum([
  'waiver', 'code_of_conduct', 'terms_of_use', 'privacy_policy',
]);

export type LoginInput = z.infer<typeof loginSchema>;
export type ProfileInput = z.infer<typeof profileSchema>;
export type ChallengeCreateInput = z.infer<typeof challengeCreateSchema>;
export type MatchResultInput = z.infer<typeof matchResultSchema>;
export type DisputeInput = z.infer<typeof disputeSchema>;
export type SessionCreateInput = z.infer<typeof sessionCreateSchema>;
export type AttendanceStatusInput = z.infer<typeof attendanceStatusSchema>;
export type AttendanceMarkInput = z.infer<typeof attendanceMarkSchema>;
export type SessionIntentInput = z.infer<typeof sessionIntentSchema>;
export type TournamentCreateInput = z.infer<typeof tournamentCreateSchema>;
export type TournamentSuspendInput = z.infer<typeof tournamentSuspendSchema>;
export type AdminPlayerUpdateInput = z.infer<typeof adminPlayerUpdateSchema>;
export type WalkoverReportInput = z.infer<typeof walkoverReportSchema>;
export type DisputeResolveInput = z.infer<typeof disputeResolveSchema>;
export type AdminPlayerCreateInput = z.infer<typeof adminPlayerCreateSchema>;
export type AdminMatchCreateInput = z.infer<typeof adminMatchCreateSchema>;
export type AnnouncementInput = z.infer<typeof announcementSchema>;
export type FeeMarkInput = z.infer<typeof feeMarkSchema>;
export type FeeWaiveInput = z.infer<typeof feeWaiveSchema>;
export type SeasonFeeInput = z.infer<typeof seasonFeeSchema>;
export type SessionGroupInput = z.infer<typeof sessionGroupSchema>;
export type ManualFeeInput = z.infer<typeof manualFeeSchema>;
export type FeeTierInput = z.infer<typeof feeTierSchema>;
export type TournamentFeeMarkInput = z.infer<typeof tournamentFeeMarkSchema>;
export type ReinstatementInput = z.infer<typeof reinstatementSchema>;
export type BanInput = z.infer<typeof banSchema>;
export type PlayerFlagsInput = z.infer<typeof playerFlagsSchema>;
export type VarsityNoteInput = z.infer<typeof varsityNoteSchema>;
export type ReliabilityAdjustInput = z.infer<typeof reliabilityAdjustSchema>;
export type LegalAcceptanceInput = z.infer<typeof legalAcceptanceSchema>;
export type AccountDeletionInput = z.infer<typeof accountDeletionSchema>;
export type LegalDocumentUpdateInput = z.infer<typeof legalDocumentUpdateSchema>;
export type WaiverDocumentInput = z.infer<typeof waiverDocumentSchema>;
