import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { clearRevocations, fetchLinkedMembers } from './api.js';
import { postAuditEntry } from './audit.js';
import { loadConfig } from './config.js';
import {
  DEFERRED_COMMANDS,
  dispatch,
  handleProfileAutocomplete,
  handleReportModal,
  handleSelfRoleButton,
  isReportModal,
  isSelfRoleButton,
  type CommandOption,
  type ModalComponent,
  type ResolvedAttachment,
} from './commands.js';
import { DiscordApi, editDeferredReply } from './discord-api.js';
import { warmHandles } from './handles.js';
import { sendMultipart } from './multipart.js';
import { reconcile } from './reconcile.js';
import { runSessionPings } from './session-pings.js';
import { runTournamentEvents } from './tournament-events.js';
import { runAnnouncements } from './announcements.js';
import { runMatchResults } from './match-results.js';
import { runFeedback } from './feedback.js';
import { startGateway, type GatewayHandle } from './gateway.js';
import { isAuthorizedService } from './service-auth.js';
import { verifyDiscordRequest } from './verify.js';

const PORT = Number(process.env.PORT ?? 3002);

// Discord will not POST a body larger than this, so anything bigger is not
// Discord. Cap it rather than buffering whatever arrives.
const MAX_BODY_BYTES = 256 * 1024;

// How long the autocomplete branch will wait on a cold handle cache before
// answering with nothing. Well under Discord's three seconds, because losing
// this race costs one keystroke's suggestions and missing the deadline costs
// the member an error.
const AUTOCOMPLETE_BUDGET_MS = 1_000;

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

// Held open only so Discord shows the bot online; see gateway.ts. Null when
// there is no token to connect with.
let gateway: GatewayHandle | null = null;

const server = createServer(async (req, res) => {
  // Health: a real GET, not a bare TCP accept. proxy-manager falls back to a TCP
  // dial when no proxy.health label is set, and a dial cannot tell "process is
  // up" from "process cannot reach the app API" — so the label is set and this
  // endpoint exists to give it something meaningful to ask.
  if (req.method === 'GET' && req.url === '/health') {
    // ok is deliberately not conditioned on the gateway. proxy.health points
    // here, so reporting a gateway blip as unhealthy would pull a perfectly
    // good interactions endpoint out of the pool -- the gateway only decides
    // whether Discord draws us green, and interactions do not travel over it.
    // Surface the state in the body so it is diagnosable without doing that.
    return send(res, 200, {
      ok: true,
      gateway: gateway ? gateway.state() : 'disabled',
      gatewayConnectedSince: gateway?.connectedSince() ?? null,
    });
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
  // Session pings, driven by pg_cron on the same schedule as the app's own
  // reminder job. One HTTP request reaches exactly one replica, which is the
  // whole reason this is not a setInterval in here.
  if (req.method === 'POST' && req.url === '/session-pings') {
    if (!isAuthorizedService(req.headers.authorization)) {
      return send(res, 401, { error: 'unauthorized' });
    }
    try {
      const result = await runSessionPings();
      return send(res, 200, result);
    } catch (error) {
      console.error('[bot] session pings failed:', error);
      return send(res, 500, { error: 'session_pings_failed' });
    }
  }

  // Tournament scheduled events, driven by pg_cron every 15 minutes. Polled
  // rather than pushed when an exec hits Activate, so a bot that happens to be
  // restarting at that moment causes a delay instead of a lost announcement
  // nobody would notice was lost.
  if (req.method === 'POST' && req.url === '/tournament-events') {
    if (!isAuthorizedService(req.headers.authorization)) {
      return send(res, 401, { error: 'unauthorized' });
    }
    try {
      const result = await runTournamentEvents();
      return send(res, 200, result);
    } catch (error) {
      console.error('[bot] tournament events failed:', error);
      return send(res, 500, { error: 'tournament_events_failed' });
    }
  }

  // The announcement relay, driven by pg_cron every 5 minutes. Faster than the
  // tournament sweep because an announcement is the thing an exec publishes and
  // then watches for: "urgent, no session tonight" arriving a quarter of an
  // hour late is a different message from the one that was written.
  if (req.method === 'POST' && req.url === '/announcements') {
    if (!isAuthorizedService(req.headers.authorization)) {
      return send(res, 401, { error: 'unauthorized' });
    }
    try {
      const result = await runAnnouncements();
      return send(res, 200, result);
    } catch (error) {
      console.error('[bot] announcement relay failed:', error);
      return send(res, 500, { error: 'announcements_failed' });
    }
  }

  // The match result relay, driven by pg_cron every 10 minutes. Slower than
  // announcements — nobody is waiting on a result the way they wait on "no
  // session tonight" — and faster than the tournament sweep, because results
  // land in bursts on a club night and a half-hour lag would make the channel
  // read as a digest rather than a feed.
  if (req.method === 'POST' && req.url === '/match-results') {
    if (!isAuthorizedService(req.headers.authorization)) {
      return send(res, 401, { error: 'unauthorized' });
    }
    try {
      const result = await runMatchResults();
      return send(res, 200, result);
    } catch (error) {
      console.error('[bot] match result relay failed:', error);
      return send(res, 500, { error: 'match_results_failed' });
    }
  }

  // The feedback relay, driven by pg_cron every 10 minutes. An inbox rather
  // than a feed: nobody stands in the exec channel waiting on a bug report the
  // way they wait on "no session tonight".
  if (req.method === 'POST' && req.url === '/feedback') {
    if (!isAuthorizedService(req.headers.authorization)) {
      return send(res, 401, { error: 'unauthorized' });
    }
    try {
      const result = await runFeedback();
      return send(res, 200, result);
    } catch (error) {
      console.error('[bot] feedback relay failed:', error);
      return send(res, 500, { error: 'feedback_failed' });
    }
  }

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
    data?: {
      name: string;
      // Subcommands nest their arguments one level down, so the option shape
      // has to be recursive rather than flat.
      options?: CommandOption[];
      /** MESSAGE_COMPONENT and MODAL_SUBMIT: which button, or which modal. */
      custom_id?: string;
      /** MODAL_SUBMIT only: the filled-in text inputs, nested in action rows. */
      components?: ModalComponent[];
      /**
       * APPLICATION_COMMAND only: the objects behind id-valued options.
       *
       * An attachment option's value is a snowflake and nothing else — the url,
       * filename and size live here. /bug reads it for the screenshot.
       */
      resolved?: { attachments?: Record<string, ResolvedAttachment> };
    };
    // Guild context populates member.user; a DM populates user and omits
    // member entirely. /link and /unlink are precisely the commands somebody
    // runs in a DM, so both have to be read.
    // `roles` is the caller's current role ids, sent on every guild
    // interaction. The self-role toggle reads it instead of fetching the member
    // again, which keeps the whole round trip inside Discord's 3-second budget.
    member?: { user?: { id?: string }; roles?: string[] };
    user?: { id?: string };
    guild_id?: string;
    // Only sent for real interactions, not for the PING probe.
    application_id?: string;
    token?: string;
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
    const context = {
      discordUserId: interaction.member?.user?.id ?? interaction.user?.id ?? null,
      guildId: interaction.guild_id ?? null,
      applicationId: interaction.application_id ?? null,
      interactionToken: interaction.token ?? null,
      attachments: interaction.data.resolved?.attachments ?? null,
    };

    // DEFERRED PATH. Discord gives an interaction 3 seconds to be acknowledged
    // or it tells the user the application did not respond -- and it means it,
    // whatever the bot does afterwards. /setup creates up to nine roles and
    // then writes to the app, so it cannot possibly answer inside that budget.
    //
    // So: acknowledge immediately with type 5 (a visible "thinking..."), let
    // the socket close, and PATCH the real answer in when the work is done.
    // The interaction token stays valid for 15 minutes, which is ample.
    if (DEFERRED_COMMANDS.has(interaction.data.name)) {
      const { name, options } = interaction.data;
      const { application_id: appId, token: interactionToken } = interaction;

      // flags 64 = ephemeral, and it has to be set HERE, on the deferral. A
      // deferred reply's visibility is fixed at acknowledgement time and cannot
      // be changed by the followup, so deferring non-ephemerally would publish
      // the role list to the whole channel.
      send(res, 200, { type: 5, data: { flags: 64 } });

      // Deliberately not awaited: the response is already sent.
      void (async () => {
        try {
          const response = await dispatch(name, options, context);
          if (!appId || !interactionToken) {
            // Nothing to edit. Only reachable if Discord sent a command
            // interaction without a token, which should not happen.
            console.error(`[bot] ${name} finished but had no interaction token`);
            return;
          }
          // dispatch returns a full interaction response; the webhook edit
          // wants only the message body.
          const payload = (response as { data?: unknown }).data ?? response;
          await editDeferredReply(appId, interactionToken, payload);
        } catch (error) {
          // dispatch catches its own errors, so reaching here means something
          // outside it failed. The user is still looking at "thinking...", so
          // say something rather than leaving it spinning forever.
          console.error(`[bot] deferred ${name} failed:`, error);
          if (appId && interactionToken) {
            await editDeferredReply(appId, interactionToken, {
              content: 'Something went wrong. Please try again.',
            });
          }
        }
      })();
      return;
    }

    const response = await dispatch(interaction.data.name, interaction.data.options, context);
    if (response.file) {
      // The file is SPLIT OFF, never passed through. send() would
      // JSON.stringify it, and a serialised byte array is a payload Discord
      // accepts as a message with a colossal content field.
      const { file, ...payload } = response;
      return sendMultipart(res, 200, payload, file);
    }
    return send(res, 200, response);
  }

  // MODAL_SUBMIT — someone filled in the /bug or /feedback boxes and pressed
  // submit.
  //
  // A SEPARATE INTERACTION FROM THE COMMAND THAT OPENED THE MODAL, with its own
  // 3-second budget and no memory of the first one: Discord echoes back the
  // custom_id and the typed values, and nothing else. Whatever the command knew
  // has to have been encoded in that id or stashed against it.
  //
  // Without this branch a submitted modal falls through to the catch-all below
  // and is answered with type 1, which Discord renders to the member as "this
  // application did not respond" — the report typed and lost.
  if (interaction.type === 5 && interaction.data) {
    const customId = interaction.data.custom_id;

    if (isReportModal(customId)) {
      const context = {
        // Same two places as a command: a guild submit populates member.user, a
        // DM submit populates user.
        discordUserId: interaction.member?.user?.id ?? interaction.user?.id ?? null,
        guildId: interaction.guild_id ?? null,
      };
      try {
        const response = await handleReportModal(
          customId as string,
          interaction.data.components,
          context
        );
        return send(res, 200, response);
      } catch (error) {
        console.error('[bot] report modal failed:', error);
        return send(res, 200, {
          type: 4,
          data: {
            content:
              "Couldn't reach the club app just now — nothing was filed. Try again in a moment.",
            flags: 64,
          },
        });
      }
    }

    // A modal this build does not know. type 4 rather than the components'
    // type 6, because a modal has no message to leave intact and a silent
    // acknowledgement would look like the submit vanished.
    return send(res, 200, {
      type: 4,
      data: { content: 'That form is from an older version — run the command again.', flags: 64 },
    });
  }

  // MESSAGE_COMPONENT — someone clicked a button.
  //
  // The picker's buttons live on a message that stays in the channel, so this
  // arrives long after the command that posted it, from anybody who can see the
  // channel. Everything needed to answer is on the interaction itself:
  // `member.roles` is the caller's CURRENT role list as Discord sees it, which
  // is what makes a toggle possible without a second API round-trip inside the
  // 3-second budget.
  if (interaction.type === 3 && interaction.data) {
    const customId = interaction.data.custom_id;

    if (isSelfRoleButton(customId)) {
      const context = {
        discordUserId: interaction.member?.user?.id ?? interaction.user?.id ?? null,
        guildId: interaction.guild_id ?? null,
      };
      try {
        const response = await handleSelfRoleButton(
          customId as string,
          context,
          interaction.member?.roles ?? []
        );
        return send(res, 200, response);
      } catch (error) {
        console.error('[bot] self-role button failed:', error);
        return send(res, 200, {
          type: 4,
          data: { content: 'Something went wrong. Please try again.', flags: 64 },
        });
      }
    }

    // A component this build does not know — most likely a button from a
    // message posted by an older version. type 6 is DEFERRED_UPDATE_MESSAGE:
    // acknowledge and change nothing, which leaves the message intact rather
    // than showing the clicker an error for something that is not their fault.
    return send(res, 200, { type: 6 });
  }

  // APPLICATION_COMMAND_AUTOCOMPLETE — the /profile handle picker, refiring on
  // every keystroke.
  //
  // CANNOT BE DEFERRED. Type 8 within about three seconds is the only valid
  // answer there is, and the fall-through below would reply type 1, which the
  // picker renders as "loading options failed".
  //
  // So the cold-cache read races a timer and empty choices win it. A picker
  // that suggests nothing for one keystroke is invisible; a missed deadline is
  // an error the member sees.
  if (interaction.type === 4 && interaction.data) {
    const options = interaction.data.options;
    try {
      const answered = await Promise.race([
        handleProfileAutocomplete(options),
        new Promise<{ type: number; data: { choices: [] } }>((resolve) =>
          setTimeout(() => resolve({ type: 8, data: { choices: [] } }), AUTOCOMPLETE_BUDGET_MS)
        ),
      ]);
      return send(res, 200, answered);
    } catch (error) {
      // The whole branch, because createServer's handler has no outer catch: a
      // throw escaping here writes no response at all and raises an unhandled
      // rejection in the process.
      console.error('[bot] autocomplete failed:', error);
      return send(res, 200, { type: 8, data: { choices: [] } });
    }
  }

  // Unknown interaction type — acknowledge rather than erroring, so a future
  // Discord type does not surface to users as a broken bot.
  return send(res, 200, { type: 1 });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[bot] listening on ${PORT}`);

  // Presence. Interactions arrive over HTTP and do not need this, so a missing
  // token costs a grey dot and nothing else -- never a failed boot.
  const token = process.env.DISCORD_BOT_TOKEN;
  if (token) {
    try {
      gateway = startGateway({ token });
    } catch (error) {
      console.error(`[bot] gateway failed to start: ${String(error)}`);
    }
  } else {
    console.log('[bot] no DISCORD_BOT_TOKEN — gateway disabled, bot will show offline');
  }

  // Filled now rather than on the first keystroke: an autocomplete cannot be
  // deferred, so a cold cache spends the member's whole budget on a fetch.
  // Non-fatal, like loadConfig below — the picker simply pays for it later.
  warmHandles();

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
    gateway?.stop();
    server.close(() => process.exit(0));
  });
}
