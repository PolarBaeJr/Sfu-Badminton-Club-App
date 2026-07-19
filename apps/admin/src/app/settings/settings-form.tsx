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
};

export function SettingsForm({ settings }: { settings: PlatformSetting[] }) {
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  function handleChange(key: string, valueStr: string) {
    setEdits((prev) => ({ ...prev, [key]: valueStr }));
  }

  async function handleSave() {
    setLoading(true);
    try {
      const updates: { key: string; value: Record<string, unknown> }[] = [];
      for (const [key, valueStr] of Object.entries(edits)) {
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
      setEdits({});
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to save settings', 'error');
    }
    setLoading(false);
  }

  const hasChanges = Object.keys(edits).length > 0;

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
        const currentValue = edits[s.key] ?? JSON.stringify(s.value, null, 2);
        const isEdited = s.key in edits;

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
                onChange={(e) => handleChange(s.key, e.target.value)}
                rows={Math.min(Object.keys(s.value).length + 2, 8)}
                className="font-mono text-xs"
              />
            </div>
          </div>
        );
      })}
    </div>
  );
}
