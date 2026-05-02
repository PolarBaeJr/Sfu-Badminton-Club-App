export const dynamic = 'force-dynamic';
import { createAdminClient, getAuthenticatedAdmin } from '@/lib/supabase-server';
import { PageHero } from '@badminton/ui';
import { SettingsTabs } from './settings-tabs';

type Setting = {
  key: string;
  value: Record<string, unknown>;
};

export default async function SettingsPage() {
  let adminUser: Awaited<ReturnType<typeof getAuthenticatedAdmin>> | null = null;
  try {
    adminUser = await getAuthenticatedAdmin();
  } catch {
    /* unauthenticated handled by middleware */
  }
  const supabase = createAdminClient();

  const { data: rawSettings } = await supabase.from('platform_settings').select('key, value');

  const settings = (rawSettings ?? []) as Setting[];
  const byKey: Record<string, Record<string, unknown>> = {};
  for (const s of settings) byKey[s.key] = s.value ?? {};

  const ratingDefaults = byKey.rating_defaults ?? {};
  const challengeRules = byKey.challenge_rules ?? {};
  const seasonSettings = byKey.season_settings ?? {};

  const { data: admins } = await supabase
    .from('players')
    .select('id, full_name, email, role, created_at')
    .in('role', ['admin', 'super_admin', 'moderator'])
    .order('created_at', { ascending: true })
    .limit(20);

  return (
    <div>
      <PageHero
        eyebrow="Configuration"
        title="Settings."
        subtitle="Club-wide configuration. Changes take effect immediately and are written to the audit log."
        watermark="S"
      />
      <SettingsTabs
        currentAdminEmail={adminUser?.email ?? ''}
        admins={(admins ?? []).map((a) => ({
          id: a.id as string,
          full_name: a.full_name as string,
          email: a.email as string,
          role: a.role as string,
          created_at: a.created_at as string,
        }))}
        defaults={{
          startingElo: pickNumber(ratingDefaults.starting_elo, 1200),
          kSingles: pickNumber(ratingDefaults.k_factor_singles, 32),
          kDoubles: pickNumber(ratingDefaults.k_factor_doubles, 24),
          eloFloor: pickNumber(ratingDefaults.elo_floor, 900),
          provisional: pickNumber(ratingDefaults.provisional_threshold, 10),
          submissionWindow: pickNumber(challengeRules.submission_window_hours, 48),
          disputeWindow: pickNumber(challengeRules.dispute_window_hours, 24),
          noShowPenalty: pickNumber(challengeRules.no_show_penalty, -15),
          softReset: pickBool(seasonSettings.soft_reset_enabled, true),
        }}
      />
    </div>
  );
}

function pickNumber(v: unknown, fallback: number): number {
  if (typeof v === 'number') return v;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function pickBool(v: unknown, fallback: boolean): boolean {
  if (typeof v === 'boolean') return v;
  return fallback;
}
