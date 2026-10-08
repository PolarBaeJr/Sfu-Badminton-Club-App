'use client';

import { useState } from 'react';
import { Textarea } from '@badminton/ui';
import { EXEC_BIO_MAX_LENGTH } from '@badminton/shared';
import { updateExecBio } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';

/**
 * THE EXEC PANEL — the officer's own card on /exec, with an edit affordance on
 * it. This is where the club's public blurb about them is written now (00130);
 * their personal bio stays in Settings and is published nowhere.
 *
 * IT LIVES ON THE PUBLIC PAGE ON PURPOSE. An officer editing the text is
 * looking at the page it lands on, in the typography it lands in, next to the
 * colleagues it sits beside — which is the one thing Settings could never show
 * them, and the reason a blurb written there so often read as a profile note
 * rather than as an entry on a club page.
 *
 * Rendered by page.tsx for exactly one card: the signed-in viewer's own. Every
 * other visitor, signed in or out, gets the plain paragraph. The server action
 * re-checks all of it — this component is the affordance, never the gate.
 */
export function ExecBioEditor({ initialBio }: { initialBio: string | null }) {
  // `saved` is what the page is currently showing; `draft` is what is in the
  // box. Kept apart so Cancel has something to restore to, and so a failed save
  // leaves the officer's typing intact rather than reverting it under them.
  const [saved, setSaved] = useState(initialBio ?? '');
  const [draft, setDraft] = useState(initialBio ?? '');
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const { toast } = useToast();

  async function handleSave() {
    setLoading(true);
    // Trimmed, so a bio that is only whitespace becomes a cleared one rather
    // than a paragraph of blank lines on the club's public page.
    const next = draft.trim();
    const res = await updateExecBio(next);
    setLoading(false);
    if (!res.ok) {
      toast(res.error, 'error');
      return;
    }
    setSaved(next);
    setDraft(next);
    setEditing(false);
    toast('Exec page updated', 'success');
    // No router.refresh(): this component already holds the value the page
    // renders, and a refresh would re-fetch every officer to change one string.
    // The next full load reads it back from get_executives() either way.
  }

  if (!editing) {
    return (
      <div className="exec-bio-block">
        {saved
          ? <p className="exec-officer-bio">{saved}</p>
          : <p className="exec-bio-empty">You haven&apos;t written anything for the club page yet.</p>}
        <button
          type="button"
          className="exec-bio-btn"
          onClick={() => { setDraft(saved); setEditing(true); }}
        >
          {saved ? 'Edit your bio' : 'Write your bio'}
        </button>
      </div>
    );
  }

  return (
    <div className="exec-bio-block">
      <Textarea
        label="Your bio on this page"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        maxLength={EXEC_BIO_MAX_LENGTH}
        rows={4}
        placeholder="What you do for the club, and what members can ask you about."
      />
      {/* Says what the field IS, because the whole point of 00130 is that this
          is no longer the same text as the one in Settings. */}
      <p className="exec-bio-note">
        Public — anyone can read this, signed in or not. Your personal bio in
        Settings is separate and stays private to members.
      </p>
      <div className="exec-bio-actions">
        <button
          type="button"
          className="exec-bio-btn"
          onClick={() => { setDraft(saved); setEditing(false); }}
          disabled={loading}
        >
          Cancel
        </button>
        <button
          type="button"
          className="exec-bio-btn"
          data-variant="primary"
          onClick={handleSave}
          disabled={loading}
        >
          {loading ? 'Saving…' : 'Save'}
        </button>
      </div>
    </div>
  );
}
