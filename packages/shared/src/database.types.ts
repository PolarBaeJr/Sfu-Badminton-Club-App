export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.4"
  }
  public: {
    Tables: {
      announcement_reads: {
        Row: {
          announcement_id: string
          id: string
          player_id: string
          read_at: string
        }
        Insert: {
          announcement_id: string
          id?: string
          player_id: string
          read_at?: string
        }
        Update: {
          announcement_id?: string
          id?: string
          player_id?: string
          read_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "announcement_reads_announcement_id_fkey"
            columns: ["announcement_id"]
            isOneToOne: false
            referencedRelation: "announcements"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "announcement_reads_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      announcements: {
        Row: {
          author_id: string | null
          body: string
          created_at: string
          expires_at: string | null
          id: string
          pinned: boolean
          send_push: boolean
          status: Database["public"]["Enums"]["announcement_status"]
          target_audience: Database["public"]["Enums"]["announcement_audience"]
          title: string
          type: Database["public"]["Enums"]["announcement_type"]
          updated_at: string
        }
        Insert: {
          author_id?: string | null
          body?: string
          created_at?: string
          expires_at?: string | null
          id?: string
          pinned?: boolean
          send_push?: boolean
          status?: Database["public"]["Enums"]["announcement_status"]
          target_audience?: Database["public"]["Enums"]["announcement_audience"]
          title: string
          type?: Database["public"]["Enums"]["announcement_type"]
          updated_at?: string
        }
        Update: {
          author_id?: string | null
          body?: string
          created_at?: string
          expires_at?: string | null
          id?: string
          pinned?: boolean
          send_push?: boolean
          status?: Database["public"]["Enums"]["announcement_status"]
          target_audience?: Database["public"]["Enums"]["announcement_audience"]
          title?: string
          type?: Database["public"]["Enums"]["announcement_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "announcements_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action_type: string
          actor_id: string | null
          created_at: string
          id: string
          new_value: Json | null
          old_value: Json | null
          reason: string | null
          target_id: string | null
          target_type: string
        }
        Insert: {
          action_type: string
          actor_id?: string | null
          created_at?: string
          id?: string
          new_value?: Json | null
          old_value?: Json | null
          reason?: string | null
          target_id?: string | null
          target_type: string
        }
        Update: {
          action_type?: string
          actor_id?: string | null
          created_at?: string
          id?: string
          new_value?: Json | null
          old_value?: Json | null
          reason?: string | null
          target_id?: string | null
          target_type?: string
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_actor_id_fkey"
            columns: ["actor_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      challenge_participants: {
        Row: {
          challenge_id: string
          confirmation_status: Database["public"]["Enums"]["confirmation_status"]
          id: string
          player_id: string
          responded_at: string | null
          role: Database["public"]["Enums"]["participant_role"]
          team_side: Database["public"]["Enums"]["team_side"]
        }
        Insert: {
          challenge_id: string
          confirmation_status?: Database["public"]["Enums"]["confirmation_status"]
          id?: string
          player_id: string
          responded_at?: string | null
          role: Database["public"]["Enums"]["participant_role"]
          team_side: Database["public"]["Enums"]["team_side"]
        }
        Update: {
          challenge_id?: string
          confirmation_status?: Database["public"]["Enums"]["confirmation_status"]
          id?: string
          player_id?: string
          responded_at?: string | null
          role?: Database["public"]["Enums"]["participant_role"]
          team_side?: Database["public"]["Enums"]["team_side"]
        }
        Relationships: [
          {
            foreignKeyName: "challenge_participants_challenge_id_fkey"
            columns: ["challenge_id"]
            isOneToOne: false
            referencedRelation: "challenges"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "challenge_participants_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      challenges: {
        Row: {
          created_at: string
          created_by: string
          event_type: Database["public"]["Enums"]["event_type_enum"]
          expires_at: string
          format: Database["public"]["Enums"]["match_format"]
          id: string
          note: string | null
          qr_expires_at: string | null
          qr_generated_at: string | null
          qr_token: string | null
          rated_flag: boolean
          scheduled_date: string | null
          scheduled_time: string | null
          session_id: string | null
          status: Database["public"]["Enums"]["challenge_status"]
          submitted_via: string
          type: Database["public"]["Enums"]["match_type_enum"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by: string
          event_type?: Database["public"]["Enums"]["event_type_enum"]
          expires_at?: string
          format?: Database["public"]["Enums"]["match_format"]
          id?: string
          note?: string | null
          qr_expires_at?: string | null
          qr_generated_at?: string | null
          qr_token?: string | null
          rated_flag?: boolean
          scheduled_date?: string | null
          scheduled_time?: string | null
          session_id?: string | null
          status?: Database["public"]["Enums"]["challenge_status"]
          submitted_via?: string
          type: Database["public"]["Enums"]["match_type_enum"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string
          event_type?: Database["public"]["Enums"]["event_type_enum"]
          expires_at?: string
          format?: Database["public"]["Enums"]["match_format"]
          id?: string
          note?: string | null
          qr_expires_at?: string | null
          qr_generated_at?: string | null
          qr_token?: string | null
          rated_flag?: boolean
          scheduled_date?: string | null
          scheduled_time?: string | null
          session_id?: string | null
          status?: Database["public"]["Enums"]["challenge_status"]
          submitted_via?: string
          type?: Database["public"]["Enums"]["match_type_enum"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "challenges_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "challenges_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      disputes: {
        Row: {
          created_at: string
          description: string
          id: string
          match_id: string
          opened_by: string
          reason_category: Database["public"]["Enums"]["dispute_reason"]
          resolution_note: string | null
          resolution_type:
            | Database["public"]["Enums"]["dispute_resolution"]
            | null
          resolved_at: string | null
          resolved_by: string | null
          status: Database["public"]["Enums"]["dispute_status"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          description: string
          id?: string
          match_id: string
          opened_by: string
          reason_category: Database["public"]["Enums"]["dispute_reason"]
          resolution_note?: string | null
          resolution_type?:
            | Database["public"]["Enums"]["dispute_resolution"]
            | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: Database["public"]["Enums"]["dispute_status"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          description?: string
          id?: string
          match_id?: string
          opened_by?: string
          reason_category?: Database["public"]["Enums"]["dispute_reason"]
          resolution_note?: string | null
          resolution_type?:
            | Database["public"]["Enums"]["dispute_resolution"]
            | null
          resolved_at?: string | null
          resolved_by?: string | null
          status?: Database["public"]["Enums"]["dispute_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "disputes_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: false
            referencedRelation: "matches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "disputes_opened_by_fkey"
            columns: ["opened_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "disputes_resolved_by_fkey"
            columns: ["resolved_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      head_to_head_stats: {
        Row: {
          id: string
          last_played_at: string | null
          match_type: Database["public"]["Enums"]["match_type_enum"]
          player_a_id: string
          player_a_points: number
          player_a_wins: number
          player_b_id: string
          player_b_points: number
          player_b_wins: number
          total_matches: number
          updated_at: string
        }
        Insert: {
          id?: string
          last_played_at?: string | null
          match_type: Database["public"]["Enums"]["match_type_enum"]
          player_a_id: string
          player_a_points?: number
          player_a_wins?: number
          player_b_id: string
          player_b_points?: number
          player_b_wins?: number
          total_matches?: number
          updated_at?: string
        }
        Update: {
          id?: string
          last_played_at?: string | null
          match_type?: Database["public"]["Enums"]["match_type_enum"]
          player_a_id?: string
          player_a_points?: number
          player_a_wins?: number
          player_b_id?: string
          player_b_points?: number
          player_b_wins?: number
          total_matches?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "head_to_head_stats_player_a_id_fkey"
            columns: ["player_a_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "head_to_head_stats_player_b_id_fkey"
            columns: ["player_b_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      match_games: {
        Row: {
          game_number: number
          id: string
          match_id: string
          side_a_score: number
          side_b_score: number
        }
        Insert: {
          game_number: number
          id?: string
          match_id: string
          side_a_score?: number
          side_b_score?: number
        }
        Update: {
          game_number?: number
          id?: string
          match_id?: string
          side_a_score?: number
          side_b_score?: number
        }
        Relationships: [
          {
            foreignKeyName: "match_games_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: false
            referencedRelation: "matches"
            referencedColumns: ["id"]
          },
        ]
      }
      match_participants: {
        Row: {
          games_lost: number
          games_won: number
          id: string
          match_id: string
          player_id: string
          points_allowed: number
          points_scored: number
          post_rating: number | null
          pre_rating: number
          rating_delta: number | null
          submitted_score: string | null
          team_side: Database["public"]["Enums"]["team_side"]
          win_flag: boolean | null
        }
        Insert: {
          games_lost?: number
          games_won?: number
          id?: string
          match_id: string
          player_id: string
          points_allowed?: number
          points_scored?: number
          post_rating?: number | null
          pre_rating?: number
          rating_delta?: number | null
          submitted_score?: string | null
          team_side: Database["public"]["Enums"]["team_side"]
          win_flag?: boolean | null
        }
        Update: {
          games_lost?: number
          games_won?: number
          id?: string
          match_id?: string
          player_id?: string
          points_allowed?: number
          points_scored?: number
          post_rating?: number | null
          pre_rating?: number
          rating_delta?: number | null
          submitted_score?: string | null
          team_side?: Database["public"]["Enums"]["team_side"]
          win_flag?: boolean | null
        }
        Relationships: [
          {
            foreignKeyName: "match_participants_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: false
            referencedRelation: "matches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "match_participants_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      matches: {
        Row: {
          admin_note: string | null
          challenge_id: string | null
          completed_flag: boolean
          confirmed_by: string | null
          created_at: string
          elo_weight_override: number | null
          event_multiplier: number
          event_type: Database["public"]["Enums"]["event_type_enum"]
          forfeit_player_id: string | null
          format: Database["public"]["Enums"]["match_format"]
          format_weight: number
          id: string
          match_type: Database["public"]["Enums"]["match_type_enum"]
          notice_hours: number | null
          played_at: string | null
          rated_flag: boolean
          result_status: Database["public"]["Enums"]["result_status"]
          score_summary: string | null
          season_id: string | null
          session_id: string | null
          submitted_by: string | null
          tournament_id: string | null
          updated_at: string
          walkover_type: Database["public"]["Enums"]["walkover_type"] | null
          winner_side: Database["public"]["Enums"]["team_side"] | null
        }
        Insert: {
          admin_note?: string | null
          challenge_id?: string | null
          completed_flag?: boolean
          confirmed_by?: string | null
          created_at?: string
          elo_weight_override?: number | null
          event_multiplier?: number
          event_type?: Database["public"]["Enums"]["event_type_enum"]
          forfeit_player_id?: string | null
          format?: Database["public"]["Enums"]["match_format"]
          format_weight?: number
          id?: string
          match_type: Database["public"]["Enums"]["match_type_enum"]
          notice_hours?: number | null
          played_at?: string | null
          rated_flag?: boolean
          result_status?: Database["public"]["Enums"]["result_status"]
          score_summary?: string | null
          season_id?: string | null
          session_id?: string | null
          submitted_by?: string | null
          tournament_id?: string | null
          updated_at?: string
          walkover_type?: Database["public"]["Enums"]["walkover_type"] | null
          winner_side?: Database["public"]["Enums"]["team_side"] | null
        }
        Update: {
          admin_note?: string | null
          challenge_id?: string | null
          completed_flag?: boolean
          confirmed_by?: string | null
          created_at?: string
          elo_weight_override?: number | null
          event_multiplier?: number
          event_type?: Database["public"]["Enums"]["event_type_enum"]
          forfeit_player_id?: string | null
          format?: Database["public"]["Enums"]["match_format"]
          format_weight?: number
          id?: string
          match_type?: Database["public"]["Enums"]["match_type_enum"]
          notice_hours?: number | null
          played_at?: string | null
          rated_flag?: boolean
          result_status?: Database["public"]["Enums"]["result_status"]
          score_summary?: string | null
          season_id?: string | null
          session_id?: string | null
          submitted_by?: string | null
          tournament_id?: string | null
          updated_at?: string
          walkover_type?: Database["public"]["Enums"]["walkover_type"] | null
          winner_side?: Database["public"]["Enums"]["team_side"] | null
        }
        Relationships: [
          {
            foreignKeyName: "matches_challenge_id_fkey"
            columns: ["challenge_id"]
            isOneToOne: false
            referencedRelation: "challenges"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matches_confirmed_by_fkey"
            columns: ["confirmed_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matches_forfeit_player_id_fkey"
            columns: ["forfeit_player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matches_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matches_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matches_submitted_by_fkey"
            columns: ["submitted_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "matches_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          body: string | null
          created_at: string
          id: string
          metadata: Json | null
          player_id: string
          read_flag: boolean
          title: string
          type: Database["public"]["Enums"]["notification_type"]
        }
        Insert: {
          body?: string | null
          created_at?: string
          id?: string
          metadata?: Json | null
          player_id: string
          read_flag?: boolean
          title: string
          type: Database["public"]["Enums"]["notification_type"]
        }
        Update: {
          body?: string | null
          created_at?: string
          id?: string
          metadata?: Json | null
          player_id?: string
          read_flag?: boolean
          title?: string
          type?: Database["public"]["Enums"]["notification_type"]
        }
        Relationships: [
          {
            foreignKeyName: "notifications_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      partnership_stats: {
        Row: {
          avg_elo_delta: number
          id: string
          last_played_at: string | null
          losses: number
          matches_played: number
          player_a_id: string
          player_b_id: string
          total_points_conceded: number
          total_points_scored: number
          updated_at: string
          win_rate: number
          wins: number
        }
        Insert: {
          avg_elo_delta?: number
          id?: string
          last_played_at?: string | null
          losses?: number
          matches_played?: number
          player_a_id: string
          player_b_id: string
          total_points_conceded?: number
          total_points_scored?: number
          updated_at?: string
          win_rate?: number
          wins?: number
        }
        Update: {
          avg_elo_delta?: number
          id?: string
          last_played_at?: string | null
          losses?: number
          matches_played?: number
          player_a_id?: string
          player_b_id?: string
          total_points_conceded?: number
          total_points_scored?: number
          updated_at?: string
          win_rate?: number
          wins?: number
        }
        Relationships: [
          {
            foreignKeyName: "partnership_stats_player_a_id_fkey"
            columns: ["player_a_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "partnership_stats_player_b_id_fkey"
            columns: ["player_b_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      platform_settings: {
        Row: {
          key: string
          updated_at: string
          updated_by: string | null
          value: Json
        }
        Insert: {
          key: string
          updated_at?: string
          updated_by?: string | null
          value: Json
        }
        Update: {
          key?: string
          updated_at?: string
          updated_by?: string | null
          value?: Json
        }
        Relationships: [
          {
            foreignKeyName: "platform_settings_updated_by_fkey"
            columns: ["updated_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      player_preferences: {
        Row: {
          auto_accept_challenges: boolean
          available_days: string[]
          available_hours_end: string
          available_hours_start: string
          created_at: string
          cross_skill_matches: boolean
          default_match_type: string
          default_score_format: string
          discoverable: boolean
          home_court: string | null
          notify_league_announcements: boolean
          notify_match_result: boolean
          notify_new_challenge: boolean
          notify_season_updates: boolean
          notify_session_reminder: boolean
          notify_tournaments_events: boolean
          notify_weekly_recap_email: boolean
          notify_weekly_recap_push: boolean
          open_to_doubles: boolean
          player_id: string
          show_match_history: boolean
          show_on_leaderboard: boolean
          show_win_loss_record: boolean
          submission_reminders: boolean
          updated_at: string
        }
        Insert: {
          auto_accept_challenges?: boolean
          available_days?: string[]
          available_hours_end?: string
          available_hours_start?: string
          created_at?: string
          cross_skill_matches?: boolean
          default_match_type?: string
          default_score_format?: string
          discoverable?: boolean
          home_court?: string | null
          notify_league_announcements?: boolean
          notify_match_result?: boolean
          notify_new_challenge?: boolean
          notify_season_updates?: boolean
          notify_session_reminder?: boolean
          notify_tournaments_events?: boolean
          notify_weekly_recap_email?: boolean
          notify_weekly_recap_push?: boolean
          open_to_doubles?: boolean
          player_id: string
          show_match_history?: boolean
          show_on_leaderboard?: boolean
          show_win_loss_record?: boolean
          submission_reminders?: boolean
          updated_at?: string
        }
        Update: {
          auto_accept_challenges?: boolean
          available_days?: string[]
          available_hours_end?: string
          available_hours_start?: string
          created_at?: string
          cross_skill_matches?: boolean
          default_match_type?: string
          default_score_format?: string
          discoverable?: boolean
          home_court?: string | null
          notify_league_announcements?: boolean
          notify_match_result?: boolean
          notify_new_challenge?: boolean
          notify_season_updates?: boolean
          notify_session_reminder?: boolean
          notify_tournaments_events?: boolean
          notify_weekly_recap_email?: boolean
          notify_weekly_recap_push?: boolean
          open_to_doubles?: boolean
          player_id?: string
          show_match_history?: boolean
          show_on_leaderboard?: boolean
          show_win_loss_record?: boolean
          submission_reminders?: boolean
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "player_preferences_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: true
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      players: {
        Row: {
          active_flag: boolean
          avatar_url: string | null
          bio: string | null
          created_at: string
          deleted_at: string | null
          display_name: string | null
          dominant_hand: string | null
          eligibility_flag: boolean
          email: string
          favourite_shot: string | null
          format_preference: string | null
          full_name: string
          goal: string | null
          hide_from_leaderboard: boolean
          id: string
          joined_at: string
          last_active_at: string
          notification_preferences: Json
          onboarding_completed: boolean
          phone: string | null
          profile_visibility: string
          role: Database["public"]["Enums"]["user_role"]
          sfu_student_id: string | null
          show_activity_status: boolean
          skill_level: string | null
          status: Database["public"]["Enums"]["player_status"]
          updated_at: string
          user_id: string | null
          years_playing: string | null
        }
        Insert: {
          active_flag?: boolean
          avatar_url?: string | null
          bio?: string | null
          created_at?: string
          deleted_at?: string | null
          display_name?: string | null
          dominant_hand?: string | null
          eligibility_flag?: boolean
          email: string
          favourite_shot?: string | null
          format_preference?: string | null
          full_name: string
          goal?: string | null
          hide_from_leaderboard?: boolean
          id?: string
          joined_at?: string
          last_active_at?: string
          notification_preferences?: Json
          onboarding_completed?: boolean
          phone?: string | null
          profile_visibility?: string
          role?: Database["public"]["Enums"]["user_role"]
          sfu_student_id?: string | null
          show_activity_status?: boolean
          skill_level?: string | null
          status?: Database["public"]["Enums"]["player_status"]
          updated_at?: string
          user_id?: string | null
          years_playing?: string | null
        }
        Update: {
          active_flag?: boolean
          avatar_url?: string | null
          bio?: string | null
          created_at?: string
          deleted_at?: string | null
          display_name?: string | null
          dominant_hand?: string | null
          eligibility_flag?: boolean
          email?: string
          favourite_shot?: string | null
          format_preference?: string | null
          full_name?: string
          goal?: string | null
          hide_from_leaderboard?: boolean
          id?: string
          joined_at?: string
          last_active_at?: string
          notification_preferences?: Json
          onboarding_completed?: boolean
          phone?: string | null
          profile_visibility?: string
          role?: Database["public"]["Enums"]["user_role"]
          sfu_student_id?: string | null
          show_activity_status?: boolean
          skill_level?: string | null
          status?: Database["public"]["Enums"]["player_status"]
          updated_at?: string
          user_id?: string | null
          years_playing?: string | null
        }
        Relationships: []
      }
      push_subscriptions: {
        Row: {
          active: boolean
          auth_key: string
          created_at: string
          endpoint: string
          id: string
          p256dh_key: string
          player_id: string
          user_agent: string | null
        }
        Insert: {
          active?: boolean
          auth_key: string
          created_at?: string
          endpoint: string
          id?: string
          p256dh_key: string
          player_id: string
          user_agent?: string | null
        }
        Update: {
          active?: boolean
          auth_key?: string
          created_at?: string
          endpoint?: string
          id?: string
          p256dh_key?: string
          player_id?: string
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "push_subscriptions_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      ratings: {
        Row: {
          best_doubles_streak: number
          best_singles_streak: number
          created_at: string
          current_doubles_streak: number
          current_singles_streak: number
          doubles_elo: number
          doubles_games_lost: number
          doubles_games_won: number
          doubles_k_factor: number
          doubles_losses: number
          doubles_matches_played: number
          doubles_points_allowed: number
          doubles_points_scored: number
          doubles_provisional: boolean
          doubles_wins: number
          id: string
          player_id: string
          singles_elo: number
          singles_games_lost: number
          singles_games_won: number
          singles_k_factor: number
          singles_losses: number
          singles_matches_played: number
          singles_points_allowed: number
          singles_points_scored: number
          singles_provisional: boolean
          singles_wins: number
          updated_at: string
        }
        Insert: {
          best_doubles_streak?: number
          best_singles_streak?: number
          created_at?: string
          current_doubles_streak?: number
          current_singles_streak?: number
          doubles_elo?: number
          doubles_games_lost?: number
          doubles_games_won?: number
          doubles_k_factor?: number
          doubles_losses?: number
          doubles_matches_played?: number
          doubles_points_allowed?: number
          doubles_points_scored?: number
          doubles_provisional?: boolean
          doubles_wins?: number
          id?: string
          player_id: string
          singles_elo?: number
          singles_games_lost?: number
          singles_games_won?: number
          singles_k_factor?: number
          singles_losses?: number
          singles_matches_played?: number
          singles_points_allowed?: number
          singles_points_scored?: number
          singles_provisional?: boolean
          singles_wins?: number
          updated_at?: string
        }
        Update: {
          best_doubles_streak?: number
          best_singles_streak?: number
          created_at?: string
          current_doubles_streak?: number
          current_singles_streak?: number
          doubles_elo?: number
          doubles_games_lost?: number
          doubles_games_won?: number
          doubles_k_factor?: number
          doubles_losses?: number
          doubles_matches_played?: number
          doubles_points_allowed?: number
          doubles_points_scored?: number
          doubles_provisional?: boolean
          doubles_wins?: number
          id?: string
          player_id?: string
          singles_elo?: number
          singles_games_lost?: number
          singles_games_won?: number
          singles_k_factor?: number
          singles_losses?: number
          singles_matches_played?: number
          singles_points_allowed?: number
          singles_points_scored?: number
          singles_provisional?: boolean
          singles_wins?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ratings_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: true
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      reliability_metrics: {
        Row: {
          avg_confirmation_minutes: number
          challenges_accepted: number
          challenges_expired: number
          challenges_issued: number
          challenges_rejected: number
          dispute_involvement_count: number
          early_withdrawals: number
          id: string
          late_cancellations: number
          matches_completed: number
          no_shows: number
          player_id: string
          updated_at: string
          walkover_flag: boolean
          walkovers_received: number
        }
        Insert: {
          avg_confirmation_minutes?: number
          challenges_accepted?: number
          challenges_expired?: number
          challenges_issued?: number
          challenges_rejected?: number
          dispute_involvement_count?: number
          early_withdrawals?: number
          id?: string
          late_cancellations?: number
          matches_completed?: number
          no_shows?: number
          player_id: string
          updated_at?: string
          walkover_flag?: boolean
          walkovers_received?: number
        }
        Update: {
          avg_confirmation_minutes?: number
          challenges_accepted?: number
          challenges_expired?: number
          challenges_issued?: number
          challenges_rejected?: number
          dispute_involvement_count?: number
          early_withdrawals?: number
          id?: string
          late_cancellations?: number
          matches_completed?: number
          no_shows?: number
          player_id?: string
          updated_at?: string
          walkover_flag?: boolean
          walkovers_received?: number
        }
        Relationships: [
          {
            foreignKeyName: "reliability_metrics_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: true
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      season_snapshots: {
        Row: {
          captured_at: string
          doubles_losses: number
          doubles_matches_played: number
          doubles_rank: number | null
          doubles_wins: number
          final_doubles_elo: number
          final_singles_elo: number
          id: string
          player_id: string
          season_id: string
          singles_losses: number
          singles_matches_played: number
          singles_rank: number | null
          singles_wins: number
        }
        Insert: {
          captured_at?: string
          doubles_losses?: number
          doubles_matches_played?: number
          doubles_rank?: number | null
          doubles_wins?: number
          final_doubles_elo: number
          final_singles_elo: number
          id?: string
          player_id: string
          season_id: string
          singles_losses?: number
          singles_matches_played?: number
          singles_rank?: number | null
          singles_wins?: number
        }
        Update: {
          captured_at?: string
          doubles_losses?: number
          doubles_matches_played?: number
          doubles_rank?: number | null
          doubles_wins?: number
          final_doubles_elo?: number
          final_singles_elo?: number
          id?: string
          player_id?: string
          season_id?: string
          singles_losses?: number
          singles_matches_played?: number
          singles_rank?: number | null
          singles_wins?: number
        }
        Relationships: [
          {
            foreignKeyName: "season_snapshots_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "season_snapshots_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
        ]
      }
      seasons: {
        Row: {
          active_flag: boolean
          created_at: string
          end_date: string | null
          id: string
          name: string
          start_date: string
          updated_at: string
        }
        Insert: {
          active_flag?: boolean
          created_at?: string
          end_date?: string | null
          id?: string
          name: string
          start_date: string
          updated_at?: string
        }
        Update: {
          active_flag?: boolean
          created_at?: string
          end_date?: string | null
          id?: string
          name?: string
          start_date?: string
          updated_at?: string
        }
        Relationships: []
      }
      session_attendance: {
        Row: {
          checked_in_at: string
          id: string
          player_id: string
          session_id: string
        }
        Insert: {
          checked_in_at?: string
          id?: string
          player_id: string
          session_id: string
        }
        Update: {
          checked_in_at?: string
          id?: string
          player_id?: string
          session_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "session_attendance_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "session_attendance_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
      sessions: {
        Row: {
          capacity: number | null
          created_at: string
          date: string
          end_time: string | null
          featured: boolean
          host_player_id: string | null
          id: string
          location: string
          name: string | null
          notes: string | null
          season_id: string | null
          start_time: string | null
          status: Database["public"]["Enums"]["session_status"]
          updated_at: string
        }
        Insert: {
          capacity?: number | null
          created_at?: string
          date: string
          end_time?: string | null
          featured?: boolean
          host_player_id?: string | null
          id?: string
          location: string
          name?: string | null
          notes?: string | null
          season_id?: string | null
          start_time?: string | null
          status?: Database["public"]["Enums"]["session_status"]
          updated_at?: string
        }
        Update: {
          capacity?: number | null
          created_at?: string
          date?: string
          end_time?: string | null
          featured?: boolean
          host_player_id?: string | null
          id?: string
          location?: string
          name?: string | null
          notes?: string | null
          season_id?: string | null
          start_time?: string | null
          status?: Database["public"]["Enums"]["session_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "sessions_host_player_id_fkey"
            columns: ["host_player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "sessions_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
        ]
      }
      tournament_audit_log: {
        Row: {
          action: string
          created_at: string | null
          details: Json | null
          event_id: string | null
          id: string
          match_id: string | null
          performed_by: string | null
          tournament_id: string | null
        }
        Insert: {
          action: string
          created_at?: string | null
          details?: Json | null
          event_id?: string | null
          id?: string
          match_id?: string | null
          performed_by?: string | null
          tournament_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string | null
          details?: Json | null
          event_id?: string | null
          id?: string
          match_id?: string | null
          performed_by?: string | null
          tournament_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tournament_audit_log_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "tournament_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_audit_log_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: false
            referencedRelation: "tournament_matches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_audit_log_performed_by_fkey"
            columns: ["performed_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_audit_log_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      tournament_events: {
        Row: {
          created_at: string | null
          draw_locked: boolean | null
          elo_multiplier: number | null
          event_type: string
          format: string
          id: string
          match_format: string
          max_participants: number | null
          placement_bonus_enabled: boolean | null
          seeding_method: string
          status: string
          tournament_id: string
          updated_at: string | null
        }
        Insert: {
          created_at?: string | null
          draw_locked?: boolean | null
          elo_multiplier?: number | null
          event_type: string
          format: string
          id?: string
          match_format?: string
          max_participants?: number | null
          placement_bonus_enabled?: boolean | null
          seeding_method?: string
          status?: string
          tournament_id: string
          updated_at?: string | null
        }
        Update: {
          created_at?: string | null
          draw_locked?: boolean | null
          elo_multiplier?: number | null
          event_type?: string
          format?: string
          id?: string
          match_format?: string
          max_participants?: number | null
          placement_bonus_enabled?: boolean | null
          seeding_method?: string
          status?: string
          tournament_id?: string
          updated_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tournament_events_tournament_id_fkey"
            columns: ["tournament_id"]
            isOneToOne: false
            referencedRelation: "tournaments"
            referencedColumns: ["id"]
          },
        ]
      }
      tournament_matches: {
        Row: {
          bracket_position: number
          court: string | null
          created_at: string | null
          elo_snapshot: Json | null
          event_id: string
          id: string
          is_bye: boolean | null
          loser_pair_id: string | null
          loser_participant_id: string | null
          match_number: number | null
          notes: string | null
          pair_a_id: string | null
          pair_b_id: string | null
          participant_a_id: string | null
          participant_b_id: string | null
          result_entered_at: string | null
          result_entered_by: string | null
          round_name: string | null
          round_number: number
          scheduled_time: string | null
          scores: Json | null
          status: string
          updated_at: string | null
          walkover_reason: string | null
          walkover_winner: string | null
          winner_pair_id: string | null
          winner_participant_id: string | null
          winner_to_match_id: string | null
          winner_to_position: string | null
        }
        Insert: {
          bracket_position: number
          court?: string | null
          created_at?: string | null
          elo_snapshot?: Json | null
          event_id: string
          id?: string
          is_bye?: boolean | null
          loser_pair_id?: string | null
          loser_participant_id?: string | null
          match_number?: number | null
          notes?: string | null
          pair_a_id?: string | null
          pair_b_id?: string | null
          participant_a_id?: string | null
          participant_b_id?: string | null
          result_entered_at?: string | null
          result_entered_by?: string | null
          round_name?: string | null
          round_number: number
          scheduled_time?: string | null
          scores?: Json | null
          status?: string
          updated_at?: string | null
          walkover_reason?: string | null
          walkover_winner?: string | null
          winner_pair_id?: string | null
          winner_participant_id?: string | null
          winner_to_match_id?: string | null
          winner_to_position?: string | null
        }
        Update: {
          bracket_position?: number
          court?: string | null
          created_at?: string | null
          elo_snapshot?: Json | null
          event_id?: string
          id?: string
          is_bye?: boolean | null
          loser_pair_id?: string | null
          loser_participant_id?: string | null
          match_number?: number | null
          notes?: string | null
          pair_a_id?: string | null
          pair_b_id?: string | null
          participant_a_id?: string | null
          participant_b_id?: string | null
          result_entered_at?: string | null
          result_entered_by?: string | null
          round_name?: string | null
          round_number?: number
          scheduled_time?: string | null
          scores?: Json | null
          status?: string
          updated_at?: string | null
          walkover_reason?: string | null
          walkover_winner?: string | null
          winner_pair_id?: string | null
          winner_participant_id?: string | null
          winner_to_match_id?: string | null
          winner_to_position?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tournament_matches_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "tournament_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_matches_loser_pair_id_fkey"
            columns: ["loser_pair_id"]
            isOneToOne: false
            referencedRelation: "tournament_pairs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_matches_loser_participant_id_fkey"
            columns: ["loser_participant_id"]
            isOneToOne: false
            referencedRelation: "tournament_participants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_matches_pair_a_id_fkey"
            columns: ["pair_a_id"]
            isOneToOne: false
            referencedRelation: "tournament_pairs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_matches_pair_b_id_fkey"
            columns: ["pair_b_id"]
            isOneToOne: false
            referencedRelation: "tournament_pairs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_matches_participant_a_id_fkey"
            columns: ["participant_a_id"]
            isOneToOne: false
            referencedRelation: "tournament_participants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_matches_participant_b_id_fkey"
            columns: ["participant_b_id"]
            isOneToOne: false
            referencedRelation: "tournament_participants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_matches_result_entered_by_fkey"
            columns: ["result_entered_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_matches_winner_pair_id_fkey"
            columns: ["winner_pair_id"]
            isOneToOne: false
            referencedRelation: "tournament_pairs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_matches_winner_participant_id_fkey"
            columns: ["winner_participant_id"]
            isOneToOne: false
            referencedRelation: "tournament_participants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_matches_winner_to_match_id_fkey"
            columns: ["winner_to_match_id"]
            isOneToOne: false
            referencedRelation: "tournament_matches"
            referencedColumns: ["id"]
          },
        ]
      }
      tournament_pairs: {
        Row: {
          added_by: string | null
          checked_in_at: string | null
          checked_in_by: string | null
          combined_elo: number | null
          created_at: string | null
          event_id: string
          final_position: number | null
          id: string
          notes: string | null
          pair_name: string | null
          player1_id: string
          player2_id: string
          points: number | null
          seed_number: number | null
          status: string
        }
        Insert: {
          added_by?: string | null
          checked_in_at?: string | null
          checked_in_by?: string | null
          combined_elo?: number | null
          created_at?: string | null
          event_id: string
          final_position?: number | null
          id?: string
          notes?: string | null
          pair_name?: string | null
          player1_id: string
          player2_id: string
          points?: number | null
          seed_number?: number | null
          status?: string
        }
        Update: {
          added_by?: string | null
          checked_in_at?: string | null
          checked_in_by?: string | null
          combined_elo?: number | null
          created_at?: string | null
          event_id?: string
          final_position?: number | null
          id?: string
          notes?: string | null
          pair_name?: string | null
          player1_id?: string
          player2_id?: string
          points?: number | null
          seed_number?: number | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "tournament_pairs_added_by_fkey"
            columns: ["added_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_pairs_checked_in_by_fkey"
            columns: ["checked_in_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_pairs_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "tournament_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_pairs_player1_id_fkey"
            columns: ["player1_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_pairs_player2_id_fkey"
            columns: ["player2_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      tournament_participants: {
        Row: {
          added_by: string | null
          checked_in_at: string | null
          checked_in_by: string | null
          created_at: string | null
          elo_after: number | null
          elo_before: number | null
          elo_change: number | null
          event_id: string
          final_position: number | null
          id: string
          notes: string | null
          player_id: string
          points: number | null
          seed_number: number | null
          status: string
        }
        Insert: {
          added_by?: string | null
          checked_in_at?: string | null
          checked_in_by?: string | null
          created_at?: string | null
          elo_after?: number | null
          elo_before?: number | null
          elo_change?: number | null
          event_id: string
          final_position?: number | null
          id?: string
          notes?: string | null
          player_id: string
          points?: number | null
          seed_number?: number | null
          status?: string
        }
        Update: {
          added_by?: string | null
          checked_in_at?: string | null
          checked_in_by?: string | null
          created_at?: string | null
          elo_after?: number | null
          elo_before?: number | null
          elo_change?: number | null
          event_id?: string
          final_position?: number | null
          id?: string
          notes?: string | null
          player_id?: string
          points?: number | null
          seed_number?: number | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "tournament_participants_added_by_fkey"
            columns: ["added_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_participants_checked_in_by_fkey"
            columns: ["checked_in_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_participants_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "tournament_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournament_participants_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      tournaments: {
        Row: {
          bracket_size: number | null
          created_at: string
          created_by: string | null
          end_date: string | null
          event_multiplier: number
          format: Database["public"]["Enums"]["tournament_format"]
          id: string
          name: string
          placement_bonus_enabled: boolean
          scope: Database["public"]["Enums"]["tournament_scope"]
          season_id: string | null
          start_date: string
          status: Database["public"]["Enums"]["tournament_status"]
          type: Database["public"]["Enums"]["tournament_type"]
          updated_at: string
        }
        Insert: {
          bracket_size?: number | null
          created_at?: string
          created_by?: string | null
          end_date?: string | null
          event_multiplier?: number
          format?: Database["public"]["Enums"]["tournament_format"]
          id?: string
          name: string
          placement_bonus_enabled?: boolean
          scope?: Database["public"]["Enums"]["tournament_scope"]
          season_id?: string | null
          start_date: string
          status?: Database["public"]["Enums"]["tournament_status"]
          type?: Database["public"]["Enums"]["tournament_type"]
          updated_at?: string
        }
        Update: {
          bracket_size?: number | null
          created_at?: string
          created_by?: string | null
          end_date?: string | null
          event_multiplier?: number
          format?: Database["public"]["Enums"]["tournament_format"]
          id?: string
          name?: string
          placement_bonus_enabled?: boolean
          scope?: Database["public"]["Enums"]["tournament_scope"]
          season_id?: string | null
          start_date?: string
          status?: Database["public"]["Enums"]["tournament_status"]
          type?: Database["public"]["Enums"]["tournament_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tournaments_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tournaments_season_id_fkey"
            columns: ["season_id"]
            isOneToOne: false
            referencedRelation: "seasons"
            referencedColumns: ["id"]
          },
        ]
      }
      varsity_notes: {
        Row: {
          author_id: string
          created_at: string
          id: string
          note: string
          player_id: string
          updated_at: string
        }
        Insert: {
          author_id: string
          created_at?: string
          id?: string
          note: string
          player_id: string
          updated_at?: string
        }
        Update: {
          author_id?: string
          created_at?: string
          id?: string
          note?: string
          player_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "varsity_notes_author_id_fkey"
            columns: ["author_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "varsity_notes_player_id_fkey"
            columns: ["player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
      walkovers: {
        Row: {
          admin_confirmed_at: string | null
          admin_confirmed_by: string | null
          admin_notes: string | null
          challenge_id: string
          created_at: string
          elo_penalty_applied: boolean
          forfeit_player_id: string
          grace_period_ends_at: string | null
          id: string
          match_id: string | null
          notice_hours: number | null
          reported_at: string
          reported_by: string
          status: Database["public"]["Enums"]["walkover_status"]
          updated_at: string
          walkover_type: Database["public"]["Enums"]["walkover_type"]
        }
        Insert: {
          admin_confirmed_at?: string | null
          admin_confirmed_by?: string | null
          admin_notes?: string | null
          challenge_id: string
          created_at?: string
          elo_penalty_applied?: boolean
          forfeit_player_id: string
          grace_period_ends_at?: string | null
          id?: string
          match_id?: string | null
          notice_hours?: number | null
          reported_at?: string
          reported_by: string
          status?: Database["public"]["Enums"]["walkover_status"]
          updated_at?: string
          walkover_type: Database["public"]["Enums"]["walkover_type"]
        }
        Update: {
          admin_confirmed_at?: string | null
          admin_confirmed_by?: string | null
          admin_notes?: string | null
          challenge_id?: string
          created_at?: string
          elo_penalty_applied?: boolean
          forfeit_player_id?: string
          grace_period_ends_at?: string | null
          id?: string
          match_id?: string | null
          notice_hours?: number | null
          reported_at?: string
          reported_by?: string
          status?: Database["public"]["Enums"]["walkover_status"]
          updated_at?: string
          walkover_type?: Database["public"]["Enums"]["walkover_type"]
        }
        Relationships: [
          {
            foreignKeyName: "walkovers_admin_confirmed_by_fkey"
            columns: ["admin_confirmed_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "walkovers_challenge_id_fkey"
            columns: ["challenge_id"]
            isOneToOne: false
            referencedRelation: "challenges"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "walkovers_forfeit_player_id_fkey"
            columns: ["forfeit_player_id"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "walkovers_match_id_fkey"
            columns: ["match_id"]
            isOneToOne: false
            referencedRelation: "matches"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "walkovers_reported_by_fkey"
            columns: ["reported_by"]
            isOneToOne: false
            referencedRelation: "players"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      session_attendance_counts: {
        Row: {
          count: number | null
          session_id: string | null
        }
        Relationships: [
          {
            foreignKeyName: "session_attendance_session_id_fkey"
            columns: ["session_id"]
            isOneToOne: false
            referencedRelation: "sessions"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      apply_match_result: {
        Args: { p_confirmed_by: string; p_match_id: string }
        Returns: undefined
      }
      apply_walkover_result:
        | { Args: { p_walkover_id: string }; Returns: undefined }
        | {
            Args: {
              p_admin_id: string
              p_admin_notes?: string
              p_walkover_id: string
            }
            Returns: undefined
          }
      calculate_elo_update:
        | {
            Args: {
              p_actual: number
              p_elo_weight_override?: number
              p_event_multiplier: number
              p_format_weight: number
              p_k_factor: number
              p_opponent_rating: number
              p_player_rating: number
            }
            Returns: number
          }
        | {
            Args: {
              p_event_multiplier: number
              p_format_weight: number
              p_k_factor: number
              p_opponent_rating: number
              p_player_rating: number
              p_won: boolean
            }
            Returns: {
              delta: number
              expected: number
              new_rating: number
            }[]
          }
      calculate_season_compression: {
        Args: { p_factor?: number }
        Returns: undefined
      }
      capture_season_snapshot: {
        Args: { p_season_id: string }
        Returns: undefined
      }
      check_doubles_repeat_caps: {
        Args: { p_team_a_ids: string[]; p_team_b_ids: string[] }
        Returns: boolean
      }
      check_repeat_opponent_caps:
        | {
            Args: {
              p_match_type: Database["public"]["Enums"]["match_type_enum"]
              p_opponent_id: string
              p_player_id: string
            }
            Returns: boolean
          }
        | {
            Args: {
              p_match_type: string
              p_opponent_id: string
              p_player_id: string
            }
            Returns: boolean
          }
      check_session_caps:
        | {
            Args: {
              p_match_type: Database["public"]["Enums"]["match_type_enum"]
              p_player_id: string
              p_session_id: string
            }
            Returns: boolean
          }
        | {
            Args: {
              p_match_type: string
              p_player_id: string
              p_session_id: string
            }
            Returns: boolean
          }
      get_event_multiplier: {
        Args: { evt: Database["public"]["Enums"]["event_type_enum"] }
        Returns: number
      }
      get_format_weight: {
        Args: { fmt: Database["public"]["Enums"]["match_format"] }
        Returns: number
      }
      get_player_id: { Args: { p_user_id: string }; Returns: string }
      increment_challenges_issued: {
        Args: { p_player_id: string }
        Returns: undefined
      }
      is_admin: { Args: { p_user_id: string }; Returns: boolean }
      is_admin_or_coach: { Args: { p_user_id: string }; Returns: boolean }
      reverse_match_result: { Args: { p_match_id: string }; Returns: undefined }
      update_head_to_head: { Args: { p_match_id: string }; Returns: undefined }
      update_partnership_stats: {
        Args: { p_match_id: string }
        Returns: undefined
      }
      validate_challenge_creation:
        | {
            Args: {
              p_creator_id: string
              p_opponent_id: string
              p_opponent_partner_id?: string
              p_partner_id?: string
              p_type: Database["public"]["Enums"]["match_type_enum"]
            }
            Returns: Json
          }
        | {
            Args: {
              p_creator_id: string
              p_opponent_id: string
              p_opponent_partner_id?: string
              p_partner_id?: string
              p_type: string
            }
            Returns: Json
          }
    }
    Enums: {
      announcement_audience:
        | "all"
        | "competitive"
        | "recreational"
        | "eligible_only"
      announcement_status: "draft" | "published"
      announcement_type: "info" | "warning" | "urgent" | "event"
      challenge_status:
        | "proposed"
        | "partially_confirmed"
        | "accepted"
        | "rejected"
        | "expired"
        | "cancelled"
        | "completed"
        | "disputed"
        | "walkover_pending"
        | "walkover_confirmed"
      confirmation_status: "pending" | "accepted" | "rejected"
      dispute_reason:
        | "score_wrong"
        | "winner_wrong"
        | "format_wrong"
        | "incomplete"
        | "abuse"
        | "rules_violation"
        | "other"
      dispute_resolution:
        | "accepted"
        | "edited"
        | "voided"
        | "converted_to_casual"
      dispute_status: "open" | "under_review" | "resolved"
      event_type_enum:
        | "rated_challenge"
        | "casual"
        | "tournament"
        | "trial"
        | "admin_entered"
      match_format: "bo3_21" | "single_21" | "single_15" | "single_11"
      match_type_enum: "singles" | "doubles"
      notification_type:
        | "challenge_received"
        | "challenge_accepted"
        | "challenge_rejected"
        | "challenge_expired"
        | "challenge_cancelled"
        | "result_pending"
        | "result_confirmed"
        | "dispute_opened"
        | "dispute_resolved"
        | "rank_changed"
        | "session_reminder"
        | "walkover_reported"
        | "walkover_confirmed"
        | "opponent_withdrew"
        | "admin_alert"
        | "general"
        | "tournament_bracket_published"
        | "tournament_match_ready"
        | "tournament_match_result"
        | "tournament_event_completed"
        | "tournament_checkin_open"
      participant_role:
        | "challenger"
        | "opponent"
        | "partner"
        | "opponent_partner"
      player_status:
        | "eligible_competitive"
        | "competitive_associate"
        | "recreational"
        | "alumni_external"
        | "suspended"
        | "inactive"
        | "pending_approval"
        | "competitive"
      result_status:
        | "pending_submission"
        | "pending_confirmation"
        | "confirmed"
        | "disputed"
        | "voided"
        | "walkover"
        | "incomplete"
      session_status: "open" | "closed"
      team_side: "a" | "b"
      tournament_format: "singles" | "doubles" | "mixed_event"
      tournament_scope: "open" | "eligible_only"
      tournament_status: "draft" | "active" | "completed" | "archived"
      tournament_type: "internal" | "open_official" | "invitational"
      user_role: "player" | "moderator" | "admin" | "coach_executive"
      walkover_status: "pending" | "confirmed" | "rejected"
      walkover_type: "withdrawal" | "no_show"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      announcement_audience: [
        "all",
        "competitive",
        "recreational",
        "eligible_only",
      ],
      announcement_status: ["draft", "published"],
      announcement_type: ["info", "warning", "urgent", "event"],
      challenge_status: [
        "proposed",
        "partially_confirmed",
        "accepted",
        "rejected",
        "expired",
        "cancelled",
        "completed",
        "disputed",
        "walkover_pending",
        "walkover_confirmed",
      ],
      confirmation_status: ["pending", "accepted", "rejected"],
      dispute_reason: [
        "score_wrong",
        "winner_wrong",
        "format_wrong",
        "incomplete",
        "abuse",
        "rules_violation",
        "other",
      ],
      dispute_resolution: [
        "accepted",
        "edited",
        "voided",
        "converted_to_casual",
      ],
      dispute_status: ["open", "under_review", "resolved"],
      event_type_enum: [
        "rated_challenge",
        "casual",
        "tournament",
        "trial",
        "admin_entered",
      ],
      match_format: ["bo3_21", "single_21", "single_15", "single_11"],
      match_type_enum: ["singles", "doubles"],
      notification_type: [
        "challenge_received",
        "challenge_accepted",
        "challenge_rejected",
        "challenge_expired",
        "challenge_cancelled",
        "result_pending",
        "result_confirmed",
        "dispute_opened",
        "dispute_resolved",
        "rank_changed",
        "session_reminder",
        "walkover_reported",
        "walkover_confirmed",
        "opponent_withdrew",
        "admin_alert",
        "general",
        "tournament_bracket_published",
        "tournament_match_ready",
        "tournament_match_result",
        "tournament_event_completed",
        "tournament_checkin_open",
      ],
      participant_role: [
        "challenger",
        "opponent",
        "partner",
        "opponent_partner",
      ],
      player_status: [
        "eligible_competitive",
        "competitive_associate",
        "recreational",
        "alumni_external",
        "suspended",
        "inactive",
        "pending_approval",
        "competitive",
      ],
      result_status: [
        "pending_submission",
        "pending_confirmation",
        "confirmed",
        "disputed",
        "voided",
        "walkover",
        "incomplete",
      ],
      session_status: ["open", "closed"],
      team_side: ["a", "b"],
      tournament_format: ["singles", "doubles", "mixed_event"],
      tournament_scope: ["open", "eligible_only"],
      tournament_status: ["draft", "active", "completed", "archived"],
      tournament_type: ["internal", "open_official", "invitational"],
      user_role: ["player", "moderator", "admin", "coach_executive"],
      walkover_status: ["pending", "confirmed", "rejected"],
      walkover_type: ["withdrawal", "no_show"],
    },
  },
} as const
