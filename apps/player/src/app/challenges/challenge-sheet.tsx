'use client';

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';
import { useRouter } from 'next/navigation';
import { createClient } from '@badminton/shared/supabase-browser';
import {
  MATCH_FORMAT_OPTIONS,
  DEFAULT_MATCH_FORMAT,
} from '@badminton/shared';
import type { MatchFormat } from '@badminton/shared';
import { createChallenge } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';
import { CTAButton } from '@/components/v2/atoms-form';
import { Avatar, Eyebrow } from '@/components/v2/atoms-display';

const NOTE_MAX = 280;

// Shared field styling for the step-2 inputs. Matches the existing
// search input that opens step 1 — same font, same padding, same border
// treatment so the form reads as a single visual unit.
const fieldStyle: CSSProperties = {
  width: '100%',
  background: 'var(--surface1)',
  border: '1px solid var(--hairline)',
  color: 'var(--ink)',
  padding: '12px 14px',
  fontSize: 13,
  fontFamily: 'inherit',
  boxSizing: 'border-box',
};

function FieldLabel({ children }: { children: ReactNode }) {
  return (
    <div
      style={{
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: '1.6px',
        textTransform: 'uppercase',
        color: 'var(--text)',
        marginBottom: 8,
      }}
    >
      {children}
    </div>
  );
}

type Candidate = {
  id: string;
  full_name: string;
  avatar_url: string | null;
  singles_elo: number | null;
};

export function ChallengeSheet({
  open,
  onClose,
  presetOpponentId,
}: {
  open: boolean;
  onClose: () => void;
  presetOpponentId?: string | null;
}) {
  const { toast } = useToast();
  const router = useRouter();
  const [step, setStep] = useState(0);
  const [search, setSearch] = useState('');
  const [opponent, setOpponent] = useState<Candidate | null>(null);
  const [type, setType] = useState<'singles' | 'doubles'>('singles');
  const [matchFormat, setMatchFormat] = useState<MatchFormat>(DEFAULT_MATCH_FORMAT);
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [note, setNote] = useState('');
  const [candidates, setCandidates] = useState<Candidate[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      setStep(0);
      setOpponent(null);
      setType('singles');
      setMatchFormat(DEFAULT_MATCH_FORMAT);
      setDate('');
      setTime('');
      setNote('');
      setSearch('');
      return;
    }
    let cancelled = false;
    (async () => {
      const supabase = createClient();
      const {
        data: { user },
      } = await supabase.auth.getUser();
      if (!user || cancelled) return;
      const { data: me } = await supabase.from('players').select('id').eq('user_id', user.id).single();
      // TODO: Phase 10 — scope by organization_id once multi-club is supported.
      const { data } = await supabase
        .from('players')
        .select('id, full_name, avatar_url, ratings(singles_elo)')
        .eq('active_flag', true)
        .is('deleted_at', null)
        .not('status', 'in', '("pending_approval","suspended","inactive")')
        .neq('id', me?.id ?? '')
        .limit(40);
      if (cancelled) return;
      const list: Candidate[] = (data ?? []).map((p) => {
        const r = Array.isArray(p.ratings) ? p.ratings[0] : p.ratings;
        return {
          id: p.id,
          full_name: p.full_name,
          avatar_url: p.avatar_url,
          singles_elo: (r as { singles_elo: number | null } | null)?.singles_elo ?? null,
        };
      });
      setCandidates(list);
      setLoaded(true);
      if (presetOpponentId) {
        const preset = list.find((c) => c.id === presetOpponentId);
        if (preset) {
          setOpponent(preset);
          setStep(1);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, presetOpponentId]);

  if (!open) return null;

  const filtered = candidates.filter((c) =>
    c.full_name.toLowerCase().includes(search.trim().toLowerCase())
  );

  async function send() {
    if (!opponent) return;
    setSubmitting(true);
    try {
      await createChallenge({
        type,
        rated_flag: true,
        format: matchFormat,
        event_type: 'rated_challenge',
        opponent_id: opponent.id,
        scheduled_date: date || undefined,
        scheduled_time: time || undefined,
        note: note.trim() || undefined,
      });
      toast('Challenge sent', 'success');
      router.refresh();
      onClose();
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setSubmitting(false);
  }

  return (
    <div
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(10,10,10,0.6)',
        zIndex: 200,
        display: 'flex',
        alignItems: 'flex-end',
        animation: 'fadeIn 200ms ease both',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          background: 'var(--surface1)',
          borderTop: '1px solid var(--hairline)',
          maxHeight: '90%',
          display: 'flex',
          flexDirection: 'column',
          animation: 'slideUp 280ms ease both',
        }}
      >
        <div
          style={{
            padding: '16px 24px',
            borderBottom: '1px solid var(--hairline)',
            display: 'flex',
            alignItems: 'center',
            gap: 12,
          }}
        >
          <div style={{ flex: 1 }}>
            <Eyebrow>Step {step + 1} of 2</Eyebrow>
            <div style={{ fontSize: 18, fontWeight: 600, marginTop: 4 }}>
              {step === 0 ? 'Choose opponent' : 'Confirm challenge'}
            </div>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            style={{
              width: 36,
              height: 36,
              background: 'transparent',
              border: '1px solid var(--hairline)',
              color: '#F2F2F2',
              fontSize: 18,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            ×
          </button>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>
          {step === 0 ? (
            <>
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="SEARCH PLAYERS"
                style={{
                  width: '100%',
                  height: 44,
                  background: 'var(--surface1)',
                  border: '1px solid var(--hairline)',
                  color: '#F2F2F2',
                  padding: '0 14px',
                  fontSize: 12,
                  fontWeight: 600,
                  letterSpacing: '0.65px',
                  textTransform: 'uppercase',
                  marginBottom: 16,
                  fontFamily: 'inherit',
                  boxSizing: 'border-box',
                }}
              />
              {!loaded ? (
                <div style={{ textAlign: 'center', padding: 40, color: 'var(--text)', fontSize: 12 }}>
                  Loading…
                </div>
              ) : filtered.length === 0 ? (
                <div style={{ textAlign: 'center', padding: 40, color: 'var(--text)', fontSize: 12 }}>
                  No players found.
                </div>
              ) : (
                <div style={{ background: 'var(--surface1)', border: '1px solid var(--hairline)' }}>
                  {filtered.slice(0, 20).map((p, i) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => {
                        setOpponent(p);
                        setStep(1);
                      }}
                      style={{
                        width: '100%',
                        padding: '12px 16px',
                        background: 'transparent',
                        border: 'none',
                        borderTop: i === 0 ? 'none' : '1px solid var(--hairline)',
                        color: '#F2F2F2',
                        fontFamily: 'inherit',
                        cursor: 'pointer',
                        display: 'flex',
                        alignItems: 'center',
                        gap: 12,
                        textAlign: 'left',
                      }}
                    >
                      <Avatar name={p.full_name} src={p.avatar_url} size={36} />
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <div style={{ fontSize: 13, fontWeight: 600 }}>{p.full_name}</div>
                        <div
                          style={{
                            fontSize: 10,
                            color: 'var(--dim)',
                            letterSpacing: '0.65px',
                            textTransform: 'uppercase',
                            fontWeight: 600,
                          }}
                        >
                          ELO {p.singles_elo ?? '—'}
                        </div>
                      </div>
                      <span style={{ color: 'var(--dim)', fontSize: 18 }}>›</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              {opponent && (
                <div
                  style={{
                    background: 'var(--surface1)',
                    border: '1px solid var(--hairline)',
                    borderLeft: '3px solid var(--red)',
                    padding: 24,
                    marginBottom: 20,
                    textAlign: 'center',
                  }}
                >
                  <div style={{ display: 'inline-block' }}>
                    <Avatar name={opponent.full_name} src={opponent.avatar_url} size={64} ring />
                  </div>
                  <div style={{ fontSize: 18, fontWeight: 700, marginTop: 12 }}>
                    {opponent.full_name}
                  </div>
                  <div
                    style={{
                      fontSize: 11,
                      color: 'var(--text)',
                      letterSpacing: '0.65px',
                      textTransform: 'uppercase',
                      fontWeight: 600,
                      marginTop: 2,
                    }}
                  >
                    ELO {opponent.singles_elo ?? '—'}
                  </div>
                </div>
              )}
              <div
                style={{
                  fontSize: 10,
                  fontWeight: 600,
                  letterSpacing: '1.6px',
                  textTransform: 'uppercase',
                  color: 'var(--text)',
                  marginBottom: 12,
                }}
              >
                Match Type
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 20 }}>
                {(['singles', 'doubles'] as const).map((t) => {
                  const active = type === t;
                  return (
                    <button
                      key={t}
                      type="button"
                      onClick={() => setType(t)}
                      style={{
                        padding: '14px',
                        background: active ? 'var(--red)' : 'var(--surface1)',
                        color: '#F2F2F2',
                        border: active ? 'none' : '1px solid var(--hairline)',
                        fontSize: 12,
                        fontWeight: 700,
                        letterSpacing: '1.4px',
                        textTransform: 'uppercase',
                        cursor: 'pointer',
                        fontFamily: 'inherit',
                      }}
                    >
                      {t}
                    </button>
                  );
                })}
              </div>

              <FieldLabel>Score format</FieldLabel>
              <select
                value={matchFormat}
                onChange={(e) => setMatchFormat(e.target.value as MatchFormat)}
                style={fieldStyle}
              >
                {MATCH_FORMAT_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginTop: 16 }}>
                <div>
                  <FieldLabel>Date — optional</FieldLabel>
                  <input
                    type="date"
                    value={date}
                    onChange={(e) => setDate(e.target.value)}
                    style={fieldStyle}
                  />
                </div>
                <div>
                  <FieldLabel>Time — optional</FieldLabel>
                  <input
                    type="time"
                    value={time}
                    onChange={(e) => setTime(e.target.value)}
                    style={fieldStyle}
                  />
                </div>
              </div>

              <div style={{ marginTop: 16 }}>
                <div
                  style={{
                    display: 'flex',
                    alignItems: 'baseline',
                    justifyContent: 'space-between',
                  }}
                >
                  <FieldLabel>Message — optional</FieldLabel>
                  <span
                    style={{
                      fontSize: 10,
                      color: note.length > NOTE_MAX ? 'var(--red)' : 'var(--dim)',
                      fontFamily: 'JetBrains Mono, monospace',
                      letterSpacing: '0.04em',
                    }}
                    aria-live="polite"
                  >
                    {note.length}/{NOTE_MAX}
                  </span>
                </div>
                <textarea
                  value={note}
                  onChange={(e) => setNote(e.target.value.slice(0, NOTE_MAX))}
                  rows={3}
                  placeholder="Court A or B? Bring extra shuttles?"
                  style={{ ...fieldStyle, resize: 'vertical', minHeight: 72 }}
                />
              </div>

              <div style={{ height: 20 }} />
              <CTAButton size="lg" full disabled={submitting} onClick={send}>
                {submitting ? 'Sending…' : 'Send Challenge →'}
              </CTAButton>
              <div style={{ height: 12 }} />
              <CTAButton variant="ghost" size="md" full onClick={() => setStep(0)}>
                ← Choose someone else
              </CTAButton>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
