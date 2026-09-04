import { describe, it, expect } from 'vitest';
import type { ServerResponse } from 'node:http';
import { sendMultipart } from '../multipart.js';

// The same property attachment-upload.test.ts pins for the relay, for the other
// multipart path: the interaction callback /profile answers with.
//
// It is asserted here for the same reason — a mistake LOOKS LIKE SUCCESS.
// Discord accepts the response, renders the message, and simply leaves the
// picture out if the declaration and the part disagree or if the boundary in
// the header is not the one in the body.

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function card(over: Partial<{ filename: string; contentType: string; bytes: Uint8Array }> = {}) {
  return { filename: 'card.png', contentType: 'image/png', bytes: PNG, ...over };
}

function capture() {
  const written: { status?: number; headers?: Record<string, unknown>; body?: Buffer } = {};
  const res = {
    writeHead(status: number, headers: Record<string, unknown>) {
      written.status = status;
      written.headers = headers;
      return this;
    },
    end(body: Buffer) {
      written.body = body;
    },
  } as unknown as ServerResponse;
  return { res, written };
}

/** Re-read the body the way Discord would: through the header it was sent with. */
function parse(written: { headers?: Record<string, unknown>; body?: Buffer }) {
  return new Request('http://discord.test/', {
    method: 'POST',
    headers: { 'content-type': String(written.headers?.['content-type']) },
    body: new Uint8Array(written.body as Buffer),
  }).formData();
}

describe('sendMultipart', () => {
  it('declares the file in payload_json.data AND sends it as files[0]', async () => {
    const { res, written } = capture();
    await sendMultipart(
      res,
      200,
      { type: 4, data: { content: 'hi', attachments: [{ id: 0, filename: 'card.png' }] } },
      card()
    );

    expect(written.status).toBe(200);
    const form = await parse(written);

    const payload = JSON.parse(form.get('payload_json') as string) as {
      type: number;
      data: { content: string; attachments: { id: number; filename: string }[] };
    };
    expect(payload.type).toBe(4);
    // INSIDE data. On an interaction callback the message fields live one level
    // down, and an `attachments` beside `data` is ignored without complaint.
    expect(payload.data.attachments).toEqual([{ id: 0, filename: 'card.png' }]);
    expect(payload.data.content).toBe('hi');

    const part = form.get('files[0]') as File;
    expect(part).toBeInstanceOf(Blob);
    // The declaration and the part have to agree on the name, and the index in
    // `files[N]` has to be the `id` in the declaration.
    expect(part.name).toBe('card.png');
    expect(part.type).toBe('image/png');
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(PNG);
  });

  it('sends the boundary the body actually uses', async () => {
    // A hand-written multipart/form-data header names a boundary FormData did
    // not pick, and Discord rejects the whole body as malformed — which reads
    // as a bad attachment rather than a bad header. The parse above would fail
    // outright on that, so this pins the header against the bytes directly.
    const { res, written } = capture();
    await sendMultipart(res, 200, { type: 4, data: {} }, card());

    const contentType = String(written.headers?.['content-type']);
    const boundary = /boundary=(.+)$/.exec(contentType)?.[1];
    expect(boundary).toBeTruthy();
    expect((written.body as Buffer).toString('utf8')).toContain(`--${boundary}`);
    expect(written.headers?.['content-length']).toBe((written.body as Buffer).length);
  });

  it('uploads only the view, not everything behind it', async () => {
    // A Uint8Array from a Buffer slice is a WINDOW onto a larger pool. Passing
    // its .buffer would upload the pool — other requests' bytes included.
    const pool = new Uint8Array([9, 9, 9, 1, 2, 3, 9, 9]).buffer;
    const view = new Uint8Array(pool, 3, 3);

    const { res, written } = capture();
    await sendMultipart(res, 200, { type: 4, data: {} }, card({ bytes: view }));

    const part = (await parse(written)).get('files[0]') as File;
    expect(part.size).toBe(3);
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
  });
});
