import {
  clearTournamentEvent,
  fetchTournamentActions,
  recordTournamentEvent,
  type TournamentEventAction,
} from './api.js';
import { loadConfig } from './config.js';
import { DiscordApi } from './discord-api.js';

// Keeps the server's Events tab in step with the club's tournaments.
//
// ORDER OF OPERATIONS, same as the session pings and for the same reason: call
// Discord first, record second. A crash in between means a duplicate on the
// next tick, which somebody sees and mentions. Recording first would mean a
// tournament that says "announced" and never was, with nothing to find it by.
//
// The one asymmetry is the CANCEL path, where the ordering argument inverts:
// deleting the mapping before Discord would strand a live event with no row
// pointing at it, and nothing would ever clean it up.
//
// Driven by pg_cron over HTTP rather than a timer, because the compose service
// omits proxy.unscalable — a setInterval in here would become one scheduler PER
// REPLICA, all racing to create the same event.

export interface TournamentRunResult {
  created: number;
  updated: number;
  cancelled: number;
  failed: number;
  skipped: number;
}

// What Discord shows when the club has not set a location. Not an empty string:
// entity_metadata.location is REQUIRED for an EXTERNAL event and Discord
// rejects the whole call without it, so the fallback has to be something.
const FALLBACK_LOCATION = 'SFU Badminton Club';

export async function runTournamentEvents(): Promise<TournamentRunResult> {
  const result: TournamentRunResult = {
    created: 0,
    updated: 0,
    cancelled: 0,
    failed: 0,
    skipped: 0,
  };

  const token = process.env.DISCORD_BOT_TOKEN;
  if (!token) {
    console.error('[bot] tournament events: DISCORD_BOT_TOKEN is not set');
    return result;
  }

  const { registry } = await loadConfig();
  const api = new DiscordApi({ token });

  for (const guildId of Object.keys(registry)) {
    let actions: TournamentEventAction[];
    let skipped: { tournamentId: string; reason: string }[];
    try {
      ({ actions, skipped } = await fetchTournamentActions(guildId));
    } catch (error) {
      // One guild's failure must not abort the others.
      console.error(`[bot] tournament events: could not read actions for ${guildId}:`, error);
      result.failed += 1;
      continue;
    }

    for (const s of skipped) {
      // Logged rather than counted silently. A run that announces nothing
      // should be able to say why, or the first question when the Events tab
      // stays empty is unanswerable.
      console.log(`[bot] tournament events: skipping ${s.tournamentId} (${s.reason})`);
    }
    result.skipped += skipped.length;

    if (actions.length === 0) continue;

    // PREFLIGHT, ONCE PER GUILD RATHER THAN PER ACTION.
    //
    // The bot is invited with Manage Roles and nothing else on any server set
    // up before this feature existed, and without MANAGE_EVENTS every call
    // below answers 403 — a status that names no permission. Checking here
    // turns a silent empty Events tab into one log line with the fix in it, and
    // costs nothing on a run with no work to do, which is most of them.
    //
    // Only the check is skipped on failure, never the work: if the check itself
    // errors the actions are still attempted, because a broken preflight
    // refusing to let the real calls run would be worse than the 403 it exists
    // to explain.
    try {
      if (!(await api.hasManageEvents(guildId))) {
        console.error(
          `[bot] tournament events: missing MANAGE_EVENTS in guild ${guildId} — ` +
            'grant it under Server Settings -> Roles -> (the bot) -> Manage Events, ' +
            'or re-invite the bot with that permission. Nothing will be announced until then.'
        );
        result.failed += actions.length;
        continue;
      }
    } catch (error) {
      console.error(
        `[bot] tournament events: could not check permissions in ${guildId}, trying anyway:`,
        error
      );
    }

    for (const action of actions) {
      const location = action.location?.trim() || FALLBACK_LOCATION;

      if (action.kind === 'cancel') {
        if (!action.discordEventId) {
          result.failed += 1;
          continue;
        }
        // DELETE FIRST. A 404 counts as done — somebody removing it by hand has
        // already achieved what this call was for.
        const gone = await api.deleteScheduledEvent(guildId, action.discordEventId);
        if (!gone) {
          console.error(
            `[bot] tournament events: could not cancel ${action.discordEventId} ` +
              `for ${action.tournamentId}`
          );
          result.failed += 1;
          continue;
        }
        try {
          await clearTournamentEvent(action.tournamentId, guildId);
          result.cancelled += 1;
        } catch (error) {
          // The event is gone but the row remains, so the next tick tries the
          // delete again and gets a 404, which it treats as success. Self
          // healing — but loud, because a row that never clears means the read
          // is failing for a reason worth knowing.
          console.error(
            `[bot] tournament events: CANCELLED but not cleared (${action.tournamentId}):`,
            error
          );
          result.cancelled += 1;
        }
        continue;
      }

      const payload = {
        name: action.name,
        description: action.description,
        startsAt: action.startsAt,
        endsAt: action.endsAt,
        location,
      };

      let discordEventId: string | null = null;

      if (action.kind === 'create') {
        discordEventId = await api.createScheduledEvent(guildId, payload);
        if (!discordEventId) {
          // NOT recorded: an uncreated event stays due and is retried next
          // tick, which is what makes a bot restart a delay rather than a loss.
          result.failed += 1;
          continue;
        }
      } else {
        if (!action.discordEventId) {
          result.failed += 1;
          continue;
        }
        const ok = await api.modifyScheduledEvent(guildId, action.discordEventId, payload);
        if (!ok) {
          result.failed += 1;
          continue;
        }
        discordEventId = action.discordEventId;
      }

      try {
        // RECORDS THE TOURNAMENT'S OWN TIMES, not the ones just sent. The two
        // differ whenever a start already gone was clamped forward, and storing
        // the clamped value would make every subsequent tick see a difference
        // and PATCH the same event forever.
        await recordTournamentEvent({
          tournamentId: action.tournamentId,
          guildId,
          discordEventId,
          name: action.name,
          syncedStartsAt: action.syncedStartsAt,
          syncedEndsAt: action.syncedEndsAt,
        });
      } catch (error) {
        // For a create this is the bad one: the event exists in Discord with no
        // row pointing at it, so the next tick creates a SECOND one that the
        // whole server can see. Loud, and named as such.
        console.error(
          `[bot] tournament event ${action.kind}d but NOT recorded ` +
            `(${action.tournamentId}/${discordEventId}) — a duplicate may appear ` +
            'on the next run:',
          error
        );
      }

      if (action.kind === 'create') result.created += 1;
      else result.updated += 1;
    }
  }

  return result;
}
