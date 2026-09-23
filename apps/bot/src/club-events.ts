import { clearClubEvent, fetchClubEventActions, recordClubEvent } from './api.js';
import { runScheduledEventSync, type ScheduledEventRunResult } from './scheduled-event-sync.js';

// Keeps the server's Events tab in step with the club's published events
// (00244, 00245). Same loop as tournaments, see scheduled-event-sync.ts; this
// file only translates club event ids.

export function runClubEvents(): Promise<ScheduledEventRunResult> {
  return runScheduledEventSync({
    label: 'club events',
    async fetchActions(guildId) {
      const { actions, skipped } = await fetchClubEventActions(guildId);
      return {
        actions: actions.map(({ eventId, ...rest }) => ({ ...rest, sourceId: eventId })),
        skipped: skipped.map((s) => ({ sourceId: s.eventId, reason: s.reason })),
      };
    },
    record(guildId, discordEventId, action) {
      // The app's location and description, not what Discord was sent: the
      // app compares against these, so recording the fallback location would
      // read as a change on every tick.
      return recordClubEvent({
        eventId: action.sourceId,
        guildId,
        discordEventId,
        name: action.name,
        syncedStartsAt: action.syncedStartsAt,
        syncedEndsAt: action.syncedEndsAt,
        location: action.location,
        description: action.description,
      });
    },
    clear(guildId, sourceId) {
      return clearClubEvent(sourceId, guildId);
    },
  });
}
