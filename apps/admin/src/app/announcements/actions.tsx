'use client';

import { useState } from 'react';
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
  type TargetAudience,
} from './announcement-shape';

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
  pushReachable,
  showScope,
}: {
  form: AnnouncementFormData;
  setForm: React.Dispatch<React.SetStateAction<AnnouncementFormData>>;
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
}) {
  return (
    <div className="flex flex-col gap-[14px]">
      <Input
        label="Headline"
        value={form.title}
        onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
        placeholder="Say the thing in one line"
        required
      />

      <Textarea
        label="Body"
        className="min-h-[180px]"
        value={form.body}
        onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
        placeholder="Members read this on a phone, mid-session. Keep it to what changes for them."
        required
      />

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
export function Composer({ pushReachable }: { pushReachable: number | null }) {
  const [form, setForm] = useState<AnnouncementFormData>(EMPTY_FORM);
  const [busy, setBusy] = useState<null | AnnouncementStatus>(null);
  const { toast } = useToast();

  const ready = form.title.trim().length > 0 && form.body.trim().length > 0;

  const submit = async (status: AnnouncementStatus) => {
    if (!ready || busy) return;
    setBusy(status);
    try {
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
      setForm(EMPTY_FORM);
    } catch {
      toast(status === 'published' ? 'Failed to post' : 'Failed to save the draft', 'error');
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="flex flex-col gap-[14px]">
      <div className="flex items-center justify-between">
        <span className={`${MICRO} text-[var(--mute)]`}>New post</span>
        <Badge variant="neutral">DRAFT</Badge>
      </div>

      <AnnouncementFields form={form} setForm={setForm} pushReachable={pushReachable} showScope />

      <div className="flex flex-wrap items-center gap-2">
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
      </div>

      {/* Both halves of this are true. A published post reaches the bell and,
          when push is on, the phone — neither can be recalled. And editing a
          live post writes an `announcement_updated` row carrying the actor, the
          before, the after and the reason typed into the dialog.

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
}: {
  announcement: RowAnnouncement;
  canUpdate: boolean;
  canDelete: boolean;
  pushReachable: number | null;
}) {
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [editReason, setEditReason] = useState('');
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

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

  const openEdit = () => {
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
        <Button
          type="button"
          size="sm"
          variant="secondary"
          className="min-h-[44px] min-w-[44px]"
          onClick={openEdit}
        >
          Edit
        </Button>
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
            pushReachable={pushReachable}
            showScope={false}
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
            {/* Delete lives inside the edit dialog rather than as a second
                control in a 480px rail. It is labelled, it names the post, and
                it takes a reason — the three things the console asks of a
                destructive action. */}
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
