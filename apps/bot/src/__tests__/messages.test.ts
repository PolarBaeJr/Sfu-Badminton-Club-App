import { describe, it, expect, vi } from 'vitest';
import { DiscordApi } from '../discord-api.js';

// The message helpers the announcement relay needs, and the one non-obvious
// thing about them: a message the bot has already lost is not a failure.

function apiWith(status: number, body = '{}') {
  const fetchImpl = vi.fn(() =>
    Promise.resolve(new Response(status === 204 ? null : body, { status }))
  ) as unknown as typeof fetch;
  return { api: new DiscordApi({ token: 't', fetchImpl, sleep: async () => {} }), fetchImpl };
}

describe('postMessage', () => {
  it('hands back the message id, which is what makes an edit possible later', async () => {
    const { api } = apiWith(200, '{"id":"m1"}');
    expect(await api.postMessage('c1', { embeds: [] })).toBe('m1');
  });

  it('answers null rather than throwing when Discord refuses', async () => {
    const { api } = apiWith(403);
    expect(await api.postMessage('c1', { embeds: [] })).toBeNull();
  });
});

describe('editMessage', () => {
  it('answers ok when the edit lands', async () => {
    const { api } = apiWith(200);
    expect(await api.editMessage('c1', 'm1', { embeds: [] })).toBe('ok');
  });

  it("SEPARATES 'gone' from 'failed', because only one of them is worth retrying", async () => {
    // A message somebody deleted by hand answers 404 to every PATCH after it.
    // Folded in with a real refusal, the caller retries a dead id every five
    // minutes for as long as the announcement exists — and an announcement with
    // no expiry exists indefinitely. The caller can only settle the diff if it
    // can tell the two apart.
    const { api } = apiWith(404);
    expect(await api.editMessage('c1', 'm1', { embeds: [] })).toBe('gone');
  });

  it('reports a refusal as failed, so it is tried again', async () => {
    const { api } = apiWith(403);
    expect(await api.editMessage('c1', 'm1', { embeds: [] })).toBe('failed');
  });
});

describe('deleteMessage', () => {
  it('counts 404 as success', async () => {
    // Somebody removing the message by hand has already achieved what the call
    // was for. Treating it as a failure would retry it every five minutes for
    // as long as the announcement stayed retracted.
    const { api } = apiWith(404);
    expect(await api.deleteMessage('c1', 'm1')).toBe(true);
  });

  it('counts 204 as success', async () => {
    const { api } = apiWith(204);
    expect(await api.deleteMessage('c1', 'm1')).toBe(true);
  });

  it('reports a real refusal as a failure, so the mapping is left alone', async () => {
    const { api } = apiWith(403);
    expect(await api.deleteMessage('c1', 'm1')).toBe(false);
  });
});
