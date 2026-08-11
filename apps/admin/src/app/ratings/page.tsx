export const dynamic = 'force-dynamic';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { accessLevelFor, permissionsOf, permits, type Capability } from '@/lib/permissions';
import { PageHeader } from '@badminton/ui';
import { settingsForSection } from '@/lib/platform-setting-sections';
import { FIELD_META, type PlatformSetting } from '@/lib/platform-setting-fields';
import { RatingsForm } from './ratings-form';
import {
  RatingsAside,
  type LadderShape,
  type LastChange,
  type LastRewrite,
} from './ratings-aside';

// Split out of /settings, which is trainer-level so everyone can enrol their own
// passkeys. Platform configuration had no business living behind that gate.
//
// ratings.page is in no baseline, unlike legal.page: the club owner asked for
// these to be "separate from exec so they cant edit it", and unlike the legal
// documents there is nothing here an exec has a reason to read — so there is no
// read-only view. The route map only decides who may OPEN the section; this call
// is the page's own re-check, and updatePlatformSettings' platform.settings.write
// is the boundary that actually protects the data.
//
// THE FORM IS ITS OWN AREA. `platform` has no route of its own — the settings it
// holds are drawn here and on /accounts — so platform.page is what gates the
// form, and the query behind it, on both pages. Opening Ratings and editing the
// platform's rating rules are two permissions, and today's answer is unchanged
// because only an admin holds either.
//
// EVERY QUERY ON THIS PAGE IS ASKED ITS OWN QUESTION FIRST, and the answer is
// computed BEFORE the query runs — never a fetch that always runs feeding a
// render that is conditional. That shape is a leak: the row leaves the database
// and lands in the RSC payload whether or not anything draws it. The four reads
// here and the capability each one answers to:
//
//   platform_settings                      platform.page
//   ratings (counts for the ladder card)   players.read
//   season_final_ratings (last rewrite)    seasons.page
//   audit_logs (who changed it, and why)   audit.page
//
// None of these is a new capability. Adding one would move an answer in
// capability-equivalence.test.ts, and none of these doors needs a new key —
// they are all doors this console already has.
export default async function RatingsPage() {
  const viewer = await requireCapability('ratings.page');
  const level = accessLevelFor(viewer);
  const permissions = permissionsOf(viewer);
  const can = (capability: Capability) => permits(level, permissions, capability);

  const canReadSettings = can('platform.page');
  const canWriteSettings = can('platform.settings.write');
  const canReadRoster = can('players.read');
  const canReadSeasons = can('seasons.page');
  const canReadAudit = can('audit.page');

  const db = createAdminClient();

  const { data: allSettings } = canReadSettings
    ? await db.from('platform_settings').select('*').order('key')
    : { data: null };
  const settings = settingsForSection((allSettings ?? []) as PlatformSetting[], 'ratings');

  const ladder = await loadLadder(db, canReadRoster);
  const lastRewrite = await loadLastRewrite(db, canReadSeasons);
  const lastChange = await loadLastChange(db, settings, {
    canReadAudit,
    canReadRoster,
  });

  return (
    <div>
      <PageHeader
        eyebrow="Elo engine"
        title="Ratings"
        sub="How every number on the ladder is calculated."
        watermark="R"
      />

      {canReadSettings ? (
        <RatingsForm
          settings={settings}
          canWrite={canWriteSettings}
          aside={
            <RatingsAside ladder={ladder} lastRewrite={lastRewrite} lastChange={lastChange} />
          }
        />
      ) : (
        // Withheld, not empty. A blank page reads as broken.
        <p className="border border-[var(--line)] bg-[var(--surface)] px-4 py-3 text-[13px] text-[var(--mute)]">
          The rating settings are not shown to you.
        </p>
      )}
    </div>
  );
}

type Db = ReturnType<typeof createAdminClient>;

/**
 * How many members these settings will apply to, and how many of them the
 * placement-match threshold still counts as provisional. Three head counts —
 * no rows leave the database.
 */
async function loadLadder(db: Db, allowed: boolean): Promise<LadderShape> {
  if (!allowed) return { state: 'withheld' };

  const [total, singles, doubles] = await Promise.all([
    db.from('ratings').select('id', { count: 'exact', head: true }),
    db.from('ratings').select('id', { count: 'exact', head: true }).eq('singles_provisional', true),
    db.from('ratings').select('id', { count: 'exact', head: true }).eq('doubles_provisional', true),
  ]);

  return {
    state: 'ok',
    total: total.count ?? 0,
    singlesProvisional: singles.count ?? 0,
    doublesProvisional: doubles.count ?? 0,
  };
}

/**
 * The last time every rating on the ladder was rewritten at once. That only
 * happens in activate_season, which snapshots the outgoing season into
 * season_final_ratings before applying its Elo policy — so the newest
 * archived_at IS the date of the last wholesale rewrite.
 */
async function loadLastRewrite(db: Db, allowed: boolean): Promise<LastRewrite> {
  if (!allowed) return { state: 'withheld' };

  const { data } = await db
    .from('season_final_ratings')
    .select('archived_at, seasons(name)')
    .order('archived_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) return { state: 'none' };

  const season = data.seasons as { name?: string } | { name?: string }[] | null;
  const name = Array.isArray(season) ? (season[0]?.name ?? null) : (season?.name ?? null);
  return { state: 'ok', at: data.archived_at as string, season: name };
}

/** audit_logs.reason for a platform setting is "<key> — <text>" (settings.ts). */
function splitAuditReason(reason: string | null): { key: string; text: string | null } | null {
  if (!reason) return null;
  const at = reason.indexOf(' — ');
  if (at === -1) return null;
  const key = reason.slice(0, at);
  const text = reason.slice(at + 3).trim();
  // The auto-generated text is not a reason anybody typed, so it is not quoted
  // back as one.
  return { key, text: text === 'platform setting updated' ? null : text || null };
}

function describe(value: unknown): string {
  if (value === null || value === undefined) return '—';
  if (typeof value === 'boolean') return value ? 'on' : 'off';
  return String(value);
}

/**
 * Who last moved a rating setting, when, what moved, and the reason they typed.
 *
 * The audit row is the record of the change — it carries the actor, the time,
 * the old and new blobs and the typed reason, so the whole card comes from
 * there when the viewer may read the audit log. Without audit.page it falls
 * back to platform_settings.updated_by/updated_at, which is the same fact
 * minus the words, and the card says so rather than showing a gap.
 */
async function loadLastChange(
  db: Db,
  settings: PlatformSetting[],
  access: { canReadAudit: boolean; canReadRoster: boolean }
): Promise<LastChange> {
  if (settings.length === 0) return { state: 'withheld' };

  const ratingKeys = new Set(settings.map((s) => s.key));

  let at: string | null = null;
  let settingKey: string | null = null;
  let actorId: string | null = null;
  let reason: string | null = null;
  let diff: { label: string; from: string; to: string }[] = [];

  if (access.canReadAudit) {
    // A handful of the most recent settings changes, filtered here rather than
    // in the query: the key is embedded in `reason` (target_id is a uuid column
    // and a platform setting has no uuid), and matching a prefix through
    // PostgREST's or/like syntax is more ways to be subtly wrong than it is
    // worth for ten rows.
    const { data } = await db
      .from('audit_logs')
      .select('actor_id, created_at, old_value, new_value, reason')
      .eq('action_type', 'platform_setting_updated')
      .order('created_at', { ascending: false })
      .limit(20);

    const row = (data ?? []).find((r) => {
      const parsed = splitAuditReason(r.reason as string | null);
      return parsed !== null && ratingKeys.has(parsed.key);
    });

    if (row) {
      const parsed = splitAuditReason(row.reason as string | null)!;
      at = row.created_at as string;
      settingKey = parsed.key;
      actorId = row.actor_id as string | null;
      reason = parsed.text;
      diff = diffOf(parsed.key, row.old_value, row.new_value);
    }
  }

  if (at === null) {
    // Newest write wins. updated_at is stamped by updatePlatformSettings on
    // every save, so this is the same event the audit row describes.
    const newest = [...settings].sort((a, b) => b.updated_at.localeCompare(a.updated_at))[0];
    if (!newest) return { state: 'none' };
    at = newest.updated_at;
    settingKey = newest.key;
    actorId = newest.updated_by;
  }

  let who: { id: string; name: string; avatar: string | null } | null = null;
  if (access.canReadRoster && actorId) {
    const { data } = await db
      .from('players')
      .select('id, full_name, avatar_url')
      .eq('id', actorId)
      .maybeSingle();
    if (data) {
      who = {
        id: data.id as string,
        name: data.full_name as string,
        avatar: (data.avatar_url as string | null) ?? null,
      };
    }
  }

  return {
    state: 'ok',
    settingKey: settingKey!,
    at,
    who,
    // An actor who no longer exists is a different fact from one this viewer
    // may not be told about, and the card words them differently.
    whoWithheld: !access.canReadRoster && actorId !== null,
    reason,
    reasonWithheld: !access.canReadAudit,
    diff,
  };
}

/** Which fields actually moved, read off the audit row's two blobs. */
function diffOf(key: string, oldValue: unknown, newValue: unknown) {
  const before = (oldValue ?? {}) as Record<string, unknown>;
  const after = (newValue ?? {}) as Record<string, unknown>;
  if (typeof before !== 'object' || typeof after !== 'object') return [];

  return Object.keys(after)
    .filter((field) => describe(before[field]) !== describe(after[field]))
    .map((field) => ({
      label: FIELD_META[key]?.[field]?.label ?? field,
      from: describe(before[field]),
      to: describe(after[field]),
    }))
    .slice(0, 4);
}
