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
  type LastActivation,
  type LastChange,
} from './ratings-aside';
import { PROVISIONAL_THRESHOLD, DEFAULT_ELO, resolveEloBounds } from '@badminton/shared/src/utils/constants';
import { getKFactor, type RatingSettings } from '@badminton/shared/src/elo/engine';
import type { KFactors } from './k-factor-panel';

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
//   platform_settings                        platform.page
//   ratings (counts for the ladder card)     players.read
//   season_final_ratings (last activation)   seasons.page
//   audit_logs (who changed it, and why)     audit.page
//   players (the officer's name and photo)   players.read
//
// None of these is a new capability. Adding one would move an answer in
// capability-equivalence.test.ts, and none of these doors needs a new key —
// they are all doors this console already has.
export default async function RatingsPage() {
  const viewer = await requireCapability('ratings.page');
  const level = accessLevelFor(viewer);
  const permissions = permissionsOf(accessLevelFor(viewer), viewer);
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

  // Every read below feeds the right-hand column, which is only drawn for a
  // platform.page holder — so the reads do not happen without it either. A
  // query that runs for output nobody renders still ships its rows into the RSC
  // payload; that is the leak, not the render.
  const ladder = await loadLadder(db, canReadSettings && canReadRoster, thresholdOf(settings));
  const lastActivation = await loadLastActivation(db, canReadSettings && canReadSeasons);
  const lastChange = await loadLastChange(db, settings, {
    canReadAudit: canReadSettings && canReadAudit,
    canReadRoster: canReadSettings && canReadRoster,
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
            <RatingsAside
              ladder={ladder}
              lastActivation={lastActivation}
              lastChange={lastChange}
              kFactors={kFactorsOf(settings)}
              impact={impactOf(settings)}
            />
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
 * The four K-factors as this club has them configured right now.
 *
 * RESOLVED THROUGH getKFactor RATHER THAN READ OFF THE ROW, so the fallback for
 * an unset or non-positive value has one implementation instead of two that can
 * drift — the engine already treats a K of 0 as unset because a zero K would
 * freeze every rating. Reading `value.singles_k_established` directly and
 * defaulting to 48 here would put a number on screen that the engine would not
 * actually use.
 *
 * `matchesPlayed` is left undefined on purpose: this asks what the provisional
 * and established K-factors ARE, not which one a particular member is on. The
 * head counts beside them answer that, and they are counted with the same
 * threshold-or-flag rule the engine branches on (see loadLadder).
 *
 * No fetch. `settings` is the rating section of the platform_settings read the
 * form above already made, under `platform.page`.
 */
function kFactorsOf(settings: PlatformSetting[]): KFactors {
  const defaults = (settings.find((s) => s.key === 'rating_defaults')?.value ??
    null) as RatingSettings | null;
  return {
    singlesProvisional: getKFactor('singles', true, undefined, defaults),
    singlesEstablished: getKFactor('singles', false, undefined, defaults),
    doublesProvisional: getKFactor('doubles', true, undefined, defaults),
    doublesEstablished: getKFactor('doubles', false, undefined, defaults),
  };
}

/**
 * The rest of what the impact table needs: the rating both scenarios start
 * from, the clamp, and whether provisional K is switched on at all (00127).
 *
 * SAME ROW, NO EXTRA FETCH — `settings` is the rating section of the
 * platform_settings read the form already made, exactly like kFactorsOf above.
 *
 * The bounds go through resolveEloBounds so the table clamps deltas the way a
 * real match would, including its refusal to honour an inverted min/max pair.
 * The baseline falls back to DEFAULT_ELO rather than to a literal, so a club
 * that has moved default_elo sees its own numbers.
 *
 * `provisional_k_enabled` is read with `!== false`, matching getKFactor(): only
 * an explicit false counts as off, so a missing key (every database before
 * 00127 runs) reads as today's behaviour rather than silently reporting the
 * provisional K-factors as unused.
 */
function impactOf(settings: PlatformSetting[]) {
  const defaults = (settings.find((s) => s.key === 'rating_defaults')?.value ??
    null) as RatingSettings | null;
  const baseline = Number((defaults as Record<string, unknown> | null)?.default_elo);
  return {
    baseline: Number.isFinite(baseline) && baseline > 0 ? Math.round(baseline) : DEFAULT_ELO,
    bounds: resolveEloBounds(defaults ? { min: defaults.min_elo, max: defaults.max_elo } : null),
    provisionalKEnabled: defaults?.provisional_k_enabled !== false,
  };
}

/** The placement-match count as it is configured right now. */
function thresholdOf(settings: PlatformSetting[]): number {
  const raw = settings.find((s) => s.key === 'rating_defaults')?.value?.provisional_threshold;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : PROVISIONAL_THRESHOLD;
}

/**
 * How many members these settings apply to, and how many of them still move on
 * the provisional K-factors. Three head counts — no rows leave the database.
 *
 * The condition is the STORED FLAG OR the match count, because that is what
 * decides the K-factor on both sides of the engine:
 * apply_match_result (00041) branches on
 * `singles_provisional OR singles_matches_played < v_threshold`, and
 * getKFactor() in the TS engine says the same thing. Counting the flag alone
 * would print a figure that does not move when the field above it does — the
 * threshold clears the flag only on the match that crosses it, so raising the
 * threshold makes established players provisional again through the second
 * clause and through nothing else.
 */
async function loadLadder(db: Db, allowed: boolean, threshold: number): Promise<LadderShape> {
  if (!allowed) return { state: 'withheld' };

  const provisional = (discipline: 'singles' | 'doubles') =>
    db
      .from('ratings')
      .select('id', { count: 'exact', head: true })
      .or(`${discipline}_provisional.eq.true,${discipline}_matches_played.lt.${threshold}`);

  const [total, singles, doubles] = await Promise.all([
    db.from('ratings').select('id', { count: 'exact', head: true }),
    provisional('singles'),
    provisional('doubles'),
  ]);

  return {
    state: 'ok',
    total: total.count ?? 0,
    singlesProvisional: singles.count ?? 0,
    doublesProvisional: doubles.count ?? 0,
  };
}

/**
 * When a season was last activated.
 *
 * activate_season snapshots the outgoing season into season_final_ratings
 * BEFORE it looks at the Elo policy, and its default policy ('carry') then
 * rewrites nothing at all. So this date proves an activation, not a rewrite,
 * and the card is labelled accordingly. Claiming "ladder last rewritten" off
 * this column would be false for every carry-over season the club has ever
 * run.
 */
async function loadLastActivation(db: Db, allowed: boolean): Promise<LastActivation> {
  if (!allowed) return { state: 'withheld' };

  const { data } = await db
    .from('season_final_ratings')
    .select('archived_at')
    .order('archived_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!data) return { state: 'none' };
  return { state: 'ok', at: data.archived_at as string };
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
  // Empty, not withheld: the aside is only rendered for a platform.page
  // holder, so reaching here with no rows means the table is empty.
  if (settings.length === 0) return { state: 'none' };

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
