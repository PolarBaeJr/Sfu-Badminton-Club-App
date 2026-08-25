import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { dispatch } from './commands.js';
import { verifyDiscordRequest } from './verify.js';

const PORT = Number(process.env.PORT ?? 3002);

// Discord will not POST a body larger than this, so anything bigger is not
// Discord. Cap it rather than buffering whatever arrives.
const MAX_BODY_BYTES = 256 * 1024;

function send(res: ServerResponse, status: number, body: unknown) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  res.end(payload);
}

// The signature covers the RAW body, so it has to be kept as-received. Parsing
// and re-serialising reorders keys and drops whitespace, which invalidates every
// signature — a failure that looks like a wrong public key and is not.
function readRawBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

const server = createServer(async (req, res) => {
  // Health: a real GET, not a bare TCP accept. proxy-manager falls back to a TCP
  // dial when no proxy.health label is set, and a dial cannot tell "process is
  // up" from "process cannot reach the app API" — so the label is set and this
  // endpoint exists to give it something meaningful to ask.
  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { ok: true });
  }

  if (req.method !== 'POST' || (req.url !== '/' && req.url !== '/interactions')) {
    return send(res, 404, { error: 'not_found' });
  }

  const publicKey = process.env.DISCORD_PUBLIC_KEY;
  if (!publicKey) {
    // Fail closed. Without the key nothing can be verified, and answering
    // anything other than 401 would make an unconfigured deploy look healthy.
    console.error('[bot] DISCORD_PUBLIC_KEY is not set — refusing all interactions');
    return send(res, 401, { error: 'unverified' });
  }

  let rawBody: string;
  try {
    rawBody = await readRawBody(req);
  } catch {
    return send(res, 400, { error: 'bad_request' });
  }

  const verified = verifyDiscordRequest(
    publicKey,
    req.headers['x-signature-ed25519'] as string | undefined,
    req.headers['x-signature-timestamp'] as string | undefined,
    rawBody
  );

  // 401 on a bad signature is REQUIRED, not merely correct: Discord probes the
  // endpoint with a deliberately invalid signature during setup and rejects any
  // endpoint that answers 200.
  if (!verified) return send(res, 401, { error: 'invalid signature' });

  let interaction: {
    type: number;
    data?: { name: string; options?: { name: string; value?: string | number }[] };
  };
  try {
    interaction = JSON.parse(rawBody);
  } catch {
    return send(res, 400, { error: 'bad_request' });
  }

  // PING/PONG. Discord sends this on save and periodically after.
  if (interaction.type === 1) return send(res, 200, { type: 1 });

  // APPLICATION_COMMAND
  if (interaction.type === 2 && interaction.data) {
    const response = await dispatch(interaction.data.name, interaction.data.options);
    return send(res, 200, response);
  }

  // Unknown interaction type — acknowledge rather than erroring, so a future
  // Discord type does not surface to users as a broken bot.
  return send(res, 200, { type: 1 });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[bot] listening on ${PORT}`);
});

// The proxy and Docker both stop containers with SIGTERM. Closing the server
// lets in-flight interactions finish instead of being cut off mid-reply.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`[bot] ${signal} — shutting down`);
    server.close(() => process.exit(0));
  });
}
