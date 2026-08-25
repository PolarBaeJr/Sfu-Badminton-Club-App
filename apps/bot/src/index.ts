import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { clearRevocations, fetchLinkedMembers } from './api.js';
import { dispatch } from './commands.js';
import { DiscordApi } from './discord-api.js';
import { reconcile } from './reconcile.js';
import { parseGuildRegistry } from './roles.js';
import { isAuthorizedService } from './service-auth.js';
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

// A sweep in flight, if there is one. Overlapping sweeps would race each
// other's role writes and double the rate-limit pressure for no benefit, and
// the scheduler firing again while the last one is still going is the ordinary
// way that happens.
//
// PER PROCESS, and that is the whole of what it guards. This service omits
// proxy.unscalable on purpose, so at two replicas the proxy hands the second
// call to the other process and this flag never sees it. That is acceptable
// because the sweep is convergent — two of them reach the same end state — but
// it is not a lock, and it must not be described as one. A real one belongs in
// Postgres (an advisory lock in the job that drives this) if it ever matters.
let sweepInFlight = false;

async function runSweep(res: ServerResponse) {
  if (sweepInFlight) return send(res, 409, { error: 'sweep_already_running' });
  sweepInFlight = true;
  try {
    const registry = parseGuildRegistry(process.env.DISCORD_GUILDS);
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) return send(res, 500, { error: 'DISCORD_BOT_TOKEN is not set' });

    const members = await fetchLinkedMembers();
    const api = new DiscordApi({ token });
    const summary = await reconcile(api, registry, members);

    // Bookkeeping, and it runs after the roles are already gone. A failure here
    // must not turn a successful sweep into a 500, so it is logged and dropped:
    // the tombstone simply survives to the next sweep, which finds nothing left
    // to strip and reports it clear again.
    try {
      await clearRevocations(summary.cleared);
    } catch (error) {
      console.error('[bot] could not clear revocations:', error);
    }

    // The SUMMARY goes in the body, not just a 200. Whatever drives this is
    // likely pg_net, which follows redirects — so a 200 on its own proves
    // nothing about whether the sweep ran. The caller has to read the content.
    return send(res, 200, { ok: true, ...summary });
  } catch (error) {
    console.error('[bot] sweep failed:', error);
    return send(res, 500, { error: 'sweep_failed' });
  } finally {
    sweepInFlight = false;
  }
}

const server = createServer(async (req, res) => {
  // Health: a real GET, not a bare TCP accept. proxy-manager falls back to a TCP
  // dial when no proxy.health label is set, and a dial cannot tell "process is
  // up" from "process cannot reach the app API" — so the label is set and this
  // endpoint exists to give it something meaningful to ask.
  if (req.method === 'GET' && req.url === '/health') {
    return send(res, 200, { ok: true });
  }

  // The reconciliation sweep, driven from outside rather than by a timer in
  // here: the compose service omits proxy.unscalable, so a setInterval would
  // become one sweep PER REPLICA, all writing the same roles. One HTTP request
  // reaches exactly one replica no matter how many are running.
  if (req.method === 'POST' && req.url === '/sync') {
    if (!isAuthorizedService(req.headers.authorization)) {
      return send(res, 401, { error: 'unauthorized' });
    }
    return runSweep(res);
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
