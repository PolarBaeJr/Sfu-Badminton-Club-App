import { createHash } from 'node:crypto';
import {
  fetchSessionBoard,
  fetchSessions,
  writeSessionBoard,
  type SessionBoardState,
} from './api.js';
import { sessionBoardWall } from './commands.js';
import { DiscordApi } from './discord-api.js';

// ONE MESSAGE, POINTED AT A CHANNEL ONCE, THAT KEEPS ITSELF CURRENT.
//
// An exec runs /config channels session_board:#sessions and never touches it
// again: this re-renders the club-wide schedule on the existing five minute
// announcements tick and edits the message IN PLACE, only when what it would say
// has actually changed. A member's click never moves it; they get their own
// private copy (see handleSessionBoardButton).
//
// WHY A BOT-POSTED MESSAGE RATHER THAN /sessionpost's. What expires fifteen
// minutes after an interaction is the interaction TOKEN, which is the credential
// the webhook edit route needs. The message an interaction creates is an
// ordinary channel message authored by the bot, and PATCH
// /channels/{id}/messages/{id} needs nothing beyond authorship, so either would
// be editable forever. The board is posted with postMessageResult anyway,
// because /sessionpost stays the one-off snapshot: one command cannot also adopt
// a channel as the permanent board without an option to say which it meant.
//
// IT RENDERS THROUGH sessionBoardWall AND NOTHING ELSE. That wrapper hardcodes
// `sesboard:p:`, and this module does not import sessionPostCopy at all. A tick
// that emitted `e` ids would arm a type-7 edit of the public post under every
// reader, which is the largest blast radius in the whole design.
//
// COMPONENTS GO OUT ON EVERY POST AND EVERY EDIT, explicitly. Whether a REST
// edit preserves fields it was not sent is not relied on here, and the
// fingerprint covers the components for the case that makes it load-bearing:
// when the schedule shrinks below eleven rows the board must LOSE its pager, and
// an embeds-only edit would leave live controls on a one-page board.
//
// Driven by pg_cron over HTTP, like the other two jobs on that tick, because the
// compose service omits proxy.unscalable and a setInterval here would be one
// scheduler per replica.

export interface SessionBoardRunResult {
  posted: number;
  edited: number;
  /** Nothing changed, so no Discord call was made at all. */
  unchanged: number;
  /** The message had been deleted by hand; the next tick reposts. */
  stale: number;
  /** An admin repointed the setting, so the old message was taken down. */
  moved: number;
  /** The setting was cleared, so the board was taken down deliberately. */
  retracted: number;
  /** Discord refused the post. Nothing was created, so a later tick can retry. */
  refused: number;
  /** The repost cap bound. Something is deleting the board as fast as it posts. */
  suppressed: number;
  /** A post was started and never confirmed. Refuses to post again. */
  stuck: number;
  skipped: number;
  failed: number;
}

/**
 * How many times in 24 hours the board may be posted afresh.
 *
 * THE BACKSTOP AGAINST A CHANNEL THAT DELETES MESSAGES AUTOMATICALLY, which is
 * "a fresh schedule every five minutes, forever" in its purest form. Three is
 * enough for the real recovery case (somebody deleted it by hand) and small
 * enough that the wrong configuration goes quiet loudly instead.
 */
const MAX_REPOSTS_PER_DAY = 3;

const REPOST_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * One tick at a time IN THIS PROCESS. Modelled on the sweep's flag in index.ts,
 * and carrying the same honest caveat: it is not a lock, so two containers can
 * still tick at once. The pending marker below, not this flag, is what narrows
 * double posting.
 */
let boardInFlight = false;

/**
 * What the message would be, byte for byte, plus its fingerprint.
 *
 * THE FINGERPRINT COVERS THE WHOLE BODY, embeds and components and
 * allowed_mentions together, so any change to the render forces exactly one
 * corrective edit on the next tick and no version salt has to be remembered.
 * The object is built from a fixed literal shape, so JSON.stringify's key order
 * is stable.
 */
function boardPayload(data: Awaited<ReturnType<typeof fetchSessions>>) {
  const payload = {
    ...sessionBoardWall(data),
    // Mirrors the announcement relay: the schedule lives in the embed and never
    // in `content`, and an empty parse list means nothing in it can notify even
    // if a session name someday carries a role mention.
    allowed_mentions: { parse: [] as string[] },
  };
  return {
    payload,
    fingerprint: createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 32),
  };
}

/**
 * Forget the MESSAGE, keep the COUNTERS.
 *
 * NEVER COLLAPSE THIS WITH clearAll, and here is the trace that says why. A
 * PATCH against a message somebody deleted answers 404, editMessage reports
 * 'gone', and if that deleted the whole row the next tick would see no state at
 * all, treat it as a first post, and post: the repost cap could never bind
 * because the counter lived in the row that was just dropped. The board would
 * repost itself every five minutes forever.
 */
function clearMessage(state: SessionBoardState): SessionBoardState {
  return {
    ...state,
    messageId: null,
    fingerprint: null,
    pending: false,
  };
}

export async function runSessionBoard(): Promise<SessionBoardRunResult> {
  const result: SessionBoardRunResult = {
    posted: 0,
    edited: 0,
    unchanged: 0,
    stale: 0,
    moved: 0,
    retracted: 0,
    refused: 0,
    suppressed: 0,
    stuck: 0,
    skipped: 0,
    failed: 0,
  };

  if (boardInFlight) {
    console.log('[bot] session board: previous tick still running, skipping');
    result.skipped += 1;
    return result;
  }
  boardInFlight = true;

  try {
    const token = process.env.DISCORD_BOT_TOKEN;
    if (!token) {
      console.error('[bot] session board: DISCORD_BOT_TOKEN is not set');
      result.skipped += 1;
      return result;
    }
    const api = new DiscordApi({ token });

    const { channelId, state } = await fetchSessionBoard();

    // THE OFF SWITCH. Clearing the setting is how the club takes the board down,
    // so an unset channel with state to its name means "retract it". This is the
    // only caller of the whole-row delete: a human touched the setting, so the
    // repost budget resets with it.
    if (!channelId) {
      if (!state) {
        // NOTHING IS WRITTEN HERE. Without this branch the bot would issue a
        // pointless write every five minutes for the whole period before the club
        // ever sets the channel.
        result.skipped += 1;
        return result;
      }
      // Deleted by the channel the message is IN, not the configured one, which
      // is unset on this branch.
      if (state.messageId) await api.deleteMessage(state.channelId, state.messageId);
      await writeSessionBoard(null);
      console.log('[bot] session board: setting cleared, board retracted');
      result.retracted += 1;
      return result;
    }

    // A POST WAS STARTED AND NEVER CONFIRMED. Posting again could duplicate a
    // board this process cannot see, so it refuses and says so loudly. Recovery
    // needs no SQL: /config clear session_board reaches the branch above, which
    // drops the row.
    if (state?.pending && state.messageId === null) {
      console.error(
        `[bot] session board: a post to ${state.channelId} was never confirmed ` +
          `(started ${state.postedAt ?? 'unknown'}); refusing to post again. ` +
          'Clear the session_board setting to reset.'
      );
      result.stuck += 1;
      return result;
    }

    // AN ADMIN REPOINTED THE SETTING. The old copy comes down, because a board is
    // a singleton and nobody would be updating a stale one. This deliberately
    // differs from the announcement relay, which leaves already-posted messages
    // where they are: an announcement is a historical artifact, this is not.
    if (state && state.channelId !== channelId) {
      if (state.messageId) await api.deleteMessage(state.channelId, state.messageId);
      await writeSessionBoard(null);
      console.log(
        `[bot] session board: moved from ${state.channelId} to ${channelId}; ` +
          'posting on the next tick'
      );
      result.moved += 1;
      return result;
    }

    // AS NOBODY, PAGE 1, NO FILTER. The audience for a channel post is everyone
    // who can read the channel, including members who never linked, so the right
    // view is the unlinked one. No `q` and no `location` means none of the echo
    // checks the interactive paths need apply here.
    const data = await fetchSessions(null, 1);
    const { payload, fingerprint } = boardPayload(data);

    if (data.sessions.length === 0 && !state?.messageId) {
      // NOT POSTED. handleSessionPost's argument, verbatim: a public "no sessions
      // are open" reads as the club announcing it has cancelled everything.
      result.skipped += 1;
      return result;
    }

    if (state?.messageId) {
      if (state.fingerprint === fingerprint) {
        // No Discord call and no write. This is the branch that runs 287 times a
        // day, and an "(edited)" marker appearing on every tick is how a reader
        // discovers something clock derived crept into the render.
        result.unchanged += 1;
        return result;
      }

      // The empty schedule ends up here too, editing the board to its explicit
      // empty state. Leaving the last render up would be worse: those rows are
      // absolute timestamps that quietly become a list of nights that already
      // happened. An empty answer is trustworthy because the route 502s on a read
      // error and reports an empty schedule only when it genuinely is one.
      const outcome = await api.editMessage(channelId, state.messageId, payload);

      if (outcome === 'ok') {
        await writeSessionBoard({ ...state, fingerprint, pending: false });
        result.edited += 1;
        return result;
      }
      if (outcome === 'gone') {
        // Somebody deleted it. Forget the message and KEEP THE COUNTERS, then
        // stop: the repost is the next tick's job, five minutes from now, which
        // keeps the two concerns apart and puts a floor under the loop a channel
        // that auto-deletes would otherwise create.
        console.log('[bot] session board: message is gone, will repost on the next tick');
        await writeSessionBoard(clearMessage(state));
        result.stale += 1;
        return result;
      }
      // 'failed': write nothing, so the next tick retries against the same
      // fingerprint. A stored fingerprint that is stale costs one redundant
      // identical edit per tick until a write lands, and never a second board.
      result.failed += 1;
      return result;
    }

    // ---- the post path -----------------------------------------------------

    const now = new Date();
    let reposts = state?.reposts ?? 0;
    let repostWindowStart = state?.repostWindowStart ?? null;
    // A repost is any post made when a board has been posted before, which is
    // exactly what the surviving state row records.
    const isRepost = state !== null;

    if (isRepost) {
      const startedAt = repostWindowStart ? Date.parse(repostWindowStart) : NaN;
      if (!Number.isFinite(startedAt) || now.getTime() - startedAt > REPOST_WINDOW_MS) {
        reposts = 0;
        repostWindowStart = now.toISOString();
      }
      if (reposts >= MAX_REPOSTS_PER_DAY) {
        console.error(
          `[bot] session board: ${reposts} reposts to ${channelId} in 24h, ` +
            'refusing more. Something is deleting the board.'
        );
        result.suppressed += 1;
        return result;
      }
    }

    // THE PENDING MARKER GOES DOWN FIRST, and if it cannot be written the post
    // does not happen. A crash between this write and the one below leaves
    // `pending` with no id, which the branch above refuses: a stuck board, never
    // a duplicate one.
    const pendingState: SessionBoardState = {
      channelId,
      messageId: null,
      pending: true,
      fingerprint: null,
      postedAt: now.toISOString(),
      reposts,
      repostWindowStart: repostWindowStart ?? now.toISOString(),
    };
    try {
      await writeSessionBoard(pendingState);
    } catch (error) {
      console.error('[bot] session board: could not mark a post as pending:', error);
      result.failed += 1;
      return result;
    }

    const posted = await api.postMessageResult(channelId, payload);

    if (posted === 'refused') {
      // Discord created nothing: no permission, no channel, or a payload it will
      // not take. Clear the marker, PRESERVE the counters, and let the next tick
      // try again. The channel id is logged so "the bot cannot post there" is
      // diagnosable without a database read.
      //
      // A refusal does not count against MAX_REPOSTS_PER_DAY: the cap guards
      // against CREATING boards, and this created none. So a channel that
      // always refuses retries every tick rather than going quiet, which is the
      // shape the runbook's staging note describes.
      console.error(`[bot] session board: Discord refused a post to ${channelId}`);
      await writeSessionBoard({ ...pendingState, pending: false });
      result.refused += 1;
      return result;
    }
    if (posted === 'unknown') {
      // It may have landed. The marker STAYS, so the next tick refuses rather
      // than risking a second board.
      console.error(
        `[bot] session board: a post to ${channelId} may or may not have landed; left pending`
      );
      result.failed += 1;
      return result;
    }

    try {
      await writeSessionBoard({
        ...pendingState,
        messageId: posted.id,
        pending: false,
        fingerprint,
        reposts: isRepost ? reposts + 1 : reposts,
      });
    } catch (error) {
      // The board is up and nothing knows its id. Logged at error because the
      // outcome is a stuck board the next tick will refuse to duplicate, and
      // clearing the setting is the way out.
      console.error('[bot] session board: posted but could not record it:', error);
    }
    result.posted += 1;
    return result;
  } finally {
    boardInFlight = false;
  }
}
