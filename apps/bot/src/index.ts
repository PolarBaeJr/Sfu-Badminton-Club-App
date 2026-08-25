import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { clearRevocations, fetchLinkedMembers } from './api.js';
import { postAuditEntry } from './audit.js';
import { loadConfig } from './config.js';
import { dispatch } from './commands.js';
import { DiscordApi } from './discord-api.js';
import { reconcile } from './reconcile.js';
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

async function runSweep(res: ServerResponse, trigger: 'scheduled' | 'manual') {
  if (sweepInFlight) return send(res, 409, { error: 'sweep_already_running' });
  sweepInFlight = true;
  try {
    // force: the sweep runs nightly and has no reason to act on a role map
    // cached a minute ago. Everything else is happy with the cached copy.
    const { registry, auditChannelId } = await loadConfig({ force: true });
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

    // One entry per sweep, never one per member — see rule 3 in audit.ts. It is
    // awaited rather than fired off, so a sweep that has answered 200 has
    // already been written down; the alternative loses the last entry whenever
    // the container is replaced right after a sweep, which is exactly when a
    // deploy happens.
    await postAuditEntry(new DiscordApi({ token }), auditChannelId, {
      kind: 'sweep',
      summary,
      guilds: registry.size,
      trigger,
    });

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

async function runMemberSync(req: IncomingMessage, res: ServerResponse) {
  let body: { discordUserIds?: unknown; reason?: unknown };
  try {
    body = JSON.parse(await readRawBody(req)) as { discordUserIds?: unknown; reason?: unknown };
  } catch {
    return send(res, 400, { error: 'bad_request' });
  }

  const ids = body.discordUserIds;
  if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string') || ids.length === 0) {
    return send(res, 400, { error: 'invalid_body' });
  }

  // Cosmetic — it only picks the audit entry's title. Validated anyway rather
  // than interpolated, so a caller cannot write its own heading into the log.
  const reason: 'linked' | 'unlinked' | 'resynced' =
    body.reason === 'linked' || body.reason === 'unlinked' ? body.reason : 'resynced';

  try {
    const { registry, auditChannelId } = await loadConfig();
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) return send(res, 500, { error: 'DISCORD_BOT_TOKEN is not set' });

    // The whole roster, then filtered. Wasteful by one request and correct by
    // construction: the app remains the only thing that decides what a member
    // is, and an id that is NOT in the list is a tombstone the app wants
    // stripped — which this handles for free, because reconcile already reads
    // a missing state as "strip everything".
    const roster = await fetchLinkedMembers();
    const members = (ids as string[]).map(
      (id) => roster.find((m) => m.discordUserId === id) ?? { discordUserId: id, state: null }
    );

    const api = new DiscordApi({ token });
    const summary = await reconcile(api, registry, members);
    try {
      await clearRevocations(summary.cleared);
    } catch (error) {
      console.error('[bot] could not clear revocations:', error);
    }

    await postAuditEntry(api, auditChannelId, {
      kind: 'member',
      reason,
      discordUserIds: ids as string[],
      summary,
    });

    return send(res, 200, { ok: true, ...summary });
  } catch (error) {
    console.error('[bot] member sync failed:', error);
    return send(res, 500, { error: 'sync_failed' });
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
    // The nightly pg_cron job posts {} and is the only scheduled driver, so an
    // explicit "manual" is how a human-triggered sweep says so. Defaulting the
    // other way would label every hand-run curl as the nightly job.
    let trigger: 'scheduled' | 'manual' = 'scheduled';
    try {
      const parsed = JSON.parse(await readRawBody(req)) as { trigger?: unknown };
      if (parsed?.trigger === 'manual') trigger = 'manual';
    } catch {
      // No body, or not JSON. Both mean the scheduled default.
    }
    return runSweep(res, trigger);
  }

  // ONE member, right now. The app calls this the moment a link is created or
  // moved, because the alternative is telling somebody their account is
  // connected and then showing them no roles until the next sweep — which,
  // until something drives POST /sync, may be never.
  if (req.method === 'POST' && req.url === '/sync-member') {
    if (!isAuthorizedService(req.headers.authorization)) {
      return send(res, 401, { error: 'unauthorized' });
    }
    return runMemberSync(req, res);
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
    // Guild context populates member.user; a DM populates user and omits
    // member entirely. /link and /unlink are precisely the commands somebody
    // runs in a DM, so both have to be read.
    member?: { user?: { id?: string } };
    user?: { id?: string };
    guild_id?: string;
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
    const response = await dispatch(interaction.data.name, interaction.data.options, {
      discordUserId: interaction.member?.user?.id ?? interaction.user?.id ?? null,
      guildId: interaction.guild_id ?? null,
    });
    return send(res, 200, response);
  }

  // Unknown interaction type — acknowledge rather than erroring, so a future
  // Discord type does not surface to users as a broken bot.
  return send(res, 200, { type: 1 });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[bot] listening on ${PORT}`);
  // Where config comes from, said once. The guild map and audit channel are
  // read from the database at runtime now, so the env vars are only the
  // bootstrap fallback for a bot running against a database without 00167 —
  // and "no audit entries" and "audit entries nobody can see" look identical
  // from inside Discord, so the distinction has to be drawn here.
  loadConfig()
    .then(({ registry, auditChannelId }) => {
      console.log(
        `[bot] config: ${registry.size} guild(s), audit log ${
          auditChannelId ? `-> channel ${auditChannelId}` : 'DISABLED (no audit_channel_id)'
        }`
      );
    })
    .catch((error) => {
      // Not fatal. The app may simply not be up yet, and every operation
      // re-reads config anyway; this is a startup diagnostic, not a gate.
      console.error(`[bot] could not read config at startup: ${String(error)}`);
    });
});

// The proxy and Docker both stop containers with SIGTERM. Closing the server
// lets in-flight interactions finish instead of being cut off mid-reply.
for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  process.on(signal, () => {
    console.log(`[bot] ${signal} — shutting down`);
    server.close(() => process.exit(0));
  });
}
