import { describe, it, expect, vi } from 'vitest';
import { DiscordApi } from '../discord-api.js';

// The multipart upload behind a screenshot on a bug report.
//
// This is the one path in the relay where a mistake LOOKS LIKE SUCCESS:
// Discord answers 200 and returns a message id whether or not the picture
// actually attached. Get the payload_json/files[0] pairing wrong and the execs
// see a report with no screenshot and no error anywhere. So it is asserted
// here directly rather than through the relay, which mocks DiscordApi whole.

function capture(body = '{"id":"m1"}') {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl = vi.fn((url: string, init: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(new Response(body, { status: 200 }));
  }) as unknown as typeof fetch;
  return { api: new DiscordApi({ token: 't', fetchImpl, sleep: async () => {} }), calls };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function shot(over: Partial<{ filename: string; contentType: string; bytes: Uint8Array }> = {}) {
  return { filename: 'shot.png', contentType: 'image/png', bytes: PNG, ...over };
}

describe('postMessageWithFile', () => {
  it('declares the file in payload_json AND sends it as files[0]', async () => {
    // THE PROPERTY. Discord renders the message without the image — 200, no
    // error — if the attachment is only in one half of the pair, or if the
    // declared filename does not match the part's.
    const { api, calls } = capture();
    const id = await api.postMessageWithFile('c1', { embeds: [{ title: 'Ladder spins' }] }, shot());

    expect(id).toBe('m1');
    const form = calls[0]?.init.body as FormData;
    expect(form).toBeInstanceOf(FormData);

    const payload = JSON.parse(form.get('payload_json') as string) as {
      embeds: unknown[];
      attachments: { id: number; filename: string }[];
    };
    expect(payload.embeds).toHaveLength(1);
    expect(payload.attachments).toEqual([{ id: 0, filename: 'shot.png' }]);

    const part = form.get('files[0]') as File;
    expect(part).toBeInstanceOf(Blob);
    // The declaration and the part have to agree on the name, and the index in
    // `files[N]` has to be the `id` in the declaration.
    expect(part.name).toBe('shot.png');
    expect(part.type).toBe('image/png');
    expect(part.size).toBe(PNG.length);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(PNG);
  });

  it('lets fetch write its own content-type so the boundary is the real one', async () => {
    // A hand-written multipart/form-data header names a boundary that is not
    // the one FormData used, and Discord rejects the whole body as malformed.
    const { api, calls } = capture();
    await api.postMessageWithFile('c1', { content: 'hi' }, shot());

    const headers = calls[0]?.init.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bot t');
    expect(Object.keys(headers).map((k) => k.toLowerCase())).not.toContain('content-type');
  });

  it('uploads only the view, not everything behind it', async () => {
    // A Uint8Array from a Buffer slice is a WINDOW onto a larger pool. Passing
    // its .buffer would upload the pool — other requests' bytes included.
    const pool = new Uint8Array([9, 9, 9, 1, 2, 3, 9, 9]).buffer;
    const view = new Uint8Array(pool, 3, 3);

    const { api, calls } = capture();
    await api.postMessageWithFile('c1', {}, shot({ bytes: view }));

    const part = (calls[0]?.init.body as FormData).get('files[0]') as File;
    expect(part.size).toBe(3);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('posts a plain json message when there is no picture', async () => {
    // Most reports have none, and a one-part multipart body for them would be
    // a different code path to get wrong.
    const { api, calls } = capture();
    await api.postMessageWithFile('c1', { content: 'no shot' }, null);

    const { init } = calls[0]!;
    expect(init.body).toBe(JSON.stringify({ content: 'no shot' }));
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('answers null rather than throwing when the upload is refused', async () => {
    // 40005 (request entity too large) is the realistic one. The report itself
    // is already filed by then, so a refused picture must not take the post
    // down with it.
    const calls: RequestInit[] = [];
    const fetchImpl = vi.fn((_url: string, init: RequestInit) => {
      calls.push(init);
      return Promise.resolve(new Response('{"code":40005}', { status: 413 }));
    }) as unknown as typeof fetch;
    const api = new DiscordApi({ token: 't', fetchImpl, sleep: async () => {} });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(await api.postMessageWithFile('c1', {}, shot())).toBeNull();
  });
});
