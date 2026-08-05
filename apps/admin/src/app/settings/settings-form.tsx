'use client';

import { useState } from 'react';
import { Button, Textarea } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import { updatePlatformSettings } from './actions';

interface PlatformSetting {
  key: string;
  value: Record<string, unknown>;
  updated_by: string | null;
  updated_at: string;
}

const SETTING_LABELS: Record<string, string> = {
  challenge_rules: 'Challenge Rules',
  session_caps: 'Session Caps',
  repeat_opponent_caps: 'Repeat Opponent Caps',
  walkover_rules: 'Walkover & No-Show Rules',
  rating_defaults: 'Rating Defaults',
  tournament_bonuses: 'Tournament Bonuses',
  season_settings: 'Season Settings',
  inactivity_rules: 'Inactivity Rules',
  session_attendance: 'Session Attendance',
};

const SETTING_DESCRIPTIONS: Record<string, string> = {
  challenge_rules: 'Elo range, ladder range, max active challenges, expiry hours',
  session_caps: 'Maximum rated matches per session (singles and doubles)',
  repeat_opponent_caps: 'Maximum rated matches against the same opponent in a rolling window',
  walkover_rules: 'Grace periods, withdrawal thresholds, auto-flag and auto-suspend limits',
  rating_defaults: 'Starting Elo, provisional threshold, K-factors',
  tournament_bonuses: 'Placement bonus amounts for singles and doubles tournaments',
  season_settings: 'Compression factor for end-of-season Elo normalization',
  inactivity_rules: 'Days of inactivity before auto-marking players inactive',
  session_attendance: 'Check-in window and default session duration',
};

interface FieldMeta {
  label: string;
  hint: string;
  type: 'number' | 'boolean' | 'text';
  min?: number;
  max?: number;
  step?: number;
  nullable?: boolean;
}

const FIELD_META: Record<string, Record<string, FieldMeta>> = {
  challenge_rules: {
    elo_range: {
      label: 'Elo range',
      hint: 'Players can only challenge within this many Elo points.',
      type: 'number',
      min: 0,
      step: 1,
    },
    ladder_range: {
      label: 'Ladder range',
      hint: 'Players can only challenge within this many ladder positions.',
      type: 'number',
      min: 0,
      step: 1,
    },
    max_active_challenges: {
      label: 'Max active challenges',
      hint: 'Each player can have at most this many open challenges at a time.',
      type: 'number',
      min: 1,
      step: 1,
    },
    challenge_expiry_hours: {
      label: 'Challenge expiry (hours)',
      hint: 'Unanswered challenges expire after this many hours.',
      type: 'number',
      min: 1,
      step: 1,
    },
  },
  session_caps: {
    max_rated_singles_per_session: {
      label: 'Max rated singles per session',
      hint: 'Rated singles matches one player can play in a single session.',
      type: 'number',
      min: 0,
      step: 1,
    },
    max_rated_doubles_per_session: {
      label: 'Max rated doubles per session',
      hint: 'Rated doubles matches one player can play in a single session.',
      type: 'number',
      min: 0,
      step: 1,
    },
  },
  repeat_opponent_caps: {
    max_rated_singles_vs_same_7days: {
      label: 'Rated singles vs same opponent',
      hint: 'Rated singles against the same opponent allowed within the window below.',
      type: 'number',
      min: 0,
      step: 1,
    },
    max_rated_doubles_same_combo_7days: {
      label: 'Rated doubles, same combo',
      hint: 'Rated doubles with the same team combination allowed within the window below.',
      type: 'number',
      min: 0,
      step: 1,
    },
    // The window was hardcoded at 7 days and only implied by the key names
    // above, which are kept as-is so existing stored values keep working.
    window_days: {
      label: 'Rolling window (days)',
      hint: 'How far back the two caps above look. Defaults to 7.',
      type: 'number',
      min: 1,
      step: 1,
    },
  },
  walkover_rules: {
    grace_period_minutes: {
      label: 'Grace period (minutes)',
      hint: 'How long a player can be late before the match can be claimed as a walkover.',
      type: 'number',
      min: 0,
      step: 1,
    },
    admin_review_window_hours: {
      label: 'Admin review window (hours)',
      hint: 'How long admins have to review a reported walkover before it stands.',
      type: 'number',
      min: 0,
      step: 1,
    },
    late_withdrawal_threshold_hours: {
      label: 'Late withdrawal threshold (hours)',
      hint: 'Withdrawing closer to the session than this counts as a late withdrawal.',
      type: 'number',
      min: 0,
      step: 1,
    },
    no_show_auto_flag_threshold: {
      label: 'No-show auto-flag',
      hint: 'No-shows within the rolling window before a player is flagged for review.',
      type: 'number',
      min: 1,
      step: 1,
    },
    no_show_auto_flag_rolling_days: {
      label: 'No-show rolling window (days)',
      hint: 'How many days back no-shows are counted.',
      type: 'number',
      min: 1,
      step: 1,
    },
    no_show_auto_suspend_threshold: {
      label: 'No-show auto-suspend',
      hint: 'No-shows within the rolling window before a player is automatically suspended.',
      type: 'number',
      min: 1,
      step: 1,
    },
  },
  rating_defaults: {
    default_elo: {
      label: 'Starting Elo',
      hint: 'Assigned to all new players on approval.',
      type: 'number',
      min: 0,
      step: 1,
    },
    sweep_margin_multiplier: {
      label: 'Sweep bonus multiplier',
      hint: 'Extra rating movement when a multi-game match ends in a sweep (2-0). Applies to both players — the winner gains this much more, the loser drops this much more. 1.0 turns margin scaling off. Matches that go the distance are never scaled.',
      type: 'number',
      min: 1,
      max: 2,
      step: 0.05,
    },
    max_elo: {
      label: 'Maximum Elo',
      hint: 'Rating ceiling. At the cap a win gains nothing while the loser still drops in full, so ratings leak out of the ladder — keep this well clear of your strongest player.',
      type: 'number',
      min: 1,
      step: 50,
    },
    min_elo: {
      label: 'Minimum Elo',
      hint: 'Rating floor. Applied the same way as the ceiling, in reverse.',
      type: 'number',
      min: 0,
      step: 50,
    },
    provisional_threshold: {
      label: 'Provisional threshold',
      hint: 'Rated matches a player must complete before their rating counts as established.',
      type: 'number',
      min: 0,
      step: 1,
    },
    singles_k_provisional: {
      label: 'Singles K (provisional)',
      hint: "How fast a provisional player's singles rating moves after each match.",
      type: 'number',
      min: 1,
      step: 1,
    },
    singles_k_established: {
      label: 'Singles K (established)',
      hint: "How fast an established player's singles rating moves after each match.",
      type: 'number',
      min: 1,
      step: 1,
    },
    doubles_k_provisional: {
      label: 'Doubles K (provisional)',
      hint: "How fast a provisional player's doubles rating moves after each match.",
      type: 'number',
      min: 1,
      step: 1,
    },
    doubles_k_established: {
      label: 'Doubles K (established)',
      hint: "How fast an established player's doubles rating moves after each match.",
      type: 'number',
      min: 1,
      step: 1,
    },
  },
  tournament_bonuses: {
    enabled: {
      label: 'Bonuses enabled',
      hint: 'Award bonus Elo for tournament placements.',
      type: 'boolean',
    },
    singles_champion: {
      label: 'Singles champion',
      hint: 'Bonus Elo for winning a singles tournament.',
      type: 'number',
      min: 0,
      step: 1,
    },
    singles_finalist: {
      label: 'Singles finalist',
      hint: 'Bonus Elo for reaching a singles final.',
      type: 'number',
      min: 0,
      step: 1,
    },
    singles_semifinalist: {
      label: 'Singles semifinalist',
      hint: 'Bonus Elo for reaching a singles semifinal.',
      type: 'number',
      min: 0,
      step: 1,
    },
    singles_quarterfinalist: {
      label: 'Singles quarterfinalist',
      hint: 'Bonus Elo for reaching a singles quarterfinal.',
      type: 'number',
      min: 0,
      step: 1,
    },
    doubles_champion: {
      label: 'Doubles champion',
      hint: 'Bonus Elo for winning a doubles tournament.',
      type: 'number',
      min: 0,
      step: 1,
    },
    doubles_finalist: {
      label: 'Doubles finalist',
      hint: 'Bonus Elo for reaching a doubles final.',
      type: 'number',
      min: 0,
      step: 1,
    },
    doubles_semifinalist: {
      label: 'Doubles semifinalist',
      hint: 'Bonus Elo for reaching a doubles semifinal.',
      type: 'number',
      min: 0,
      step: 1,
    },
    doubles_quarterfinalist: {
      label: 'Doubles quarterfinalist',
      hint: 'Bonus Elo for reaching a doubles quarterfinal.',
      type: 'number',
      min: 0,
      step: 1,
    },
  },
  season_settings: {
    soft_compression_enabled: {
      label: 'Soft compression',
      hint: 'Pull every rating toward the average at season end.',
      type: 'boolean',
    },
    compression_factor: {
      label: 'Compression factor',
      hint: 'How strongly season-end ratings are pulled toward the average (0 to 1).',
      type: 'number',
      min: 0,
      max: 1,
      step: 0.01,
    },
  },
  inactivity_rules: {
    inactive_threshold_days: {
      label: 'Inactive threshold (days)',
      hint: 'Days without playing before a player is automatically marked inactive.',
      type: 'number',
      min: 1,
      step: 1,
    },
  },
  session_attendance: {
    checkin_opens_minutes_before: {
      label: 'Check-in opens (minutes before)',
      hint: 'Minutes before the session start that self check-in opens. Leave empty to let players check in any time.',
      type: 'number',
      min: 0,
      step: 1,
      nullable: true,
    },
    default_duration_minutes: {
      label: 'Default session duration (minutes)',
      hint: 'Used to decide when check-in closes for sessions without an end time.',
      type: 'number',
      min: 1,
      step: 1,
    },
  },
};

function isScalar(v: unknown): boolean {
  return v === null || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean';
}

/* Rectangular settings toggle — sharp corners, hairline track;
   ON = red knob on red-tinted track, OFF = gray knob on dark track. */
function SettingsToggle({
  checked,
  label,
  onChange,
}: {
  checked: boolean;
  label: string;
  onChange: (next: boolean) => void;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-6 w-11 items-center border transition-colors ${
        checked
          ? 'border-[var(--red-border)] bg-[var(--red-wash)]'
          : 'border-[var(--border)] bg-[var(--bg-primary)]'
      }`}
    >
      <span
        className={`inline-block h-4 w-4 transition-transform ${
          checked
            ? 'translate-x-[22px] bg-[var(--color-accent)]'
            : 'translate-x-1 bg-[var(--text-muted)]'
        }`}
      />
    </button>
  );
}

type FieldValue = string | boolean;

export function SettingsForm({ settings }: { settings: PlatformSetting[] }) {
  const [fieldEdits, setFieldEdits] = useState<Record<string, Record<string, FieldValue>>>({});
  const [jsonEdits, setJsonEdits] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  function handleFieldChange(key: string, field: string, next: FieldValue, original: FieldValue) {
    setFieldEdits((prev) => {
      const forKey = { ...(prev[key] ?? {}) };
      // Reverting to the saved value drops the edit so the Modified badge
      // and Save button clear without an explicit reset.
      if (next === original) {
        delete forKey[field];
      } else {
        forKey[field] = next;
      }
      const nextState = { ...prev };
      if (Object.keys(forKey).length === 0) delete nextState[key];
      else nextState[key] = forKey;
      return nextState;
    });
  }

  async function handleSave() {
    setLoading(true);
    try {
      const updates: { key: string; value: Record<string, unknown> }[] = [];

      for (const [key, fields] of Object.entries(fieldEdits)) {
        const setting = settings.find((s) => s.key === key);
        // Overlay edits on the saved blob so untouched fields survive and the
        // server action still receives the full JSONB value per key.
        const value: Record<string, unknown> = { ...(setting?.value ?? {}) };
        for (const [field, raw] of Object.entries(fields)) {
          const meta = FIELD_META[key]?.[field];
          if (!meta || meta.type === 'text') {
            value[field] = raw;
            continue;
          }
          if (meta.type === 'boolean') {
            value[field] = raw === true;
            continue;
          }
          const str = String(raw).trim();
          if (str === '') {
            if (meta.nullable) {
              value[field] = null;
              continue;
            }
            toast(`${meta.label} requires a value`, 'error');
            setLoading(false);
            return;
          }
          const num = Number(str);
          if (!Number.isFinite(num)) {
            toast(`${meta.label} must be a number`, 'error');
            setLoading(false);
            return;
          }
          value[field] = num;
        }
        updates.push({ key, value });
      }

      for (const [key, valueStr] of Object.entries(jsonEdits)) {
        try {
          const parsed = JSON.parse(valueStr);
          updates.push({ key, value: parsed });
        } catch {
          toast(`Invalid JSON for ${key}`, 'error');
          setLoading(false);
          return;
        }
      }

      if (updates.length === 0) {
        toast('No changes to save', 'info');
        setLoading(false);
        return;
      }

      await updatePlatformSettings(updates);
      toast('Settings saved', 'success');
      setFieldEdits({});
      setJsonEdits({});
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to save settings', 'error');
    }
    setLoading(false);
  }

  const hasChanges = Object.keys(fieldEdits).length > 0 || Object.keys(jsonEdits).length > 0;

  return (
    <div className="mt-10">
      <div className="flex items-center justify-between gap-4">
        <div>
          <h3 className="text-lg font-bold text-[var(--text-primary)]">Platform settings</h3>
          <p className="text-sm text-[var(--text-muted)]">
            Changing platform settings affects all players immediately. Changes are logged in the audit trail.
          </p>
        </div>
        {hasChanges && (
          <Button onClick={handleSave} loading={loading}>
            Save Changes
          </Button>
        )}
      </div>

      {settings.map((s) => {
        const keyMeta = FIELD_META[s.key];
        const structured =
          keyMeta && Object.entries(s.value).every(([field, v]) => keyMeta[field] && isScalar(v));

        if (!structured) {
          // Unknown key or non-scalar fields — raw JSON so nothing becomes uneditable.
          const currentValue = jsonEdits[s.key] ?? JSON.stringify(s.value, null, 2);
          const isEdited = s.key in jsonEdits;

          return (
            <div key={s.key} className="settings-row !items-start">
              <div className="md:w-[220px] flex-shrink-0">
                <div className="settings-row-label">
                  {SETTING_LABELS[s.key] || s.key}
                  {isEdited && (
                    <span className="ml-2 text-[var(--color-accent)]">Modified</span>
                  )}
                </div>
                <div className="settings-row-hint">{SETTING_DESCRIPTIONS[s.key] || ''}</div>
              </div>
              <div className="settings-row-control wide">
                <Textarea
                  value={currentValue}
                  onChange={(e) => setJsonEdits((prev) => ({ ...prev, [s.key]: e.target.value }))}
                  rows={Math.min(Object.keys(s.value).length + 2, 8)}
                  className="font-mono text-xs"
                />
              </div>
            </div>
          );
        }

        const fields = Object.keys(keyMeta).filter((field) => field in s.value);

        return (
          <div key={s.key} className="mt-8">
            <div className="settings-group-heading">{SETTING_LABELS[s.key] || s.key}</div>
            {fields.map((field) => {
              const fm = keyMeta[field];
              if (!fm) return null;
              const raw = s.value[field];
              const isEdited = field in (fieldEdits[s.key] ?? {});

              let control: React.ReactNode;
              if (fm.type === 'boolean') {
                const original = raw === true;
                const checked = (fieldEdits[s.key]?.[field] as boolean | undefined) ?? original;
                control = (
                  <SettingsToggle
                    checked={checked}
                    label={fm.label}
                    onChange={(next) => handleFieldChange(s.key, field, next, original)}
                  />
                );
              } else {
                const original = raw == null ? '' : String(raw);
                const current = (fieldEdits[s.key]?.[field] as string | undefined) ?? original;
                control = (
                  <input
                    type={fm.type === 'number' ? 'number' : 'text'}
                    value={current}
                    min={fm.min}
                    max={fm.max}
                    step={fm.step}
                    onChange={(e) => handleFieldChange(s.key, field, e.target.value, original)}
                    aria-label={fm.label}
                    className={`settings-input ${fm.type === 'number' ? 'w-28 font-mono' : 'w-56'}`}
                  />
                );
              }

              return (
                <div key={field} className="settings-row">
                  <div>
                    <div className="settings-row-label">
                      {fm.label}
                      {isEdited && (
                        <span className="ml-2 text-[var(--color-accent)]">Modified</span>
                      )}
                    </div>
                    <div className="settings-row-hint">{fm.hint}</div>
                  </div>
                  <div className="settings-row-control">{control}</div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}
