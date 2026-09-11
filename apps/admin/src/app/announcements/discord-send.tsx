'use client';

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Button, Badge, Checkbox, Input, Select, Textarea, Switch } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import {
  editDiscordMessage,
  loadDiscordMessage,
  queueDiscordMessage,
  readDiscordOutbox,
} from '@/lib/actions/discord-message';
import {
  OUTBOX_POLL_LIMIT_MS,
  OUTBOX_POLL_MS,
  shouldPollOutbox,
  type OutboxRow,
} from '@/lib/discord-outbox';
import {
  TYPE_OPTIONS,
  type AnnouncementType,
  type DiscordChannelOption,
  type DiscordRoleOption,
} from './announcement-shape';
import { useDiscordConsole } from './discord-console-context';
import { DiscordPreview } from './discord-preview';
import { FormatBar, formatShortcut } from './format-bar';

// Speaking as the club in Discord, from the console.
//
// THE SAME ACT AS /say, AND IT SAYS SO. An exec running the slash command in
// Discord gets an ephemeral reply telling them the message shows as coming from
// the bot and that the audit channel has a copy with their name on it. Somebody
// pressing Send here is doing exactly that and deserves exactly that warning.

const MICRO = 'font-mono text-[10px] uppercase tracking-[0.16em]';

// The two picker entries that are not a channel id.
//
// Neither can ever collide with a real value: the action's `assertChannelId`
// takes `^[0-9]{5,25}$` and nothing else, so an empty string and the word
// `custom` are both unmistakable. The empty string is the default on purpose,
// because sending no `channelId` at all is what makes the action fall through
// to the configured announcements channel.
const CHANNEL_DEFAULT = '';
const CHANNEL_CUSTOM = 'custom';

const SHAPE_OPTIONS = [
  { value: 'message', label: 'Plain message' },
  { value: 'embed', label: 'Embed' },
];

/** One line each, in the club's words rather than the column's. */
function stateBadge(row: OutboxRow): { variant: 'success' | 'warning' | 'danger'; label: string } {
  if (row.state === 'sent') return { variant: 'success', label: 'SENT' };
  if (row.state === 'failed') return { variant: 'danger', label: 'FAILED' };
  return { variant: 'warning', label: 'QUEUED' };
}

function shortTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString('en-CA', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

// A LONG DOCUMENT SHOULD LOOK LIKE ONE.
//
// The Code of Conduct runs to dozens of lines, and a fixed box turns it into a
// letterbox with a scrollbar of its own inside a page that already scrolls.
// Growing the element to fit its content means the page scrolls once, where the
// reader expects it to, and the whole text is visible on the way past.
//
// `height = 'auto'` FIRST, every time. scrollHeight reports the content height
// only while the element is not already tall enough to hide it, so without the
// collapse the box can grow and then never shrink back after a deletion.
function useAutoGrow(value: string) {
  const ref = useRef<HTMLTextAreaElement>(null);

  const fit = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);

  // A layout effect rather than a plain one: this runs after React writes the
  // DOM and before the browser paints, so the box is never briefly the wrong
  // size. It shows most when Edit fills the composer with an existing message,
  // where a plain effect would flash the letterbox first.
  useLayoutEffect(fit, [value, fit]);

  // Re-wrapping changes the line count without changing the value, so a window
  // resize needs a pass of its own or the box is left clipped or padded out.
  useEffect(() => {
    window.addEventListener('resize', fit);
    return () => window.removeEventListener('resize', fit);
  }, [fit]);

  return ref;
}

export function DiscordSend({
  channelConfigured,
  channels,
  roles,
}: {
  /** Whether /config has been run. Without it there is nowhere to send. */
  channelConfigured: boolean;
  /** The channels the club has wired to a relay. Not the server's channel list. */
  channels: DiscordChannelOption[];
  /**
   * The roles a mention can name.
   *
   * THE PICKER STILL SENDS NAMES, not the ids beside them.
   * `QueueDiscordMessageInput.pingRoles` takes names and `resolveRoleNames`
   * turns them into ids server-side, so posting an id from here would add a
   * client-controlled snowflake field for a job already being done. The id is
   * carried for the preview, which needs it to draw a chip.
   */
  roles: DiscordRoleOption[];
}) {
  const [shape, setShape] = useState<'message' | 'embed'>('message');
  const [content, setContent] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [type, setType] = useState<AnnouncementType>('info');
  const [channelId, setChannelId] = useState('');
  // `Select` renders exactly the options it is handed and has no placeholder
  // support, so "the announcements channel" has to be a real entry rather than
  // an empty field. When no announcements channel is configured that entry is
  // not offered at all, and the picker opens on the paste box instead: an option
  // the action would refuse is worse than no option.
  const [channelChoice, setChannelChoice] = useState(
    channels.some((c) => c.key === 'announcement_channel_id') ? CHANNEL_DEFAULT : CHANNEL_CUSTOM,
  );
  const [ping, setPing] = useState(false);
  /** The roles a ping line above an embed names. Picking one IS the opt-in. */
  const [pingRoles, setPingRoles] = useState<string[]>([]);
  /** The message being edited, or null when this is a fresh one. */
  const [editingId, setEditingId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();
  const { pending, clearEdit, refreshRecent } = useDiscordConsole();

  // One per box rather than one shared. Only ever one is mounted, since they
  // sit in opposite branches of the shape, but each hook tracks the value it is
  // sizing against and the two values are separate pieces of state.
  const contentRef = useAutoGrow(content);
  const bodyRef = useAutoGrow(body);

  // FILLING THE COMPOSER FROM THE ROW SOMEBODY PRESSED EDIT ON. The list below
  // reads the message and hands it over; this is where it lands. The shape
  // comes from the row rather than from what is on screen, because a message
  // cannot change between plain text and an embed once Discord has it.
  useEffect(() => {
    if (!pending) return;
    setEditingId(pending.id);
    if (pending.embedTitle !== null) {
      setShape('embed');
      setTitle(pending.embedTitle);
      setBody(pending.embedBody ?? '');
      setType((pending.embedType as AnnouncementType | null) ?? 'info');
    } else {
      setShape('message');
      setContent(pending.content ?? '');
    }
  }, [pending]);

  const editing = editingId !== null;

  const channelOptions = [
    ...(channels.some((c) => c.key === 'announcement_channel_id')
      ? [{ value: CHANNEL_DEFAULT, label: 'Announcements (default)' }]
      : []),
    // The announcements channel is excluded here so it cannot appear twice
    // meaning the same thing: once as the default and once under its own name.
    ...channels
      .filter((c) => c.key !== 'announcement_channel_id')
      .map((c) => ({ value: c.id, label: c.label })),
    // ALWAYS LAST AND ALWAYS PRESENT, even when all six settings are filled in.
    // The picker only knows the channels a relay posts into, and the rest of the
    // server is reachable no other way.
    { value: CHANNEL_CUSTOM, label: 'Paste a channel ID...' },
  ];

  /** What goes down the wire. Empty means "the action picks the default". */
  const chosenChannel = channelChoice === CHANNEL_CUSTOM ? channelId.trim() : channelChoice;

  /** Whether a channel can be resolved at all, which the preview asks about. */
  const channelResolvable =
    channelChoice === CHANNEL_CUSTOM
      ? channelId.trim().length > 0
      : channelChoice !== CHANNEL_DEFAULT || channelConfigured;

  /**
   * Whether pressing the button buzzes a phone.
   *
   * AN EDIT NEVER DOES, whatever the row was sent with: Discord does not
   * re-notify anybody when a message changes. So the badge goes quiet in edit
   * mode rather than promising something that cannot happen.
   */
  const willPing = editing ? false : shape === 'message' ? ping : pingRoles.length > 0;

  // Choosing to paste and then pasting nothing is now an incomplete form rather
  // than a shorthand. Nothing is lost by refusing it: "leave it blank for the
  // announcements channel" is its own entry in the picker above.
  const ready =
    (shape === 'message' ? content.trim().length > 0 : title.trim().length > 0) &&
    (editing || channelChoice !== CHANNEL_CUSTOM || channelId.trim().length > 0);

  /** Back to a fresh compose, from either a save or a cancel. */
  const clearComposer = () => {
    setContent('');
    setTitle('');
    setBody('');
    setPing(false);
    setPingRoles([]);
    setEditingId(null);
    clearEdit();
  };

  const send = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      const words =
        shape === 'message'
          ? { content: content.trim() }
          : { embed: { title: title.trim(), body: body.trim(), type } };

      if (editingId) {
        await editDiscordMessage({ id: editingId, ...words });
        // Same five minute window as a send, because an edit is a re-queue: the
        // bot picks the row up on the next announcements tick and PATCHes the
        // message that is already in the channel.
        toast('Saved. Discord catches up within five minutes', 'success');
      } else {
        await queueDiscordMessage({
          ...words,
          // A PICKED CHANNEL GOES DOWN THE PATH A PASTED ONE ALREADY USES, and
          // the action needs no new parameter for it: it is a channel id either
          // way, checked by the same `assertChannelId`. A `channelKey` parameter
          // would be a second client-controlled POST field duplicating one that is
          // already there, which is exactly what that file's own comment warns off.
          ...(chosenChannel ? { channelId: chosenChannel } : {}),
          ...(shape === 'embed' && pingRoles.length > 0 ? { pingRoles } : {}),
          ping,
        });
        // "Queued", never "Sent". The bot has not been asked yet, pg_cron will
        // ask it within five minutes, and the list below is where the real
        // answer appears.
        toast('Queued for Discord: it posts within five minutes', 'success');
      }
      // CLEARED INCLUDING `editingId`, or the next fresh message would silently
      // overwrite the one that was just edited.
      clearComposer();
      // One immediate read, so the new or re-queued row is on screen now rather
      // than on the list's next tick.
      refreshRecent();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not queue that', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex items-center justify-between">
        <span className={`${MICRO} text-[var(--mute)]`}>
          {editing ? 'Edit what Discord already has' : 'Say something in Discord'}
        </span>
        {willPing && <Badge variant="danger">PINGS</Badge>}
      </div>

      <Select
        label="Shape"
        value={shape}
        // FIXED WHILE EDITING. Discord's edit endpoint leaves a field it is not
        // sent standing, so a message that posted as plain text cannot become an
        // embed without the old line remaining above it.
        disabled={editing}
        onChange={(e) => {
          setShape(e.target.value as 'message' | 'embed');
          // THE PING CONTROLS ARE PER SHAPE AND THE STATE IS NOT. Without this,
          // switching to Embed after arming the switch leaves `ping` true and
          // lights the PINGS badge over a message that pings nobody, and
          // switching the other way would carry a picked role into a shape that
          // has no line to put it on.
          setPing(false);
          setPingRoles([]);
        }}
        options={SHAPE_OPTIONS}
      />

      {shape === 'message' ? (
        <div className="space-y-1">
          {/* The label is rendered here rather than through the component's own
              `label` prop so the formatting buttons can sit on the line beside
              it, which is where a toolbar belongs. The explicit id is what keeps
              htmlFor pointing at the right element once the prop is gone. */}
          <div className="flex flex-wrap items-end justify-between gap-2">
            <label
              htmlFor="discord-message"
              className="block text-[13px] font-medium text-[var(--text-secondary)]"
            >
              Message
            </label>
            <FormatBar target={contentRef} onChange={setContent} surface="message" />
          </div>
          <Textarea
            id="discord-message"
            ref={contentRef}
            // Room to write a Code of Conduct in, and it grows past that on its
            // own. `resize-y` is gone with the fixed height: a grab handle the
            // next keystroke overrules is worse than no grab handle. The
            // shared component's `resize-none` stays as it is because a dozen
            // other forms rely on it; `cn` is twMerge, so this className wins.
            className="min-h-[320px] overflow-hidden"
            value={content}
            onChange={(e) => setContent(e.target.value)}
            onKeyDown={(e) => formatShortcut(e, setContent)}
            // Discord's own cap, enforced here where the writer can still see
            // and cut what they typed, not as a 400 after the words are gone.
            maxLength={2000}
            placeholder="Posted exactly as typed, as the bot. Nobody sees that you sent it."
          />
        </div>
      ) : (
        // EXPLICIT IDS, because these three labels are word-for-word the ones
        // the website composer uses and both composers are now mounted at once
        // in the same card. Input/Textarea/Select derive the element id (and the
        // label's htmlFor) from the label text, so without these the embed
        // branch collides with AnnouncementFields on headline, body and
        // category: two elements sharing an id, and a label pointing at
        // whichever came first.
        <>
          <Input
            id="discord-headline"
            label="Headline"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            maxLength={256}
            placeholder="Say the thing in one line"
          />
          <div className="space-y-1">
            <div className="flex flex-wrap items-end justify-between gap-2">
              <label
                htmlFor="discord-body"
                className="block text-[13px] font-medium text-[var(--text-secondary)]"
              >
                Body
              </label>
              {/* Masked links are offered here and not on the plain message,
                  because [text](url) renders inside an embed and shows as raw
                  brackets anywhere else. */}
              <FormatBar target={bodyRef} onChange={setBody} surface="embed" />
            </div>
            <Textarea
              id="discord-body"
              ref={bodyRef}
              // 4096 characters allowed below, so this one needs MORE room than
              // the plain message, not less, and it grows past that on its own.
              className="min-h-[320px] overflow-hidden"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              onKeyDown={(e) => formatShortcut(e, setBody)}
              maxLength={4096}
            />
          </div>
          <Select
            id="discord-category"
            label="Category"
            value={type}
            onChange={(e) => setType(e.target.value as AnnouncementType)}
            options={TYPE_OPTIONS}
          />
        </>
      )}

      {/* WHERE IT WENT IS NOT EDITABLE. Discord cannot move a message between
          channels, so offering the picker here would promise something that
          cannot happen. */}
      {editing ? (
        <p className="text-xs text-[var(--text-muted)] leading-relaxed">
          It stays in the channel it was posted in, keeps its place in the conversation, and
          notifies nobody again. Editing never rings a phone.
        </p>
      ) : (
        <>
          {/* AN EXPLICIT ID, for the same reason the embed branch above carries
              three of them: both composers are mounted at once and Select derives
              its element id from the label text. */}
          <Select
            id="discord-channel"
            label="Channel"
            value={channelChoice}
            onChange={(e) => setChannelChoice(e.target.value)}
            options={channelOptions}
          />

          {channelChoice === CHANNEL_CUSTOM && (
            <>
              <Input
                id="discord-channel-id"
                label="Channel ID"
                value={channelId}
                onChange={(e) => setChannelId(e.target.value)}
                placeholder={
                  channelConfigured
                    ? 'Paste the channel ID'
                    : 'Required: no announcements channel is configured'
                }
              />
              <p className="text-xs text-[var(--text-muted)] -mt-1 leading-relaxed">
                {/* The picker lists the channels the club has wired to a relay, and
                    that is all this console can know: it holds no Discord token and
                    nothing in the database catalogues the server's channels. Every
                    other channel in the server is reached exactly one way, which is
                    this box. */}
                Turn on Developer Mode in Discord, right-click a channel and choose Copy Channel
                ID.
              </p>
            </>
          )}
        </>
      )}

      {/* THE SWITCH BELONGS TO THE PLAIN MESSAGE ALONE. In the embed shape it
          never did anything: the payload the bot builds for an embed has no
          content field, so there is nothing for allowed_mentions to act on. The
          embed's own control is the role picker below, and neither is offered
          in edit mode, where nothing can notify anybody. */}
      {shape === 'message' && !editing && (
        <div className="flex flex-col border-y border-[var(--line)] py-3">
          <Switch
            label="Let mentions notify people"
            description={
              // Both directions stated, because the default is the quiet one and
              // somebody who wants a ping needs to know it is off.
              ping
                ? 'An @everyone or @role in the text WILL buzz every phone it names. This cannot be taken back.'
                : 'Off: @everyone and @role in the text read as mentions but notify nobody.'
            }
            checked={ping}
            onChange={setPing}
          />
        </div>
      )}

      {/* THE PING LINE, which is the only way an embed reaches a phone. A
          mention inside embed text can never notify anybody, so the roles
          picked here go on a line of ordinary content ABOVE the embed, in the
          same message. Picking one is the whole opt-in: there is no second
          switch to arm and nothing to confirm. */}
      {shape === 'embed' && !editing && roles.length > 0 && (
        <div className="flex flex-col gap-2 border-y border-[var(--line)] py-3">
          <span className={`${MICRO} text-[var(--mute)]`}>Notify</span>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {roles.map((role) => (
              <Checkbox
                key={role.name}
                label={role.name}
                showLabel
                checked={pingRoles.includes(role.name)}
                onChange={(checked) =>
                  setPingRoles((current) =>
                    checked ? [...current, role.name] : current.filter((r) => r !== role.name),
                  )
                }
              />
            ))}
          </div>
          <p className="text-xs text-[var(--text-muted)] leading-relaxed">
            {pingRoles.length > 0
              ? 'Anyone in these roles gets a notification. Their names go on a line above the embed.'
              : 'Nobody is notified.'}
          </p>
        </div>
      )}

      {roles.length > 0 && (
        <p className="text-xs text-[var(--text-muted)] -mt-1 leading-relaxed">
          {/* THE VOCABULARY, BEFORE THEY TYPE IT rather than after they send it.
              Three of these names (internal, external, competitive) are ordinary
              English words, so "email us @external" really does ping a role once
              the switch above is on, and seeing the list is what makes that
              predictable. The list is only the roles the app manages: a member's
              own ping role lives in `discord_self_roles` (00168), whose trigger
              guarantees the two sets never overlap, so `@somepingrole` stays
              literal text. */}
          Type an @ and a role name to mention it: {roles.map((r) => r.name).join(', ')}.
          Underscores or spaces both work. Anything else after an @ stays plain text.
        </p>
      )}

      {shape === 'embed' && (
        <p className="text-xs text-[var(--text-muted)] -mt-1 leading-relaxed">
          {/* Stated here because the plain-message branch promises a ping and
              this shape cannot give one from its body. The reasoning is in
              lib/actions/discord-message.ts. */}
          Role names in the body become blue role chips, so a reader can hover one and see who it
          is. A chip inside an embed never notifies anybody.
        </p>
      )}

      {/* The embed shape gets the same preview the composer does, from the same
          code, which is the whole reason the preview lives in shared. A plain
          message has nothing to preview: it is posted exactly as typed. */}
      {shape === 'embed' && title.trim() && (
        <DiscordPreview
          title={title}
          body={body}
          type={type}
          // An outbox message is not an announcement: it has no audience rule
          // and no expiry, and the bot posts it because a person asked. So the
          // relay-state line is fixed at the one true answer for this panel.
          targetAudience="all"
          expiresAt={null}
          status="published"
          // "A channel is resolvable", which is now three cases rather than
          // two: the default picked and configured, a named channel picked, or
          // something pasted.
          channelConfigured={channelResolvable}
          url={null}
          posted={null}
          updatedAt={null}
          roles={roles}
          // TRUE HERE AND FALSE ON THE WEBSITE COMPOSER. This body goes through
          // `resolveForDiscord` on its way out, so `@executives` really does
          // reach Discord as a chip and a preview that drew grey text would be
          // lying about the thing it exists to show.
          resolvesRoleNames
        />
      )}

      <Button
        type="button"
        variant="primary"
        className="min-h-[44px]"
        disabled={!ready || busy}
        onClick={send}
      >
        {busy ? (editing ? 'Saving…' : 'Queueing…') : editing ? 'Save edit' : 'Send to Discord'}
      </Button>

      {editing && (
        <Button type="button" variant="ghost" className="min-h-[44px]" onClick={clearComposer}>
          Cancel
        </Button>
      )}

      <p className={`${MICRO} text-[var(--text-muted)] leading-relaxed`}>
        It shows as coming from the bot, not from you. The audit log has a copy with your name
        on it, and so does the Discord audit channel.
      </p>
    </div>
  );
}

// WHY THERE IS A STATE LIST UNDERNEATH RATHER THAN JUST A TOAST. This does not
// post the message. It queues a row the bot drains on the announcements tick,
// so Send means "within five minutes". A toast saying "Sent" would be a lie for
// most of that window, and the failure mode it hides is the one that matters: a
// channel the bot cannot post in fails silently five minutes after the person
// who could fix it has closed the tab.
//
// AND WHY IT LIVES OUTSIDE THE COMPOSER, in its own card rather than inside
// this one: the card above now switches between the website composer and the
// Discord one, and a queued row that is about to fail must not be hidden by
// somebody going back to write a website post. The failure has to stay on
// screen in both modes, because it is the only place it is ever visible.
//
// AND WHY IT ASKS AGAIN BY ITSELF. The row it shows changes five minutes after
// it is written, in another process, which means the badge on screen is a
// photograph of a queue rather than the queue. Somebody who has just pressed
// Send is the one person watching, and telling them to reload the page to find
// out whether the club's message went out is telling them to do the polling by
// hand.
export function DiscordRecent({ recent }: { recent: OutboxRow[] }) {
  // SEEDED FROM THE SERVER, THEN OWNED HERE. The first paint is the page's own
  // read, so there is no empty list and no flash; from mount on, this component
  // is the one that decides what these five rows say.
  const [rows, setRows] = useState<OutboxRow[]>(recent);
  const [opening, setOpening] = useState<string | null>(null);
  const { startEdit, nudge } = useDiscordConsole();
  const { toast } = useToast();

  const polling = shouldPollOutbox(rows);

  // ONE READ AFTER A SEND OR AN EDIT, rather than waiting up to four seconds
  // for a row that is already known to exist.
  useEffect(() => {
    if (nudge === 0) return;
    let live = true;
    readDiscordOutbox()
      .then((next) => {
        if (live) setRows(next);
      })
      // SILENT. A blip while somebody watches a queued row must not take the
      // list off the screen or put an error over it.
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [nudge]);

  // THE POLL EXISTS ONLY WHILE SOMETHING IS QUEUED, which is the normal case
  // for about five minutes a week. `polling` is a boolean, so this effect is
  // not re-created while it stays true and `startedAt` measures one continuous
  // run of queued rows rather than restarting on every tick.
  useEffect(() => {
    if (!polling) return;
    let live = true;
    const startedAt = Date.now();
    const timer = setInterval(() => {
      // BOUNDED. A row that is genuinely stuck must not poll a tab somebody
      // left open all night. It stops quietly, leaving the last known state on
      // screen, because a message saying "we gave up asking" would be less
      // useful than the badge already there.
      if (Date.now() - startedAt > OUTBOX_POLL_LIMIT_MS) {
        clearInterval(timer);
        return;
      }
      readDiscordOutbox()
        .then((next) => {
          // A response that lands after this component is gone must not set
          // state, and one that lands after the timer was cleared is stale.
          if (live) setRows(next);
        })
        .catch(() => {});
    }, OUTBOX_POLL_MS);

    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [polling]);

  const openForEdit = async (row: OutboxRow) => {
    if (opening) return;
    setOpening(row.id);
    try {
      const message = await loadDiscordMessage(row.id);
      startEdit({
        id: message.id,
        content: message.content,
        embedTitle: message.embedTitle,
        embedBody: message.embedBody,
        embedType: message.embedType,
      });
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not open that message', 'error');
    } finally {
      setOpening(null);
    }
  };

  return (
    <div className="flex flex-col gap-2">
      <span className={`${MICRO} text-[var(--mute)]`}>Recently sent to Discord</span>
      {rows.map((row) => {
        const badge = stateBadge(row);
        return (
          <div key={row.id} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <Badge variant={badge.variant}>{badge.label}</Badge>
              <span className={`${MICRO} text-[var(--mute)]`}>{shortTime(row.createdAt)}</span>
              {row.ping && <Badge variant="danger">PINGED</Badge>}
              {/* EDIT IS OFFERED ON A ROW DISCORD HAS SEEN, and that is not the
                  same as a sent one: saving an edit re-queues the row, so the
                  badge beside this button reads QUEUED for up to five minutes
                  while the message is still very much in the channel. Gating on
                  the badge would take the button away from the one person who
                  has just noticed a second typo. */}
              {row.discordMessageId && (
                <button
                  type="button"
                  onClick={() => openForEdit(row)}
                  disabled={opening !== null}
                  className={`${MICRO} ml-auto text-[var(--ink-2)] hover:text-[var(--ink)] underline underline-offset-2 disabled:opacity-50`}
                >
                  {opening === row.id ? 'Opening…' : 'Edit'}
                </button>
              )}
            </div>
            <span className="text-xs text-[var(--text-secondary)] break-words">
              {row.preview}
            </span>
            {row.error && (
              // Discord's own words. The person who can fix a missing
              // permission is the one reading this, and paraphrasing the
              // error would take away the only clue they have.
              <span className="text-xs text-[var(--red)] break-words">{row.error}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}
