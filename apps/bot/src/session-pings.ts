import { fetchDuePings, recordPing, type DuePing } from './api.js';
import { loadConfig } from './config.js';
import { DiscordApi } from './discord-api.js';

// Pings the ping roles before a session starts.
//
// ORDER OF OPERATIONS IS THE WHOLE DESIGN: post first, record second.
//
// The session-reminder job in the app does it the other way round — it claims
// `reminded_at` and then sends — so anything that throws in between is a
// silent, permanent drop: the row says "reminded", nobody was, and there is no
// trace to find it by. Recording after a confirmed post inverts the risk. A
// crash between the post and the record means a duplicate ping on the next
// tick, which somebody notices and mentions. A missed ping is invisible.
//
// Driven by pg_cron over HTTP rather than a timer in here, for the same reason
// the reconciliation sweep is: the compose service omits proxy.unscalable, so a
// setInterval would become one cron PER REPLICA, all pinging the same channel.

export interface PingRunResult {
  posted: number;
  failed: number;
  skipped: number;
}

function describe(ping: DuePing): string {
  const when = `<t:${Math.floor(Date.parse(ping.startsAt) / 1000)}:R>`;
  const name = ping.name ?? 'Session';
  const where = ping.location ? ` at **${ping.location}**` : '';
  // Every role for this channel in ONE mention line. A club-wide night matches
  // both the competitive and the recreational ping role, and if they share a
  // channel the alternative is the identical announcement posted twice.
  const mentions = ping.roleIds.map((id) => `<@&${id}>`).join(' ');
  // Discord renders <t:...:R> in each reader's own timezone, which is worth
  // more than it looks: the club has members reading this from other time
  // zones during breaks, and a hardcoded "19:30" is wrong for all of them.
  return `${mentions} **${name}** starts ${when}${where}.`;
}

export async function runSessionPings(): Promise<PingRunResult> {
  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error('[bot] session pings: DISCORD_BOT_TOKEN is not set');
    return { posted: 0, failed: 0, skipped: 0 };
  }

  const { registry } = await loadConfig();
  const api = new DiscordApi({ token });
  const result: PingRunResult = { posted: 0, failed: 0, skipped: 0 };

  for (const guildId of Object.keys(registry)) {
    let pings: DuePing[];
    try {
      ({ pings } = await fetchDuePings(guildId));
    } catch (error) {
      // One guild's failure must not abort the others.
      console.error(`[bot] session pings: could not read due pings for ${guildId}:`, error);
      result.failed += 1;
      continue;
    }

    for (const ping of pings) {
      let posted = false;
      try {
        posted = await api.createMessage(ping.channelId, {
          content: describe(ping),
          // The role mention only actually pings if it is allowed here.
          // Without this Discord renders <@&id> as plain text and the whole
          // feature silently does nothing visible — the message arrives, looks
          // right, and notifies nobody.
          allowed_mentions: { roles: ping.roleIds },
        });
      } catch (error) {
        console.error(`[bot] session ping post threw for ${ping.sessionId}:`, error);
      }

      if (!posted) {
        // NOT recorded, deliberately: an unposted ping stays due and is retried
        // on the next tick, until it falls outside the lateness window and the
        // app stops offering it.
        result.failed += 1;
        continue;
      }

      try {
        await recordPing(ping.sessionId, ping.roleIds);
        result.posted += 1;
      } catch (error) {
        // Posted but not recorded. The ping went out, so this is a duplicate
        // risk rather than a miss — loud, because it will repeat next tick.
        console.error(
          `[bot] session ping POSTED but not recorded (${ping.sessionId}/` +
            `${ping.roleIds.join(',')}) — it may be sent again on the next run:`,
          error
        );
        result.posted += 1;
      }
    }
  }

  return result;
}
