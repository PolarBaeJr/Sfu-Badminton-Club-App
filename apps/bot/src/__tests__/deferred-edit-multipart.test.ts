import { describe, it, expect, vi } from 'vitest';
import { editDeferredReply } from '../discord-api.js';

// THE THIRD MULTIPART SHAPE, and the one that differs from the other two.
//
// sendMultipart declares the attachment under `payload_json.data`, because an
// interaction CALLBACK nests the message fields one level down. This route is a
// webhook edit and takes a message directly, so the same declaration one level
// down is simply ignored — and the failure is the one interaction-multipart
// and attachment-upload are both written against: Discord answers 200, renders
// the message, and leaves the picture out. Nothing logs it, and the message
// stays in the channel looking like the card render broke.
//
// Reusing sendMultipart's shape here is the obvious mistake, which is precisely
// why the nesting is asserted rather than assumed.

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CARD = { filename: 'card.png', contentType: 'image/png', bytes: PNG };

/** Re-read what was sent the way Discord would, through fetch's own header. */
function captureFetch() {
  const calls: { url: string; init: RequestInit }[] = [];
  const impl = vi.fn(async (url: unknown, init: unknown) => {
    calls.push({ url: String(url), init: init as RequestInit });
    return new Response('{}', { status: 200 });
  }) as unknown as typeof fetch;
  return { impl, calls };
}

describe('editDeferredReply with a file', () => {
  it('declares the attachment at the TOP level, not under data', async () => {
    const { impl, calls } = captureFetch();

    const ok = await editDeferredReply(
      'app1',
      'tok1',
      { attachments: [{ id: 0, filename: 'card.png' }] },
      impl,
      CARD
    );

    expect(ok).toBe(true);
    const form = calls[0].init.body as FormData;
    const payload = JSON.parse(String(form.get('payload_json')));

    expect(payload.attachments).toEqual([{ id: 0, filename: 'card.png' }]);
    // The callback nesting. Present here, the image silently does not render.
    expect(payload.data).toBeUndefined();
  });

  it('sends the bytes as files[0] under the declared filename', async () => {
    const { impl, calls } = captureFetch();

    await editDeferredReply('app1', 'tok1', { attachments: [{ id: 0, filename: 'card.png' }] }, impl, CARD);

    const part = (calls[0].init.body as FormData).get('files[0]') as File;
    expect(part.name).toBe('card.png');
    expect(part.type).toBe('image/png');
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(PNG);
  });

  it('names no content-type, so fetch writes the boundary it actually used', async () => {
    // A hand-written multipart/form-data header names a boundary that is not the
    // one FormData chose, and Discord rejects the whole body as malformed — which
    // reads as a bad attachment rather than a bad header. Letting fetch write it
    // is the only way the two agree.
    const { impl, calls } = captureFetch();

    await editDeferredReply('app1', 'tok1', {}, impl, CARD);

    const headers = (calls[0].init.headers ?? {}) as Record<string, string>;
    expect(headers['content-type']).toBeUndefined();
    expect(calls[0].init.body).toBeInstanceOf(FormData);
  });

  it('still sends plain json when there is no file', async () => {
    // The fallback /profile degrades to, and every other deferred command.
    const { impl, calls } = captureFetch();

    await editDeferredReply('app1', 'tok1', { content: 'https://app.example/card/tok' }, impl);

    const headers = calls[0].init.headers as Record<string, string>;
    expect(headers['content-type']).toBe('application/json');
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      content: 'https://app.example/card/tok',
    });
  });
});
