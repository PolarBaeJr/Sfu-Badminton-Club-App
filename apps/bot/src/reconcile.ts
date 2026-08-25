// The reconciliation sweep: the app's view of every linked member, pushed into
// every registered guild.
//
// Reconciliation is the AUTHORITY; event-driven sync is only the fast path. A
// role removed by hand in Discord, a member who lapsed while the bot was down,
// a 403 that has since been fixed by moving the bot's role up the list — all of
// them are repaired here and nowhere else.
//
// ---- WHY THIS IS NOT A setInterval ----
//
// The bot's compose service deliberately omits proxy.unscalable, so it can run
// more than one replica. A timer inside the process would therefore become N
// concurrent sweeps at N replicas, each fighting the others' role writes and
// multiplying the rate-limit pressure by N. Instead the sweep is DRIVEN FROM
// OUTSIDE over HTTP: one request goes through the proxy to exactly one replica,
// however many are running. See POST /sync in index.ts.

import type { DiscordApi } from './discord-api.js';
import { desiredRoles, type GuildRegistry, type MemberState } from './roles.js';
import { syncMemberEverywhere, describeOutcomes, type SyncOutcome } from './sync.js';

/** One row of the app's linked-member list. */
export interface LinkedMember {
  discordUserId: string;
  /** Null when the app can no longer resolve a player — strip everything. */
  state: MemberState | null;
}

export interface SweepSummary {
  members: number;
  added: number;
  removed: number;
  forbidden: number;
  failed: number;
  absent: number;
}

export async function reconcile(
  api: DiscordApi,
  registry: GuildRegistry,
  members: readonly LinkedMember[],
  log: (line: string) => void = console.log
): Promise<SweepSummary> {
  const summary: SweepSummary = {
    members: 0,
    added: 0,
    removed: 0,
    forbidden: 0,
    failed: 0,
    absent: 0,
  };

  if (registry.size === 0) {
    // Not an error. A bot with no guilds configured is inert by design, and
    // saying so beats a silent zero-length sweep that reads as success.
    log('[sync] no guilds registered — nothing to reconcile');
    return summary;
  }

  for (const member of members) {
    let outcomes: SyncOutcome[];
    try {
      outcomes = await syncMemberEverywhere(
        api,
        registry,
        member.discordUserId,
        member.state ? desiredRoles(member.state) : null
      );
    } catch (error) {
      // syncMemberEverywhere already swallows the predictable failures, so
      // reaching here means something genuinely unexpected. Still per-member:
      // one member must never end the sweep for everybody after them.
      summary.failed += 1;
      summary.members += 1;
      log(`[sync] ${member.discordUserId}: unexpected failure — ${String(error)}`);
      continue;
    }

    summary.members += 1;
    for (const o of outcomes) {
      summary.added += o.added;
      summary.removed += o.removed;
      summary.forbidden += o.forbidden;
      summary.failed += o.failed;
      summary.absent += o.absent ? 1 : 0;
    }

    // Only say something when something happened. A quiet sweep over a settled
    // roster should not print a line per member every few minutes.
    if (outcomes.some((o) => o.added || o.removed || o.failed)) {
      log(describeOutcomes(member.discordUserId, outcomes));
    }
  }

  log(
    `[sync] swept ${summary.members} members across ${registry.size} guild(s):` +
      ` +${summary.added} -${summary.removed}` +
      ` forbidden=${summary.forbidden} failed=${summary.failed}`
  );
  return summary;
}
