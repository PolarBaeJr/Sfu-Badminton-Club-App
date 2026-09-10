'use client';

import { useState } from 'react';
import { Button, Badge, Input, Select, Textarea, Switch } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import { queueDiscordMessage } from '@/lib/actions/discord-message';
import { TYPE_OPTIONS, type AnnouncementType } from './announcement-shape';
import { DiscordPreview } from './discord-preview';

// Speaking as the club in Discord, from the console.
//
// THE SAME ACT AS /say, AND IT SAYS SO. An exec running the slash command in
// Discord gets an ephemeral reply telling them the message shows as coming from
// the bot and that the audit channel has a copy with their name on it. Somebody
// pressing Send here is doing exactly that and deserves exactly that warning.

const MICRO = 'font-mono text-[10px] uppercase tracking-[0.16em]';

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
}: {
  /** Whether /config has been run. Without it there is nowhere to send. */
  channelConfigured: boolean;
}) {
  const [shape, setShape] = useState<'message' | 'embed'>('message');
  const [content, setContent] = useState('');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [type, setType] = useState<AnnouncementType>('info');
  const [channelId, setChannelId] = useState('');
  const [ping, setPing] = useState(false);
  const [busy, setBusy] = useState(false);
  const { toast } = useToast();

  const ready =
    shape === 'message' ? content.trim().length > 0 : title.trim().length > 0;

  const send = async () => {
    if (!ready || busy) return;
    setBusy(true);
    try {
      await queueDiscordMessage({
        ...(shape === 'message'
          ? { content: content.trim() }
          : { embed: { title: title.trim(), body: body.trim(), type } }),
        ...(channelId.trim() ? { channelId: channelId.trim() } : {}),
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
          className="min-h-[120px]"
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
            className="min-h-[120px]"
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

      <Input
        label="Channel ID (optional)"
        value={channelId}
        onChange={(e) => setChannelId(e.target.value)}
        placeholder={
          channelConfigured
            ? 'Leave blank for the announcements channel'
            : 'Required — no announcements channel is configured'
        }
      />
      <p className="text-xs text-[var(--text-muted)] -mt-1 leading-relaxed">
        {/* The console has never been told the name of a Discord channel, so it
            cannot offer a picker. Saying how to get the ID is the honest
            alternative to a dropdown that would be empty. */}
        Turn on Developer Mode in Discord, right-click a channel and choose Copy Channel ID.
      </p>

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
          channelConfigured={channelConfigured || channelId.trim().length > 0}
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
