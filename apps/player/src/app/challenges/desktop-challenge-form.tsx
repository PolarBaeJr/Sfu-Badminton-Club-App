'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  previewEloSwing,
  MATCH_FORMAT_OPTIONS,
  DEFAULT_MATCH_FORMAT,
} from '@badminton/shared';
import type { MatchFormat } from '@badminton/shared';
import { createChallenge } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';

type Suggested = {
  id: string;
  full_name: string;
  avatar_url: string | null;
  singles_elo: number | null;
};

export function DesktopChallengeForm({
  myElo,
  suggested,
}: {
  myElo: number;
  suggested: Suggested[];
}) {
  const router = useRouter();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [oppId, setOppId] = useState<string>('');
  const [type, setType] = useState<'singles' | 'doubles'>('singles');
  const [matchFormat, setMatchFormat] = useState<MatchFormat>(DEFAULT_MATCH_FORMAT);
  const [submitting, setSubmitting] = useState(false);
  const [date, setDate] = useState('');
  const [time, setTime] = useState('19:00');
  const [message, setMessage] = useState('');

  useEffect(() => {
    if (open && !oppId && suggested.length > 0) {
      setOppId(suggested[0]?.id ?? '');
    }
  }, [open, oppId, suggested]);

  const opp = suggested.find((s) => s.id === oppId);
  const oppElo = opp?.singles_elo ?? null;
  const preview = oppElo != null ? previewEloSwing(myElo, oppElo) : null;

  async function send() {
    if (!oppId) return;
    setSubmitting(true);
    try {
      await createChallenge({
        type,
        rated_flag: true,
        format: matchFormat,
        event_type: 'rated_challenge',
        opponent_id: oppId,
        scheduled_date: date || undefined,
        scheduled_time: time || undefined,
        note: message.trim() || undefined,
      });
      toast('Challenge sent', 'success');
      router.refresh();
      setOpen(false);
      setMessage('');
      setDate('');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to send', 'error');
    }
    setSubmitting(false);
  }

  return (
    <div className="d-ch-issue">
      <button
        type="button"
        className="d-btn d-btn-red"
        style={{ width: '100%', padding: 14 }}
        onClick={() => setOpen((v) => !v)}
      >
        + Issue New Challenge
      </button>
      <div className={`d-ch-form${open ? ' d-open' : ''}`}>
        <div className="d-ch-form-inner">
          <div className="d-full">
            <label className="d-form-label">Select Opponent</label>
            <select className="d-field" value={oppId} onChange={(e) => setOppId(e.target.value)}>
              {suggested.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.full_name} {p.singles_elo != null ? `· ELO ${p.singles_elo}` : ''}
                </option>
              ))}
            </select>
          </div>
          <div className="d-full">
            <div className="d-ch-preview">
              {preview ? (
                <>
                  If you win: <span className="d-pos">+{preview.win}</span> ELO &nbsp;·&nbsp; If you lose:{' '}
                  <span className="d-neg">{preview.loss}</span> ELO
                </>
              ) : (
                'Pick an opponent to preview ELO swing.'
              )}
            </div>
          </div>
          <div>
            <label className="d-form-label">Type</label>
            <div className="d-pair-toggle">
              <button
                type="button"
                className={type === 'singles' ? 'd-active' : ''}
                onClick={() => setType('singles')}
              >
                Singles
              </button>
              <button
                type="button"
                className={type === 'doubles' ? 'd-active' : ''}
                onClick={() => setType('doubles')}
              >
                Doubles
              </button>
            </div>
          </div>
          <div>
            <label className="d-form-label">Format</label>
            <select
              className="d-field"
              value={matchFormat}
              onChange={(e) => setMatchFormat(e.target.value as MatchFormat)}
            >
              {MATCH_FORMAT_OPTIONS.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="d-form-label">Date</label>
            <input
              className="d-field"
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
            />
          </div>
          <div>
            <label className="d-form-label">Time</label>
            <input
              className="d-field"
              type="time"
              value={time}
              onChange={(e) => setTime(e.target.value)}
            />
          </div>
          <div className="d-full">
            <label className="d-form-label">
              Message{' '}
              <span style={{ color: 'var(--text-faint)', fontWeight: 500, letterSpacing: '0.04em', textTransform: 'none' }}>
                — optional
              </span>
            </label>
            <textarea
              className="d-field"
              rows={3}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="Court A or B? Bring extra shuttles?"
            />
          </div>
          <div className="d-ch-form-actions">
            <button
              type="button"
              className="d-btn d-btn-red"
              disabled={submitting || !oppId}
              onClick={send}
            >
              {submitting ? 'Sending…' : 'Send Challenge'}
            </button>
            <button
              type="button"
              className="d-btn d-btn-ghost"
              onClick={() => setOpen(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
