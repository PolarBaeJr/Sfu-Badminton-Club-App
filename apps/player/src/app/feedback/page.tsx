'use client';

import { useEffect, useRef, useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Bug, MessageSquare, ImagePlus, X, Loader2, Check } from 'lucide-react';
import { PageHeader, Input, Textarea, Button } from '@badminton/ui';
import { createClient } from '@/lib/supabase-browser';
import { submitFeedbackReport, type AppFeedbackKind } from '@/lib/actions/feedback';

// Both mirror 00174's bucket configuration. Checked here as well so an oversized
// or wrong-typed file is refused instantly, next to the picker, instead of after
// an upload that storage was always going to reject.
const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 8 * 1024 * 1024;

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

const KINDS: { value: AppFeedbackKind; label: string; hint: string; icon: React.ElementType }[] = [
  { value: 'bug', label: 'Something is broken', hint: 'A page, a button, or a number that looks wrong', icon: Bug },
  { value: 'feedback', label: 'A suggestion', hint: 'An idea, or something that could work better', icon: MessageSquare },
];

export default function FeedbackPage() {
  const [kind, setKind] = useState<AppFeedbackKind>('bug');
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [isPending, startTransition] = useTransition();
  const fileInput = useRef<HTMLInputElement>(null);
  const router = useRouter();

  // Preview from the local File, never from storage. The bucket is private and
  // deliberately has no read policy (00174), so there is nothing to read back —
  // and this shows the picture before it is uploaded, which is what you want.
  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  function pick(e: React.ChangeEvent<HTMLInputElement>) {
    const picked = e.target.files?.[0];
    if (!picked) return;
    setError(null);

    if (!ALLOWED_TYPES.includes(picked.type)) {
      setError('Screenshots need to be a JPEG, PNG, or WebP image.');
      return;
    }
    if (picked.size > MAX_BYTES) {
      setError('That image is over 8 MB — try a screenshot of just the part that went wrong.');
      return;
    }
    setFile(picked);
  }

  function clearFile() {
    setFile(null);
    if (fileInput.current) fileInput.current.value = '';
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    startTransition(async () => {
      try {
        let imagePath: string | null = null;

        // Uploaded from the browser, exactly like an avatar: the file never
        // passes through the server action, which keeps a multi-megabyte body
        // off the Node process that renders every other page. The path is
        // folder-per-user because that is what storage RLS enforces on, and the
        // action re-checks it because a path is client-supplied either way.
        if (file) {
          const supabase = createClient();
          const { data: { user } } = await supabase.auth.getUser();
          if (!user) {
            setError('Your session expired — sign in again and resend.');
            return;
          }

          const path = `${user.id}/${crypto.randomUUID()}.${EXTENSIONS[file.type] ?? 'jpg'}`;
          const { error: uploadError } = await supabase.storage
            .from('feedback-screenshots')
            .upload(path, file, { contentType: file.type, upsert: false });

          // The report is the words; the screenshot is a bonus. A failed upload
          // must not eat what they typed, so it is reported and the send stops
          // here rather than silently filing a report with no picture — they can
          // remove the image and send again.
          if (uploadError) {
            setError(`The screenshot could not be uploaded (${uploadError.message}). Remove it and send again, or try a smaller image.`);
            return;
          }
          imagePath = path;
        }

        const res = await submitFeedbackReport({ kind, title, body, imagePath });
        if (!res.ok) {
          setError(res.error);
          return;
        }

        setSent(true);
        setTitle('');
        setBody('');
        clearFile();
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not send that report');
      }
    });
  }

  if (sent) {
    return (
      <div className="page">
        <PageHeader title="Thanks" />
        <div className="card-base" style={{ padding: 24, display: 'grid', gap: 12, justifyItems: 'start' }}>
          <Check size={28} style={{ color: 'var(--success, green)' }} />
          <div style={{ fontFamily: 'var(--display)', fontSize: 18, fontWeight: 700 }}>
            That went straight to the exec team.
          </div>
          <p className="muted" style={{ fontSize: 13 }}>
            There is no reply thread here — if they need more detail, someone will get in touch.
          </p>
          <Button type="button" onClick={() => setSent(false)}>Send another</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <PageHeader title="Report a problem" />

      <form onSubmit={submit} className="card-base" style={{ padding: 20, display: 'grid', gap: 18 }}>
        {/* Same disclosure the tournament survey makes, for the same reason: a
            member must never be surprised to find their words in Discord. The
            relay only runs where report_channel_id is set, so this says "may". */}
        <p className="muted" style={{ fontSize: 12, margin: 0 }}>
          This goes to the exec team, with your name attached so they can follow up. They may
          also get a copy in their own private Discord channel.
        </p>

        <div style={{ display: 'grid', gap: 8 }}>
          {KINDS.map((k) => {
            const Icon = k.icon;
            const active = kind === k.value;
            return (
              <button
                key={k.value}
                type="button"
                onClick={() => setKind(k.value)}
                aria-pressed={active}
                className="card-base"
                style={{
                  padding: 12,
                  display: 'flex',
                  gap: 12,
                  alignItems: 'center',
                  textAlign: 'left',
                  cursor: 'pointer',
                  borderColor: active ? 'var(--accent)' : undefined,
                }}
              >
                <Icon size={18} style={{ flexShrink: 0, opacity: active ? 1 : 0.6 }} />
                <span style={{ display: 'grid' }}>
                  <span style={{ fontWeight: 600, fontSize: 14 }}>{k.label}</span>
                  <span className="muted" style={{ fontSize: 12 }}>{k.hint}</span>
                </span>
              </button>
            );
          })}
        </div>

        <Input
          label="Summary"
          value={title}
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
          placeholder={kind === 'bug' ? 'Check-in button does nothing' : 'Show court numbers on the schedule'}
        />

        <Textarea
          label="What happened?"
          value={body}
          rows={6}
          maxLength={4000}
          required
          onChange={(e) => setBody(e.target.value)}
          placeholder={
            kind === 'bug'
              ? 'What you were doing, what you expected, and what happened instead.'
              : 'What would you change, and what would it make easier?'
          }
        />

        <div style={{ display: 'grid', gap: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>Screenshot (optional)</span>
          <input
            ref={fileInput}
            type="file"
            accept={ALLOWED_TYPES.join(',')}
            onChange={pick}
            style={{ display: 'none' }}
          />

          {preview ? (
            <div style={{ display: 'grid', gap: 8, justifyItems: 'start' }}>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                src={preview}
                alt="Screenshot to be attached"
                style={{ maxWidth: '100%', maxHeight: 260, borderRadius: 2, border: '1px solid var(--border)' }}
              />
              <Button type="button" variant="ghost" onClick={clearFile}>
                <X size={14} /> Remove
              </Button>
            </div>
          ) : (
            <Button type="button" variant="secondary" onClick={() => fileInput.current?.click()}>
              <ImagePlus size={16} /> Add a screenshot
            </Button>
          )}
          <span className="muted" style={{ fontSize: 12 }}>
            JPEG, PNG, or WebP, up to 8 MB. Only the exec team can open it.
          </span>
        </div>

        {error && (
          <p role="alert" style={{ fontSize: 13, color: 'var(--danger, crimson)', margin: 0 }}>
            {error}
          </p>
        )}

        <Button type="submit" disabled={isPending || !body.trim()}>
          {isPending ? <><Loader2 size={16} className="spin" /> Sending…</> : 'Send report'}
        </Button>
      </form>
    </div>
  );
}
