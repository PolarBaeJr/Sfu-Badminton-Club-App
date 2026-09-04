import type { ServerResponse } from 'node:http';
import type { CardFile } from './api.js';

/**
 * Answer an interaction with a file attached.
 *
 * Discord takes an attachment as multipart even on the interaction callback:
 * `payload_json` holding what would otherwise be the whole body, plus `files[0]`
 * holding the bytes. The attachment must ALSO be declared in
 * `payload_json.data.attachments` with the matching id — inside `data`, not
 * beside it, because on a callback the message fields live one level down.
 * Getting either half wrong is answered with a 200 and a message that renders
 * without the image, and nothing anywhere reports it.
 *
 * Its own file rather than a helper in index.ts so it can be tested: importing
 * index.ts runs its module body, which binds the port and opens a gateway
 * socket.
 */
export async function sendMultipart(
  res: ServerResponse,
  status: number,
  payload: unknown,
  file: CardFile
): Promise<void> {
  const form = new FormData();
  form.append('payload_json', JSON.stringify(payload));
  // The Uint8Array itself, not its .buffer: a view onto a larger pool would
  // otherwise upload everything behind it. Blob copies the view's own range.
  form.append('files[0]', new Blob([file.bytes], { type: file.contentType }), file.filename);

  // The body is encoded through Response so the content-type header can be
  // taken FROM IT. FormData picks its own boundary, and a hand-written
  // multipart/form-data header names a different one — Discord rejects that as
  // a malformed payload, which reads as a bad attachment rather than a bad
  // header. Same trap discord-api.ts avoids by letting fetch write the header.
  const encoded = new Response(form);
  const body = Buffer.from(await encoded.arrayBuffer());

  res.writeHead(status, {
    'content-type': encoded.headers.get('content-type') ?? 'multipart/form-data',
    'content-length': body.length,
  });
  res.end(body);
}
