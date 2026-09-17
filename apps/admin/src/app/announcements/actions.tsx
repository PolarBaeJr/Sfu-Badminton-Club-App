'use client';

import { useEffect, useRef, useState } from 'react';
import { Button, Badge, Dialog, Input, Select, Textarea, Switch, DatePicker } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import {
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
} from '@/lib/actions';
import {
  AUDIENCE_OPTIONS,
  TYPE_OPTIONS,
  type AnnouncementStatus,
  type AnnouncementType,
  type PostedMapping,
  type TargetAudience,
} from './announcement-shape';
// NO CYCLE. `discord-console-context` imports leaf types from
// `announcement-shape` and nothing from this file, which is why the pending
// website edit declares the row's fields there rather than importing
// `RowAnnouncement` from here.
import { useDiscordConsole, type PendingWebsiteEdit } from './discord-console-context';
import { DiscordPreview } from './discord-preview';
import { FormatBar, formatShortcut } from './format-bar';

/**
 * Everything the Discord preview needs that comes off the server rather than
 * out of the form, threaded down from the page so the composer and the edit
 * dialog answer the same question the same way.
 *
 * Null for a viewer on a club that has never set the relay up — the preview
 * still draws the embed, and simply says nothing is configured to receive it.
 */
export interface DiscordContext {
  channelConfigured: boolean;
  /** What the relay links the embed title to. */
  announcementsUrl: string | null;
}

// ---------------------------------------------------------------------------
// Shared form state
// ---------------------------------------------------------------------------

interface AnnouncementFormData {
  title: string;
  body: string;
  type: AnnouncementType;
  target_audience: TargetAudience;
  pinned: boolean;
  send_push: boolean;
  expires_at: string;
  /** Evergreen (00085) rather than tied to the term being played. */
  all_seasons: boolean;
}

const EMPTY_FORM: AnnouncementFormData = {
  title: '',
  body: '',
  type: 'info',
  target_audience: 'all',
  pinned: false,
  send_push: false,
  expires_at: '',
  // Term-specific by default, which is what almost every post is — a court
  // closure, a fee deadline, a tournament call-out. Evergreen retires never,
  // so it has to be chosen deliberately.
  all_seasons: false,
};

/**
 * The two shapes 00085's CHECK allows, as a control a person can answer.
 * There is no third option, and no way to express "neither" or "both".
 */
const SCOPE_OPTIONS = [
  { value: 'term', label: 'This term only' },
  { value: 'evergreen', label: 'Every term' },
];

const MICRO = 'font-mono text-[10px] uppercase tracking-[0.16em]';

/** The composer's own hairline block: bounded above and below, nothing boxed. */
function SwitchBlock({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex flex-col border-y border-[var(--line)] py-3">{children}</div>
  );
}

// ---------------------------------------------------------------------------
// The fields both the composer and the edit dialog draw
// ---------------------------------------------------------------------------

function AnnouncementFields({
  form,
  setForm,
  idPrefix,
  pushReachable,
  showScope,
  discord,
  posted,
  status,
  updatedAt,
}: {
  form: AnnouncementFormData;
  setForm: React.Dispatch<React.SetStateAction<AnnouncementFormData>>;
  /**
   * Which of the two mountings this is, so the Body gets a unique element id.
   *
   * `Textarea` derives its element id (and the label's htmlFor) from the label
   * text, and this component used to be mounted TWICE at once whenever the edit
   * dialog was open: once in the composer and once in the dialog. A literal
   * `id="website-body"` would move the collision rather than remove it, so the
   * caller says which mounting it is.
   *
   * THE TWO ARE NO LONGER ON SCREEN TOGETHER. Edit now fills the composer in
   * place wherever there is one, and the dialog opens only for the viewer who
   * has no composer at all. The prop stays because that fallback still mounts
   * this component and still needs an id nothing else is using.
   *
   * The BODY only. The headline, category, audience and expiry fields already
   * collide with their edit-dialog twins on the label-derived id; that is
   * pre-existing and out of scope here.
   */
  idPrefix: 'new' | 'edit';
  /**
   * How many members a push would actually buzz, or null when the viewer may
   * not read the roster. Null hides the number and keeps the switch — the
   * toggle still works, only the count is withheld.
   */
  pushReachable: number | null;
  /**
   * Only when CREATING. updateAnnouncement deliberately does not move a post
   * between seasons, so offering the choice on the edit form would promise a
   * change that never happens.
   */
  showScope: boolean;
  /** null hides the Discord panel entirely — see DiscordContext. */
  discord: DiscordContext | null;
  /** The mapping row, when this announcement already has a Discord message. */
  posted: PostedMapping | null;
  /**
   * The status the preview should answer for. The composer passes 'published'
   * because that is what its primary button does; the edit dialog passes the
   * row's own, because editing a draft leaves it a draft.
   */
  status: AnnouncementStatus;
  /** null for something being written or saved now — the preview reads it as now. */
  updatedAt: string | null;
}) {
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const bodyId = `${idPrefix}-announcement-body`;
  // The adapter is load-bearing, and it is the one signature difference from
  // discord-send.tsx, which can hand `setContent` straight over: `applyFormat`
  // calls `commit` with the whole next string, not with an event.
  const setBody = (next: string) => setForm((f) => ({ ...f, body: next }));

  return (
    <div className="flex flex-col gap-[14px]">
      <Input
        label="Headline"
        value={form.title}
        onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
        placeholder="Say the thing in one line"
        required
      />

      <div className="space-y-1">
        {/* The label is rendered here rather than through the component's own
            `label` prop so the formatting buttons can sit on the line beside
            it, which is where a toolbar belongs. The explicit id is what keeps
            htmlFor pointing at the right element once the prop is gone, and the
            asterisk is copied from Textarea's own markup because dropping the
            `label` prop also drops the required marker this field has today. */}
        <div className="flex flex-wrap items-end justify-between gap-2">
          <label
            htmlFor={bodyId}
            className="block text-[13px] font-medium text-[var(--text-secondary)]"
          >
            Body<span className="text-[var(--color-accent)]"> *</span>
          </label>
          <FormatBar target={bodyRef} onChange={setBody} surface="website" />
        </div>
        <Textarea
          id={bodyId}
          ref={bodyRef}
          className="min-h-[180px]"
          value={form.body}
          onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
          onKeyDown={(e) => formatShortcut(e, setBody)}
          placeholder="Members read this on a phone, mid-session. Keep it to what changes for them."
          required
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-[14px]">
        <Select
          label="Category"
          value={form.type}
          onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as AnnouncementType }))}
          options={TYPE_OPTIONS}
        />
        <Select
          label="Audience"
          value={form.target_audience}
          onChange={(e) =>
            setForm((f) => ({ ...f, target_audience: e.target.value as TargetAudience }))
          }
          options={AUDIENCE_OPTIONS}
        />
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-[14px]">
        {showScope ? (
          <Select
            label="Visible in"
            value={form.all_seasons ? 'evergreen' : 'term'}
            onChange={(e) => setForm((f) => ({ ...f, all_seasons: e.target.value === 'evergreen' }))}
            options={SCOPE_OPTIONS}
          />
        ) : (
          <div />
        )}
        <DatePicker
          label="Stop showing on (optional)"
          value={form.expires_at}
          onChange={(v) => setForm((f) => ({ ...f, expires_at: v }))}
        />
      </div>

      {showScope && (
        <p className="text-xs text-[var(--text-muted)] -mt-1">
          A post about this term retires when the season does. Choose every term for standing
          information — the club rules, the door code, how to pay dues.
        </p>
      )}

      <SwitchBlock>
        <Switch
          label="Pin to the top of the feed"
          description="Pinned posts sit above everything else for every member."
          checked={form.pinned}
          onChange={(v) => setForm((f) => ({ ...f, pinned: v }))}
        />
        <Switch
          label="Send a push notification"
          description={
            pushReachable === null
              ? 'Members who turned push on for announcements will be buzzed.'
              : `Reaches ${pushReachable} member${pushReachable === 1 ? '' : 's'} who turned push on for announcements.`
          }
          checked={form.send_push}
          onChange={(v) => setForm((f) => ({ ...f, send_push: v }))}
        />
      </SwitchBlock>

      {/* Under the switches rather than beside the body, because it answers a
          question about the finished post — including the audience and the
          expiry, which are set further up. It updates as they are typed. */}
      {discord && (
        <DiscordPreview
          title={form.title}
          body={form.body}
          type={form.type}
          targetAudience={form.target_audience}
          expiresAt={form.expires_at || null}
          status={status}
          channelConfigured={discord.channelConfigured}
          url={discord.announcementsUrl}
          posted={posted}
          updatedAt={updatedAt}
          // NO ROLES AND NO RESOLUTION ON THIS PATH. The website relay
          // (apps/player/src/app/api/discord/announcements/route.ts) posts the
          // stored body byte for byte and imports nothing from
          // lib/discord-mentions, so `@executives` typed here reaches the channel
          // as grey text. Passing true would draw a chip nobody will ever see.
          roles={[]}
          resolvesRoleNames={false}
          // AND NO BUTTONS ON THIS PATH EITHER, for the same reason. A website
          // announcement is relayed by
          // apps/player/src/app/api/discord/announcements/route.ts, which knows
          // nothing about button sets and has no column to carry one: the
          // outbox is the only path that can.
          buttonSet={null}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Composer
// ---------------------------------------------------------------------------

/**
 * The NEW POST card's body. Rendered only for a viewer holding
 * `announcements.create.write` — the page makes that call, because a composer
 * whose Post button rejects at the server is a form that wasted somebody's
 * typing.
 *
 * There is no Schedule button. Nothing in the schema stores a future publish
 * time: `announcements` has created_at, updated_at and expires_at and no
 * third timestamp (00001:599-612), and `announcement_status` is exactly
 * draft|published (00001:596). A Schedule control would have had nowhere to
 * save what it collected.
 */
export function Composer({
  pushReachable,
  discord,
}: {
  pushReachable: number | null;
  discord: DiscordContext | null;
}) {
  const [form, setForm] = useState<AnnouncementFormData>(EMPTY_FORM);
  const [busy, setBusy] = useState<null | AnnouncementStatus>(null);
  /**
   * The posted row this composer is editing, or null for a fresh post.
   *
   * THE WHOLE OBJECT, not its id. The save needs `status`, because an edit must
   * leave a draft a draft, and the preview needs `posted`; a shared composer has
   * no row of its own to read either of them off.
   */
  const [editing, setEditing] = useState<PendingWebsiteEdit | null>(null);
  const [editReason, setEditReason] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();
  const { pendingWebsite, clearWebsiteEdit } = useDiscordConsole();

  // FILLING THE COMPOSER FROM THE ROW SOMEBODY PRESSED EDIT ON, the same shape
  // the Discord composer uses (discord-send.tsx:200-218). `pendingWebsite` alone
  // in the dependency list, deliberately and for the same reason that file and
  // composer-switch.tsx:65-67 both give: the object's IDENTITY is the signal, so
  // a second press on the same row refills, and nothing else is allowed to
  // re-run this over somebody's typing.
  useEffect(() => {
    if (!pendingWebsite) return;
    setEditing(pendingWebsite);
    setForm({
      title: pendingWebsite.title,
      body: pendingWebsite.body,
      type: pendingWebsite.type,
      target_audience: pendingWebsite.target_audience,
      pinned: pendingWebsite.pinned,
      send_push: pendingWebsite.send_push,
      expires_at: pendingWebsite.expires_at ?? '',
      // Carried only to satisfy the shared form shape. Editing never moves a
      // post between seasons, which is why the scope control is not drawn.
      all_seasons: false,
    });
    setEditReason('');
    // TO THE TOP OF THE COMPOSER, not to its middle like the two player-side
    // scrolls (leaderboard/leaderboard-client.tsx:424,
    // sessions/deep-link-scroll.tsx:13). Those centre a single table row. This
    // element is a whole form several screens tall, and centring it would push
    // the Editing header and the headline off the top of the window, which is
    // the half somebody who has just pressed Edit needs to see.
    rootRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }, [pendingWebsite]);

  // A live post has already been read by members, so changing it is audited and
  // takes an explanation. A draft has been said to nobody.
  const editingLive = editing?.status === 'published';

  const ready =
    form.title.trim().length > 0 &&
    form.body.trim().length > 0 &&
    // THE THIRD CLAUSE IS NOT COSMETIC. `updateAnnouncement` refuses an edit to
    // a published post with no reason (lib/actions/announcements.ts:193-197), so
    // without this the button is enabled and the save throws.
    (!editingLive || editReason.trim().length > 0);

  /** Back to a blank new post, from a save or a cancel. */
  const clearComposer = () => {
    setForm(EMPTY_FORM);
    // ALL OF IT, the way discord-send.tsx:327-337 clears all of its own. Nulling
    // the context alone would not do: the effect above early-returns on null, so
    // it never clears `editing`, and the next fresh post would silently
    // overwrite the row that was just edited.
    setEditing(null);
    setEditReason('');
    clearWebsiteEdit();
  };

  const submit = async (status: AnnouncementStatus) => {
    if (!ready || busy) return;
    setBusy(status);
    try {
      if (editing) {
        await updateAnnouncement(
          editing.id,
          {
            title: form.title.trim() || editing.title,
            body: form.body.trim() || editing.body,
            type: form.type,
            target_audience: form.target_audience,
            pinned: form.pinned,
            send_push: form.send_push,
            status,
            ...(form.expires_at ? { expires_at: form.expires_at } : {}),
          },
          editReason.trim(),
        );
        toast(
          status === 'published' && editing.status === 'draft'
            ? 'Posted to the club'
            : 'Announcement updated',
          'success',
        );
      } else {
        await createAnnouncement({
          title: form.title.trim(),
          body: form.body.trim(),
          type: form.type,
          target_audience: form.target_audience,
          pinned: form.pinned,
          send_push: form.send_push,
          status,
          all_seasons: form.all_seasons,
          ...(form.expires_at ? { expires_at: form.expires_at } : {}),
        });
        toast(status === 'published' ? 'Posted to the club' : 'Draft saved', 'success');
      }
      // NOTHING NUDGES THE LIST IN THE OTHER COLUMN, unlike the Discord composer.
      // Both writes end in revalidatePath('/announcements')
      // (lib/actions/announcements.ts:157 and 244), so the posted list is
      // server-rendered again on its own.
      clearComposer();
    } catch (err) {
      // THE SERVER'S OWN WORDS ON THE EDIT PATH, and the generic line on the
      // create one. `updateAnnouncement` throws ExpectedError text that IS the
      // explanation: "it was deleted while you were editing it. Nothing was
      // saved." A fixed "Failed to update" would drop the only account anybody
      // gets of where their typing went.
      if (editing) {
        toast(err instanceof Error ? err.message : 'Failed to update announcement', 'error');
      } else {
        toast(status === 'published' ? 'Failed to post' : 'Failed to save the draft', 'error');
      }
    } finally {
      setBusy(null);
    }
  };

  return (
    <div ref={rootRef} className="flex flex-col gap-[14px]">
      <div className="flex items-center justify-between gap-2">
        {/* `min-w-0 truncate` because the headline field above carries no length
            cap, unlike the Discord composer's, and this label repeats whatever
            was typed into it: without them a long title pushes the badge beside
            it out of the card. */}
        <span className={`${MICRO} min-w-0 truncate text-[var(--mute)]`}>
          {editing ? `Editing · ${editing.title}` : 'New post'}
        </span>
        {/* THE ROW'S OWN STATUS WHILE EDITING, where this used to be a fixed
            DRAFT. A live post under a DRAFT badge is not a cosmetic slip: it
            says the words on screen have reached nobody, which is the one thing
            about them that is certainly false. */}
        <Badge variant={editingLive ? 'success' : 'neutral'}>
          {editingLive ? 'PUBLISHED' : 'DRAFT'}
        </Badge>
      </div>

      <AnnouncementFields
        form={form}
        setForm={setForm}
        idPrefix="new"
        pushReachable={pushReachable}
        // ONLY WHEN CREATING. `updateAnnouncement` has no `all_seasons`
        // parameter at all (lib/actions/announcements.ts:176-185), so offering
        // the scope on an edit would promise a move between seasons that the
        // save never makes. The edit dialog below makes the same call.
        showScope={!editing}
        discord={discord}
        // The row's mapping while editing. On a fresh post there is nothing to
        // be mapped to and nothing to be stale: that row does not exist until
        // one of the buttons below is pressed.
        posted={editing?.posted ?? null}
        // 'published' ON A NEW POST, because the preview answers "what happens
        // when this goes out" and previewing the draft path would only ever say
        // that drafts are not relayed, which Save draft already means. While
        // editing it is the row's own status, because editing a draft leaves it
        // a draft.
        status={editing ? editing.status : 'published'}
        updatedAt={null}
      />

      {editingLive && (
        <Textarea
          // AN EXPLICIT ID, and this is the one collision editing in place
          // genuinely creates. `Textarea` derives its element id from the label
          // text (packages/ui/src/components/Textarea.tsx:13), so without this
          // line the box would claim `reason-(required)`, the id the delete
          // dialog's identically labelled box derives, and that dialog can open
          // straight over a live post being edited here, where the edit dialog
          // it replaces never overlapped anything. The same guard
          // discord-send.tsx:476-482 puts on the three labels it shares with
          // this composer.
          id="website-edit-reason"
          label="Reason (required)"
          value={editReason}
          onChange={(e) => setEditReason(e.target.value)}
          placeholder="Members have already read this. Why is it changing?"
          rows={3}
          required
        />
      )}

      <div className="flex flex-wrap items-center gap-2">
        {editing ? (
          <>
            {/* POST NOW ONLY ON A DRAFT, carried over from the edit dialog's own
                button. A published post has nowhere left to be published to, and
                the primary beside this already saves it. */}
            {editing.status === 'draft' && (
              <Button
                type="button"
                variant="secondary"
                className="min-h-[44px] flex-1"
                disabled={!ready || busy !== null}
                onClick={() => submit('published')}
              >
                {busy === 'published' ? 'Posting…' : 'Post now'}
              </Button>
            )}
            <Button
              type="button"
              variant="primary"
              className="min-h-[44px] flex-1"
              disabled={!ready || busy !== null}
              onClick={() => submit(editing.status)}
            >
              {/* KEYED ON THE ROW'S OWN STATUS, not on 'published'. Saving an
                  edit to a live post saves it AS published, so a label switched
                  on the busy value alone would read "Posting…" for a save that
                  posts nothing. */}
              {busy === editing.status ? 'Saving…' : 'Save changes'}
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="min-h-[44px] flex-1"
              disabled={busy !== null}
              onClick={clearComposer}
            >
              Cancel
            </Button>
          </>
        ) : (
          <>
            <Button
              type="button"
              variant="ghost"
              className="min-h-[44px] flex-1"
              disabled={!ready || busy !== null}
              onClick={() => submit('draft')}
            >
              {busy === 'draft' ? 'Saving…' : 'Save draft'}
            </Button>
            <Button
              type="button"
              variant="primary"
              className="min-h-[44px] flex-1"
              disabled={!ready || busy !== null}
              onClick={() => submit('published')}
            >
              {busy === 'published' ? 'Posting…' : 'Post now'}
            </Button>
          </>
        )}
      </div>

      {/* Both halves of this are true. A published post reaches the bell and,
          when push is on, the phone — neither can be recalled. And editing a
          live post writes an `announcement_updated` row carrying the actor, the
          before, the after and the reason typed above.

          The mockup's line was "editing a live post leaves an edited mark",
          which is NOT true: nothing on the player side renders one — neither
          announcements/page.tsx nor announcement-item.tsx reads updated_at. The
          audit log is where the mark actually lands, so that is what it says. */}
      <p className={`${MICRO} text-[var(--text-muted)] leading-relaxed`}>
        Posts cannot be unsent. Editing a live one is recorded, with your reason.
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row actions — edit, and delete behind a typed reason
// ---------------------------------------------------------------------------

export interface RowAnnouncement {
  id: string;
  title: string;
  body: string;
  type: AnnouncementType;
  target_audience: TargetAudience;
  pinned: boolean;
  send_push: boolean;
  status: AnnouncementStatus;
  expires_at: string | null;
}

export function AnnouncementRowActions({
  announcement,
  canUpdate,
  canDelete,
  pushReachable,
  discord,
  posted,
}: {
  announcement: RowAnnouncement;
  canUpdate: boolean;
  canDelete: boolean;
  pushReachable: number | null;
  discord: DiscordContext | null;
  posted: PostedMapping | null;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [editReason, setEditReason] = useState('');
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();
  // SAFE TO CALL UNCONDITIONALLY. This component is rendered from one place,
  // page.tsx, inside `DiscordConsoleProvider` (page.tsx:519), and the hook
  // throws loudly rather than returning null when it is not (see its own note).
  const { startWebsiteEdit, hasWebsiteComposer, pendingWebsite, clearWebsiteEdit } =
    useDiscordConsole();

  // A live post has already been read by members, so changing it is audited and
  // takes an explanation. A draft has been said to nobody — it is exempt, and
  // the field is not drawn.
  const isLive = announcement.status === 'published';

  const [form, setForm] = useState<AnnouncementFormData>(() => fromRow(announcement));

  function fromRow(a: RowAnnouncement): AnnouncementFormData {
    return {
      title: a.title,
      body: a.body,
      type: a.type,
      target_audience: a.target_audience,
      pinned: a.pinned,
      send_push: a.send_push,
      expires_at: a.expires_at ?? '',
      // Carried only to satisfy the shared form shape. Editing never moves a
      // post between seasons, which is why the scope control is not drawn.
      all_seasons: false,
    };
  }

  // WHERE EDIT GOES, which is now two places. With a website composer on screen
  // it fills that, in place, exactly as the Discord console's Edit already
  // fills its own composer. Without one there is nothing to fill and the dialog
  // below is the only thing this button can do: `announcements.update.write` and
  // `announcements.create.write` are separate keys, so a viewer holding Edit and
  // no composer is a live case rather than a hypothetical one.
  const openEdit = () => {
    if (hasWebsiteComposer) {
      // A NEW OBJECT ON EVERY PRESS. The composer refills on the pending edit's
      // IDENTITY rather than its contents, so a second press on the same row
      // has to hand over a fresh one or it would appear to do nothing.
      startWebsiteEdit({ ...announcement, posted });
      return;
    }
    setForm(fromRow(announcement));
    setEditReason('');
    setEditOpen(true);
  };

  const editReady =
    form.title.trim().length > 0 && form.body.trim().length > 0 && (!isLive || editReason.trim().length > 0);

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editReady) return;
    setLoading(true);
    try {
      await updateAnnouncement(
        announcement.id,
        {
          title: form.title.trim(),
          body: form.body.trim(),
          type: form.type,
          target_audience: form.target_audience,
          pinned: form.pinned,
          send_push: form.send_push,
          status: announcement.status,
          ...(form.expires_at ? { expires_at: form.expires_at } : {}),
        },
        editReason.trim(),
      );
      toast('Announcement updated', 'success');
      setEditOpen(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to update announcement', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handlePublish = async () => {
    setLoading(true);
    try {
      await updateAnnouncement(announcement.id, {
        title: form.title.trim() || announcement.title,
        body: form.body.trim() || announcement.body,
        type: form.type,
        target_audience: form.target_audience,
        pinned: form.pinned,
        send_push: form.send_push,
        status: 'published',
        ...(form.expires_at ? { expires_at: form.expires_at } : {}),
      });
      toast('Posted to the club', 'success');
      setEditOpen(false);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to post', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    if (!reason.trim()) return;
    setLoading(true);
    try {
      await deleteAnnouncement(announcement.id, reason.trim());
      toast('Announcement deleted', 'success');
      setDeleteOpen(false);
      setReason('');
      // THE CONTEXT LETS GO, THE COMPOSER DOES NOT: its effect early-returns on
      // null, so a form already filled from this row keeps those words and its
      // Editing header until somebody presses Cancel. Saving from there writes
      // nothing, because `updateAnnouncement` refuses an update matching no rows.
      if (pendingWebsite?.id === announcement.id) clearWebsiteEdit();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to delete announcement', 'error');
    } finally {
      setLoading(false);
    }
  };

  // Nothing to offer. Said plainly rather than left as an empty slot, which
  // reads as a row that failed to render.
  if (!canUpdate && !canDelete) {
    return <span className={`${MICRO} text-[var(--text-muted)]`}>View only</span>;
  }

  return (
    <>
      {canUpdate ? (
        // A FLEX OF ITS OWN, because the two cells that render this put no gap
        // between two buttons: the desktop row's wrapper (page.tsx) sets only
        // the 44px floor, and both that floor and TableCard's reach through this
        // div as descendant selectors.
        <div className="flex flex-wrap items-center gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            className="min-h-[44px] min-w-[44px]"
            onClick={openEdit}
          >
            Edit
          </Button>
          {/* DELETE COMES OUT OF THE DIALOG WHEN EDIT NO LONGER OPENS ONE. On
              the in-place path that dialog is never drawn, so leaving Delete
              inside it would take the control away from everybody who can use
              it. Ghost, like the standalone below rather than the dialog's
              danger red: two viewers looking at the same column should not see
              the destructive action in two different weights, and the mis-tap
              guard is the typed reason it still asks for. */}
          {hasWebsiteComposer && canDelete && (
            <Button
              type="button"
              size="sm"
              variant="ghost"
              className="min-h-[44px] min-w-[44px]"
              onClick={() => setDeleteOpen(true)}
            >
              Delete
            </Button>
          )}
        </div>
      ) : (
        // Delete without edit: the danger action is the only one, and it is
        // never the thing a thumb finds first, so it keeps its own label.
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="min-h-[44px] min-w-[44px]"
          onClick={() => setDeleteOpen(true)}
        >
          Delete
        </Button>
      )}

      <Dialog open={editOpen} onClose={() => setEditOpen(false)} title="Edit announcement">
        <form onSubmit={handleEdit} className="flex flex-col gap-5">
          <AnnouncementFields
            form={form}
            setForm={setForm}
            idPrefix="edit"
            pushReachable={pushReachable}
            showScope={false}
            discord={discord}
            posted={posted}
            // The row's STATUS, unlike the composer's fixed 'published': a
            // draft being edited is still a draft, and saying otherwise here
            // would promise a Discord post that a Save cannot deliver.
            status={announcement.status}
            // null, meaning now — saving this form writes updated_at, so the
            // lookback question is settled by the act of saving.
            updatedAt={null}
          />

          {isLive && (
            <Textarea
              label="Reason (required)"
              value={editReason}
              onChange={(e) => setEditReason(e.target.value)}
              placeholder="Members have already read this. Why is it changing?"
              rows={3}
              required
            />
          )}

          <div className="flex flex-wrap items-center justify-between gap-2 pt-2">
            {/* THE FALLBACK PATH'S DELETE, and that is now the whole of what
                this describes. For a viewer with no composer to fill, Edit opens
                this dialog and nothing else, so inside it is the only place a
                Delete can sit without being a second control in a 480px rail.
                Where Edit fills the composer instead, this dialog never opens
                and Delete is drawn beside Edit in the row. It is labelled, it
                names the post, and it takes a reason either way: the three
                things the console asks of a destructive action. */}
            {canDelete ? (
              <Button
                type="button"
                variant="danger"
                className="min-h-[44px]"
                disabled={loading}
                onClick={() => {
                  setEditOpen(false);
                  setDeleteOpen(true);
                }}
              >
                Delete
              </Button>
            ) : (
              <span />
            )}

            <div className="flex items-center gap-2">
              {announcement.status === 'draft' && (
                <Button
                  type="button"
                  variant="secondary"
                  className="min-h-[44px]"
                  disabled={loading || !form.title.trim() || !form.body.trim()}
                  onClick={handlePublish}
                >
                  Post now
                </Button>
              )}
              <Button
                type="submit"
                variant="primary"
                className="min-h-[44px]"
                disabled={loading || !editReady}
              >
                {loading ? 'Saving…' : 'Save changes'}
              </Button>
            </div>
          </div>
        </form>
      </Dialog>

      <Dialog
        open={deleteOpen}
        onClose={() => setDeleteOpen(false)}
        title={`Delete "${announcement.title}"`}
      >
        <div className="flex flex-col gap-5">
          <p className="text-sm text-[var(--text-secondary)]">
            This removes the post and its read receipts. Members who already saw it keep the bell
            notification it sent — the post itself will not come back.
          </p>

          <Textarea
            label="Reason (required)"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why is this coming down?"
            rows={3}
            required
          />

          <div className="flex items-center justify-between gap-2">
            <Button
              type="button"
              variant="ghost"
              className="min-h-[44px]"
              onClick={() => setDeleteOpen(false)}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              className="min-h-[44px]"
              onClick={handleDelete}
              disabled={loading || !reason.trim()}
            >
              {loading ? 'Deleting…' : 'Delete post'}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
