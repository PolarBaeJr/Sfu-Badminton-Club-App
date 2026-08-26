import { describe, it, expect, vi } from 'vitest';
import { DiscordApi } from '../discord-api.js';

// The one thing about a scheduled-event PATCH that is not obvious from the call
// site: Discord will not retime an event it has already started, and a caller
// that keeps sending the schedule anyway gets the same refusal on every tick
// for the length of the tournament. The app decides when the times are frozen;
// this file proves the decision survives the trip to Discord's REST API.

function apiWith(fetchImpl: typeof fetch) {
  return new DiscordApi({ token: 't', fetchImpl, sleep: async () => {} });
}

function ok() {
  return Promise.resolve(new Response('{}', { status: 200 }));
}

const EVENT = {
  name: 'Fall Open',
  description: 'Events: Men’s Singles',
  startsAt: '2026-09-01T16:00:00.000Z',
  endsAt: '2026-09-02T01:00:00.000Z',
  location: 'SFU Burnaby',
};

async function patchBody(patchTimes: boolean): Promise<Record<string, unknown>> {
  const fetchImpl = vi.fn(() => ok()) as unknown as typeof fetch;
  await apiWith(fetchImpl).modifyScheduledEvent('g1', 'evt-1', EVENT, patchTimes);

  const call = (fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls[0] as [
    string,
    RequestInit,
  ];
  return JSON.parse(call[1].body as string) as Record<string, unknown>;
}

describe('modifyScheduledEvent', () => {
  it('sends the schedule for an event that has not started', async () => {
    const body = await patchBody(true);

    expect(body.scheduled_start_time).toBe(EVENT.startsAt);
    expect(body.scheduled_end_time).toBe(EVENT.endsAt);
    expect(body.entity_type).toBe(3);
  });

  it('OMITS the schedule once the event has started', async () => {
    const body = await patchBody(false);

    expect(body.name).toBe('Fall Open');
    expect(body).not.toHaveProperty('scheduled_start_time');
    expect(body).not.toHaveProperty('scheduled_end_time');
    // entity_metadata travels with entity_type — Discord validates one against
    // the other, so a half-sent pair is worse than neither.
    expect(body).not.toHaveProperty('entity_type');
    expect(body).not.toHaveProperty('entity_metadata');
  });
});
