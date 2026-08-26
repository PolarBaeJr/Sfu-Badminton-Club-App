'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { Star } from 'lucide-react';
import { submitEventFeedback } from '@/lib/actions/feedback';

export function FeedbackForm({
  tournamentId,
  initialRating,
  initialComment,
}: {
  tournamentId: string;
  initialRating: number | null;
  initialComment: string | null;
}) {
  const [rating, setRating] = useState<number>(initialRating ?? 0);
  const [hover, setHover] = useState<number>(0);
  const [comment, setComment] = useState(initialComment ?? '');
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const already = initialRating != null || (initialComment != null && initialComment.length > 0);

  function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    startTransition(async () => {
      try {
        const res = await submitEventFeedback({
          tournament_id: tournamentId,
          rating: rating > 0 ? rating : undefined,
          comment: comment.trim() || undefined,
        });
        if (!res.ok) {
          setError(res.error);
          return;
        }
        setSaved(true);
        setTimeout(() => setSaved(false), 2500);
        router.refresh();
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not send feedback');
      }
    });
  }

  return (
    <form onSubmit={submit} className="card-base" style={{ padding: 20 }}>
      <div style={{ fontFamily: 'var(--display)', fontSize: 18, fontWeight: 700 }}>
        {already ? 'Your feedback' : 'How was this event?'}
      </div>
      {/* "MAY ALSO", NOT "AND", AND THAT IS DELIBERATE. The Discord relay is off
          until somebody sets event_feedback_channel_id, and that key is unset on
          production, so stating the forward as a fact would describe something
          that does not happen. The copy cannot read the setting to find out
          either: discord_settings is service-role only (00167), so a member-facing
          page gets an empty list back and would always render the wrong branch —
          silently, because a refused PostgREST read is not an error.

          What has to survive either wording is the disclosure: a member must never
          be surprised to find their words in Discord. "May also" carries that and
          stays true whether the relay is configured or not. The audience claim in
          the first clause is the promise, and it holds in both cases — both
          channels are exec-only by the rule written into 00173. */}
      <p className="muted" style={{ fontSize: 12, marginTop: 4 }}>
        Only the exec team sees this — never anywhere other members can read it. The execs
        may also get a copy in their own private Discord channel. You can update it any time.
      </p>

      <div className="row" style={{ gap: 4, marginTop: 14 }} role="radiogroup" aria-label="Rating">
        {[1, 2, 3, 4, 5].map((n) => {
          const active = (hover || rating) >= n;
          return (
            <button
              key={n}
              type="button"
              aria-label={`${n} star${n > 1 ? 's' : ''}`}
              aria-pressed={rating === n}
              onMouseEnter={() => setHover(n)}
              onMouseLeave={() => setHover(0)}
              onClick={() => setRating(n === rating ? 0 : n)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', padding: 2, lineHeight: 0 }}
            >
              <Star
                size={26}
                fill={active ? 'var(--color-accent)' : 'none'}
                color={active ? 'var(--color-accent)' : 'var(--line-2)'}
              />
            </button>
          );
        })}
      </div>

      <textarea
        value={comment}
        onChange={(e) => setComment(e.target.value)}
        placeholder="Anything the exec team should know? What worked, what didn't."
        rows={3}
        maxLength={2000}
        style={{
          width: '100%', marginTop: 14, padding: 12, borderRadius: 10,
          border: '1px solid var(--line)', background: 'var(--surface)',
          color: 'var(--ink)', fontSize: 14, resize: 'vertical',
        }}
      />

      {error && <p style={{ color: 'var(--loss)', fontSize: 13, marginTop: 8 }}>{error}</p>}

      <button
        type="submit"
        disabled={isPending || (rating === 0 && comment.trim().length === 0)}
        className="btn btn-primary btn-lg"
        style={{ width: '100%', justifyContent: 'center', marginTop: 14, opacity: (rating === 0 && comment.trim().length === 0) ? 0.5 : 1 }}
      >
        {isPending ? 'Sending…' : saved ? 'Sent — thank you' : already ? 'Update feedback' : 'Send feedback'}
      </button>
    </form>
  );
}
