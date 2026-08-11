'use client';

import { useState } from 'react';
import { Button, Input, Textarea } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import { updatePlatformSettings } from '@/lib/actions';
// IMPORTED, NOT REDECLARED. /ratings and /seasons each copied this number into
// their own file and the console now has three literal 5s that have to be kept
// in step by hand; this is the shared one, and it is a plain module with no
// 'use server' so a client component may read it.
import { REASON_MIN } from '@/lib/audit-reason';
// Labels, descriptions and field metadata moved to lib/ so that /ratings, which
// draws the same JSONB rows in its own layout, cannot describe a field
// differently from the way this form describes it.
import {
  FIELD_META,
  SETTING_DESCRIPTIONS,
  SETTING_LABELS,
  type PlatformSetting,
} from '@/lib/platform-setting-fields';

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

// Renders whichever platform_settings rows it is handed — the caller decides
// which section owns which key (see lib/platform-setting-sections.ts). It knows
// the labels and field metadata for all of them, so the same component serves
// both Ratings and Accounts.
export function PlatformSettingsForm({ settings }: { settings: PlatformSetting[] }) {
  const [fieldEdits, setFieldEdits] = useState<Record<string, Record<string, FieldValue>>>({});
  const [jsonEdits, setJsonEdits] = useState<Record<string, string>>({});
  const [reason, setReason] = useState('');
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  /**
   * Mirrors the floor updatePlatformSettings enforces. The server is the
   * boundary; this only decides when Save stops being disabled, so a reason
   * nobody wrote is never even submittable.
   */
  const enoughReason = reason.trim().length >= REASON_MIN;

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

      await updatePlatformSettings(updates, reason);
      toast('Settings saved', 'success');
      setFieldEdits({});
      setJsonEdits({});
      setReason('');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to save settings', 'error');
    }
    setLoading(false);
  }

  const hasChanges = Object.keys(fieldEdits).length > 0 || Object.keys(jsonEdits).length > 0;

  return (
    <div>
      {/* The page title now lives in its PageHeader; this row is just the
          standing warning and the Save button, which needs the form's state. */}
      <div className="flex min-h-[38px] flex-wrap items-center justify-between gap-4">
        <p className="settings-section-desc !mb-0">
          Changes apply to every player immediately and are recorded in the audit log.
        </p>
        {/* THE REASON BOX APPEARS WITH THE SAVE BUTTON, not before it. There is
            nothing to explain until something has been changed, and a box
            standing on an untouched page reads as a field somebody forgot to
            fill in. Save stays disabled until it holds real text — the same
            rule /ratings' save bar follows, and the same rule the server
            enforces for anyone who gets past this. */}
        {hasChanges && (
          <div className="flex w-full flex-wrap items-center gap-3 sm:w-auto">
            <div className="w-full min-w-0 sm:w-[320px]">
              <Input
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                aria-label="Reason (required)"
                placeholder="Reason (required) — logged with your name."
              />
            </div>
            <Button onClick={handleSave} loading={loading} disabled={!enoughReason}>
              Save Changes
            </Button>
          </div>
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
