'use client';

import { useState } from 'react';
import { Button, Badge, Input, Select, Textarea, Switch } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import { queueDiscordMessage } from '@/lib/actions/discord-message';
import {
  TYPE_OPTIONS,
  type AnnouncementType,
  type DiscordChannelOption,
} from './announcement-shape';
import { DiscordPreview } from './discord-preview';

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

export interface OutboxRow {
  id: string;
  createdAt: string;
  channelId: string;
  preview: string;
  ping: boolean;
  state: 'queued' | 'sent' | 'failed';
  error: string | null;
}

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

export function DiscordSend({
  channelConfigured,
  channels,
  roleNames,
}: {
  /** Whether /config has been run. Without it there is nowhere to send. */
  channelConfigured: boolean;
  /** The channels the club has wired to a relay. Not the server's channel list. */
  channels: DiscordChannelOption[];
  /** The role names a mention can name. Ids stay on the server; see the hint. */
  roleNames: string[];
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
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

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

  // Choosing to paste and then pasting nothing is now an incomplete form rather
  // than a shorthand. Nothing is lost by refusing it: "leave it blank for the
  // announcements channel" is its own entry in the picker above.
  const ready =
    (shape === 'message' ? content.trim().length > 0 : title.trim().length > 0) &&
    (channelChoice !== CHANNEL_CUSTOM || channelId.trim().length > 0);

  const send = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      await queueDiscordMessage({
        ...(shape === 'message'
          ? { content: content.trim() }
          : { embed: { title: title.trim(), body: body.trim(), type } }),
        // A PICKED CHANNEL GOES DOWN THE PATH A PASTED ONE ALREADY USES, and
        // the action needs no new parameter for it: it is a channel id either
        // way, checked by the same `assertChannelId`. A `channelKey` parameter
        // would be a second client-controlled POST field duplicating one that is
        // already there, which is exactly what that file's own comment warns off.
        ...(chosenChannel ? { channelId: chosenChannel } : {}),
        ping,
      });
      // "Queued", never "Sent". The bot has not been asked yet — pg_cron will
      // ask it, within five minutes — and the list below is where the real
      // answer appears.
      toast('Queued for Discord — it posts within five minutes', 'success');
      setContent('');
      setTitle('');
      setBody('');
      setPing(false);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Could not queue that', 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex items-center justify-between">
        <span className={`${MICRO} text-[var(--mute)]`}>Say something in Discord</span>
        {ping && <Badge variant="danger">PINGS</Badge>}
      </div>

      <Select
        label="Shape"
        value={shape}
        onChange={(e) => setShape(e.target.value as 'message' | 'embed')}
        options={SHAPE_OPTIONS}
      />

      {shape === 'message' ? (
        <Textarea
          label="Message"
          // Room to write a Code of Conduct in, and a grab handle for when that
          // is still not enough. `resize-y` overrides the shared component's
          // `resize-none`, which stays as it is because a dozen other forms rely
          // on it; `cn` is twMerge, so the later class here wins.
          className="min-h-[320px] resize-y"
          value={content}
          onChange={(e) => setContent(e.target.value)}
          // Discord's own cap, enforced here where the writer can still see and
          // cut what they typed — not as a 400 after the words are gone.
          maxLength={2000}
          placeholder="Posted exactly as typed, as the bot. Nobody sees that you sent it."
        />
      ) : (
        // EXPLICIT IDS, because these three labels are word-for-word the ones
        // the website composer uses and both composers are now mounted at once
        // in the same card. Input/Textarea/Select derive the element id (and the
        // label's htmlFor) from the label text, so without these the embed
        // branch collides with AnnouncementFields on headline, body and
        // category — two elements sharing an id, and a label pointing at
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
          <Textarea
            id="discord-body"
            label="Body"
            // 4096 characters allowed below, so this one needs MORE room than
            // the plain message, not less.
            className="min-h-[320px] resize-y"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            maxLength={4096}
          />
          <Select
            id="discord-category"
            label="Category"
            value={type}
            onChange={(e) => setType(e.target.value as AnnouncementType)}
            options={TYPE_OPTIONS}
          />
        </>
      )}

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
            Turn on Developer Mode in Discord, right-click a channel and choose Copy Channel ID.
          </p>
        </>
      )}

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

      {shape === 'message' && roleNames.length > 0 && (
        <p className="text-xs text-[var(--text-muted)] -mt-1 leading-relaxed">
          {/* THE VOCABULARY, BEFORE THEY TYPE IT rather than after they send it.
              Three of these names (internal, external, competitive) are ordinary
              English words, so "email us @external" really does ping a role once
              the switch above is on, and seeing the list is what makes that
              predictable. The list is only the roles the app manages: a member's
              own ping role lives in `discord_self_roles` (00168), whose trigger
              guarantees the two sets never overlap, so `@somepingrole` stays
              literal text. */}
          Type an @ and a role name to mention it: {roleNames.join(', ')}. Underscores or spaces
          both work. Anything else after an @ stays plain text.
        </p>
      )}

      {shape === 'embed' && (
        <p className="text-xs text-[var(--text-muted)] -mt-1 leading-relaxed">
          {/* Stated here because the plain-message branch above promises the
              opposite. The reasoning is in lib/actions/discord-message.ts. */}
          Role names are not turned into mentions inside an embed, because Discord never notifies
          anybody from embed text.
        </p>
      )}

      {/* The embed shape gets the same preview the composer does, from the same
          code — that is the whole reason the preview lives in shared. A plain
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
        />
      )}

      <Button
        type="button"
        variant="primary"
        className="min-h-[44px]"
        disabled={!ready || busy}
        onClick={send}
      >
        {busy ? 'Queueing…' : 'Send to Discord'}
      </Button>

      <p className={`${MICRO} text-[var(--text-muted)] leading-relaxed`}>
        It shows as coming from the bot, not from you. The audit log has a copy with your name
        on it, and so does the Discord audit channel.
      </p>
    </div>
  );
}

// WHY THERE IS A STATE LIST UNDERNEATH RATHER THAN JUST A TOAST. This does not
// post the message — it queues a row the bot drains on the announcements tick,
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
export function DiscordRecent({ recent }: { recent: OutboxRow[] }) {
  return (
    <div className="flex flex-col gap-2">
      <span className={`${MICRO} text-[var(--mute)]`}>Recently sent to Discord</span>
      {recent.map((row) => {
        const badge = stateBadge(row);
        return (
          <div key={row.id} className="flex flex-col gap-1">
            <div className="flex items-center gap-2">
              <Badge variant={badge.variant}>{badge.label}</Badge>
              <span className={`${MICRO} text-[var(--mute)]`}>{shortTime(row.createdAt)}</span>
              {row.ping && <Badge variant="danger">PINGED</Badge>}
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
