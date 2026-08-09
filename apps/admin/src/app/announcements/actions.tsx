'use client';

import { useState, useRef, useEffect } from 'react';
import { Button, Dialog, Input, Select, Textarea, DatePicker } from '@badminton/ui';
import { useToast } from '@/components/toast-provider';
import {
  createAnnouncement,
  updateAnnouncement,
  deleteAnnouncement,
} from '@/lib/actions';
import { Plus, MoreVertical, Pencil, Trash2 } from 'lucide-react';

// ---------------------------------------------------------------------------
// Shared types & constants
// ---------------------------------------------------------------------------

type AnnouncementType = 'info' | 'warning' | 'urgent' | 'event';
type AnnouncementStatus = 'draft' | 'published';
type TargetAudience = 'all' | 'competitive' | 'recreational' | 'eligible_only';

interface AnnouncementFormData {
  title: string;
  body: string;
  type: AnnouncementType;
  target_audience: TargetAudience;
  status: AnnouncementStatus;
  pinned: boolean;
  send_push: boolean;
  expires_at: string;
  /** Evergreen rather than tied to the current term. */
  all_seasons: boolean;
}

const TYPE_OPTIONS: { value: string; label: string }[] = [
  { value: 'info', label: 'Info' },
  { value: 'warning', label: 'Warning' },
  { value: 'urgent', label: 'Urgent' },
  { value: 'event', label: 'Event' },
];

const AUDIENCE_OPTIONS: { value: string; label: string }[] = [
  { value: 'all', label: 'All Members' },
  { value: 'competitive', label: 'Competitive' },
  { value: 'recreational', label: 'Recreational' },
  { value: 'eligible_only', label: 'Eligible Only' },
];

const STATUS_OPTIONS: { value: string; label: string }[] = [
  { value: 'draft', label: 'Draft' },
  { value: 'published', label: 'Published' },
];

const DEFAULT_FORM: AnnouncementFormData = {
  title: '',
  body: '',
  type: 'info',
  target_audience: 'all',
  status: 'draft',
  pinned: false,
  send_push: false,
  expires_at: '',
  // Defaults to term-specific, which is what almost every announcement is —
  // a court closure, a tournament call-out, a fee deadline. Evergreen is the
  // deliberate exception and has to be ticked.
  all_seasons: false,
};

// ---------------------------------------------------------------------------
// Shared form fields component
// ---------------------------------------------------------------------------

function AnnouncementFields({
  form,
  setForm,
  // Only offered when CREATING. An announcement is filed against the term it
  // was written in, and updateAnnouncement deliberately does not move it —
  // re-filing silently would resurrect a retired notice or retire a live one.
  // Rendering the checkbox on the edit form would promise a change that never
  // happens.
  showSeasonChoice = true,
}: {
  form: AnnouncementFormData;
  setForm: React.Dispatch<React.SetStateAction<AnnouncementFormData>>;
  showSeasonChoice?: boolean;
}) {
  /** Auto-grow the body with its content, capped at ~60vh (dialog scrolls past that). */
  function autoGrow(e: React.FormEvent<HTMLTextAreaElement>) {
    const el = e.currentTarget;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, window.innerHeight * 0.6)}px`;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
          Title <span style={{ color: 'var(--color-danger)' }}>*</span>
        </label>
        <Input
          value={form.title}
          onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
          placeholder="Announcement title"
          required
        />
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
          Body <span style={{ color: 'var(--color-danger)' }}>*</span>
        </label>
        <Textarea
          value={form.body}
          onChange={(e) => setForm((f) => ({ ...f, body: e.target.value }))}
          onInput={autoGrow}
          placeholder="Announcement body"
          rows={4}
          required
        />
      </div>

      <div className="grid grid-cols-2 gap-3">
        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
            Type
          </label>
          <Select
            value={form.type}
            onChange={(e) => setForm((f) => ({ ...f, type: e.target.value as AnnouncementType }))}
            options={TYPE_OPTIONS}
          />
        </div>

        <div className="flex flex-col gap-1">
          <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
            Target Audience
          </label>
          <Select
            value={form.target_audience}
            onChange={(e) =>
              setForm((f) => ({ ...f, target_audience: e.target.value as TargetAudience }))
            }
            options={AUDIENCE_OPTIONS}
          />
        </div>
      </div>

      <div className="flex flex-col gap-1">
        <label className="text-xs font-medium" style={{ color: 'var(--text-muted)' }}>
          Status
        </label>
        <Select
          value={form.status}
          onChange={(e) => setForm((f) => ({ ...f, status: e.target.value as AnnouncementStatus }))}
          options={STATUS_OPTIONS}
        />
      </div>

      <DatePicker
        label="Expires At (optional)"
        value={form.expires_at}
        onChange={(v) => setForm((f) => ({ ...f, expires_at: v }))}
      />

      <div className="flex flex-col gap-2">
        <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
          <input
            type="checkbox"
            checked={form.pinned}
            onChange={(e) => setForm((f) => ({ ...f, pinned: e.target.checked }))}
            className="rounded border-[var(--border)]"
          />
          Pin this announcement
        </label>

        <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
          <input
            type="checkbox"
            checked={form.send_push}
            onChange={(e) => setForm((f) => ({ ...f, send_push: e.target.checked }))}
            className="rounded border-[var(--border)]"
          />
          Send push notification
        </label>

        {showSeasonChoice && (
          <>
            <label className="flex items-center gap-2 text-sm text-[var(--text-secondary)]">
              <input
                type="checkbox"
                checked={form.all_seasons}
                onChange={(e) => setForm((f) => ({ ...f, all_seasons: e.target.checked }))}
                className="rounded border-[var(--border)]"
              />
              Show in every season
            </label>
            <p className="text-xs text-[var(--text-muted)] -mt-1 ml-6">
              Leave unticked for anything about this term — it retires when the season does.
              Tick it for standing information like club rules or the door code.
            </p>
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// CreateAnnouncementForm
// ---------------------------------------------------------------------------

export function CreateAnnouncementForm() {
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState<AnnouncementFormData>(DEFAULT_FORM);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim() || !form.body.trim()) return;

    setLoading(true);
    try {
      await createAnnouncement({
        title: form.title.trim(),
        body: form.body.trim(),
        type: form.type,
        target_audience: form.target_audience,
        pinned: form.pinned,
        send_push: form.send_push,
        status: form.status,
        all_seasons: form.all_seasons,
        ...(form.expires_at ? { expires_at: form.expires_at } : {}),
      });
      toast('Announcement created successfully', 'success');
      setForm(DEFAULT_FORM);
      setOpen(false);
    } catch {
      toast('Failed to create announcement', 'error');
    } finally {
      setLoading(false);
    }
  };

  return (
    <>
      <Button onClick={() => setOpen(true)} variant="primary" className="flex items-center gap-2">
        <Plus size={16} />
        New Announcement
      </Button>

      <Dialog open={open} onClose={() => setOpen(false)} title="New Announcement">
        <form onSubmit={handleSubmit} className="flex flex-col gap-5">
          <AnnouncementFields form={form} setForm={setForm} />

          <div className="flex items-center justify-between pt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setOpen(false)}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button type="submit" variant="primary" disabled={loading || !form.title.trim() || !form.body.trim()}>
              {loading ? 'Creating…' : 'Create'}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}

// ---------------------------------------------------------------------------
// AnnouncementCardMenu
// ---------------------------------------------------------------------------

interface AnnouncementCardMenuProps {
  announcement: {
    id: string;
    title: string;
    body: string;
    type: AnnouncementType;
    target_audience: TargetAudience;
    pinned: boolean;
    send_push: boolean;
    status: AnnouncementStatus;
    expires_at: string | null;
    all_seasons?: boolean;
  };
  /**
   * The card's own content. Rendered inside a button that opens the edit
   * dialog, so the whole row is the control rather than a three-dot menu
   * hidden at the far right of a full-width card.
   */
  children?: React.ReactNode;
}

export function AnnouncementCardMenu({ announcement, children }: AnnouncementCardMenuProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [deleteOpen, setDeleteOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const { toast } = useToast();

  const [form, setForm] = useState<AnnouncementFormData>({
    title: announcement.title,
    body: announcement.body,
    type: announcement.type,
    target_audience: announcement.target_audience,
    status: announcement.status,
    pinned: announcement.pinned,
    send_push: announcement.send_push,
    expires_at: announcement.expires_at ?? '',
    all_seasons: announcement.all_seasons ?? false,
  });

  // Close menu on outside click
  useEffect(() => {
    if (!menuOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [menuOpen]);

  const handleEdit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim() || !form.body.trim()) return;

    setLoading(true);
    try {
      await updateAnnouncement(announcement.id, {
        title: form.title.trim(),
        body: form.body.trim(),
        type: form.type,
        target_audience: form.target_audience,
        pinned: form.pinned,
        send_push: form.send_push,
        status: form.status,
        ...(form.expires_at ? { expires_at: form.expires_at } : {}),
      });
      toast('Announcement updated', 'success');
      setEditOpen(false);
    } catch {
      toast('Failed to update announcement', 'error');
    } finally {
      setLoading(false);
    }
  };

  const handleDelete = async () => {
    setLoading(true);
    try {
      await deleteAnnouncement(announcement.id);
      toast('Announcement deleted', 'success');
      setDeleteOpen(false);
    } catch {
      toast('Failed to delete announcement', 'error');
    } finally {
      setLoading(false);
    }
  };

  const openEdit = () => {
    // Reset form to latest announcement values each time edit is opened
    setForm({
      title: announcement.title,
      body: announcement.body,
      type: announcement.type,
      target_audience: announcement.target_audience,
      status: announcement.status,
      pinned: announcement.pinned,
      send_push: announcement.send_push,
      expires_at: announcement.expires_at ?? '',
      // Carried so the form type is satisfied and the checkbox shows the truth.
      // Editing does NOT move an announcement between seasons: it was filed
      // against the term it was written in, and re-filing it silently would
      // resurrect a retired notice or retire a live one.
      all_seasons: announcement.all_seasons ?? false,
    });
    setMenuOpen(false);
    setEditOpen(true);
  };

  const openDelete = () => {
    setMenuOpen(false);
    setDeleteOpen(true);
  };

  return (
    <>
      {/* The card's content is the primary control.
          The three-dot menu was the only way to reach Edit, tucked at the far
          right of a full-width row — so the obvious gesture, clicking the
          announcement, did nothing at all. A real <button> rather than a click
          handler on a div: it is reachable by keyboard and announces itself.
          Nothing inside is interactive, so nesting is valid. */}
      {children !== undefined && (
        <button
          type="button"
          onClick={openEdit}
          aria-label={`Edit ${announcement.title}`}
          className="flex-1 min-w-0 text-left rounded-md -m-1 p-1 transition-colors hover:bg-[var(--bg-elevated)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)]"
        >
          {children}
        </button>
      )}

      {/* Three-dot menu */}
      <div className="relative" ref={menuRef}>
        <button
          onClick={() => setMenuOpen((v) => !v)}
          className="flex items-center justify-center w-8 h-8 rounded-md transition-colors"
          style={{ color: 'var(--text-muted)' }}
          onMouseEnter={(e) =>
            ((e.currentTarget as HTMLButtonElement).style.backgroundColor =
              'var(--bg-elevated)')
          }
          onMouseLeave={(e) =>
            ((e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent')
          }
          aria-label="Announcement options"
        >
          <MoreVertical size={16} />
        </button>

        {menuOpen && (
          <div
            className="absolute right-0 top-9 z-50 w-36 rounded-lg border shadow-lg overflow-hidden"
            style={{
              backgroundColor: 'var(--bg-surface)',
              borderColor: 'var(--border)',
            }}
          >
            <button
              onClick={openEdit}
              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-left transition-colors"
              style={{ color: 'var(--text-primary)' }}
              onMouseEnter={(e) =>
                ((e.currentTarget as HTMLButtonElement).style.backgroundColor =
                  'var(--bg-elevated)')
              }
              onMouseLeave={(e) =>
                ((e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent')
              }
            >
              <Pencil size={14} />
              Edit
            </button>
            <button
              onClick={openDelete}
              className="flex items-center gap-2 w-full px-3 py-2 text-sm text-left transition-colors"
              style={{ color: 'var(--color-danger)' }}
              onMouseEnter={(e) =>
                ((e.currentTarget as HTMLButtonElement).style.backgroundColor =
                  'var(--bg-elevated)')
              }
              onMouseLeave={(e) =>
                ((e.currentTarget as HTMLButtonElement).style.backgroundColor = 'transparent')
              }
            >
              <Trash2 size={14} />
              Delete
            </button>
          </div>
        )}
      </div>

      {/* Edit Dialog */}
      <Dialog open={editOpen} onClose={() => setEditOpen(false)} title="Edit Announcement">
        <form onSubmit={handleEdit} className="flex flex-col gap-5">
          <AnnouncementFields form={form} setForm={setForm} showSeasonChoice={false} />

          <div className="flex items-center justify-between pt-2">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setEditOpen(false)}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={loading || !form.title.trim() || !form.body.trim()}
            >
              {loading ? 'Saving…' : 'Save Changes'}
            </Button>
          </div>
        </form>
      </Dialog>

      {/* Delete Confirmation Dialog */}
      <Dialog open={deleteOpen} onClose={() => setDeleteOpen(false)} title="Delete Announcement">
        <div className="flex flex-col gap-5">
          <p className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            Are you sure you want to delete{' '}
            <span className="font-semibold" style={{ color: 'var(--text-primary)' }}>
              &ldquo;{announcement.title}&rdquo;
            </span>
            ? This action cannot be undone.
          </p>

          <div className="flex items-center justify-between">
            <Button
              type="button"
              variant="ghost"
              onClick={() => setDeleteOpen(false)}
              disabled={loading}
            >
              Cancel
            </Button>
            <Button
              type="button"
              variant="danger"
              onClick={handleDelete}
              disabled={loading}
            >
              {loading ? 'Deleting…' : 'Delete'}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
