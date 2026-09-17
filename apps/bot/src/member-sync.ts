import { clearRevocations, fetchLinkedMembers } from './api.js';
import { loadConfig } from './config.js';
import { DiscordApi } from './discord-api.js';
import { reconcile, type SweepSummary } from './reconcile.js';

/**
 * What a sync leaves the caller holding. The api handle and the audit channel
 * come back rather than staying private because every caller writes its own
 * entry, and rebuilding a DiscordApi and re-reading the config to do that would
 * be two copies of work this function has already done.
 */
export interface MemberSyncResult {
  summary: SweepSummary;
  api: DiscordApi;
  auditChannelId: string | undefined;
}

/**
 * Apply the app's current view of these accounts to Discord, right now.
 *
 * TWO CALLERS, ONE BODY: the /sync-member endpoint (which is what makes the web
 * link flow instant) and /forcelink, which runs inside this same process and so
 * calls this directly rather than making an HTTP request to the bot's own port.
 *
 * IT DELIBERATELY WRITES NO AUDIT ENTRY. Each caller posts its own, because the
 * two acts are not the same act: the endpoint files whatever `reason` its caller
 * asked for, and /forcelink needs an entry worded for a grant that sits beside a
 * separate entry for the strip. Rolling both into one here would force a shared
 * wording that is wrong for both.
 *
 * IT MUST NOT IMPORT index.ts OR commands.ts. index.ts already imports
 * commands.ts, so either direction would close a cycle; the four modules it does
 * import are ones commands.ts already depends on safely.
 */
export async function syncMembersNow(ids: readonly string[]): Promise<MemberSyncResult> {
  const { registry, auditChannelId } = await loadConfig();
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) throw new Error('DISCORD_BOT_TOKEN is not set');

  // The whole roster, then filtered. Wasteful by one request and correct by
  // construction: the app remains the only thing that decides what a member
  // is, and an id that is NOT in the list is a tombstone the app wants
  // stripped, which this handles for free, because reconcile already reads
  // a missing state as "strip everything".
  const roster = await fetchLinkedMembers();
  const members = ids.map(
    (id) => roster.find((m) => m.discordUserId === id) ?? { discordUserId: id, state: null }
  );

  const api = new DiscordApi({ token });
  const summary = await reconcile(api, registry, members);
  try {
    await clearRevocations(summary.cleared);
  } catch (error) {
    console.error('[bot] could not clear revocations:', error);
  }

  return { summary, api, auditChannelId };
}
