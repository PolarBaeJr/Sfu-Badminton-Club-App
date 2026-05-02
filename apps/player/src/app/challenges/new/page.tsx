'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@badminton/shared/supabase-browser';
import { Select, Textarea } from '@badminton/ui';
import { MATCH_FORMAT_LABELS, previewEloChange } from '@badminton/shared';
import { createChallenge } from '@/lib/actions';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/toast-provider';
import {
  Swords,
  ArrowLeft,
  TrendingUp,
  TrendingDown,
  Send,
  Zap,
  Info,
  Calendar,
} from 'lucide-react';
import Link from 'next/link';
import { FadeIn } from '@/components/motion-wrapper';

interface PlayerOption {
  id: string;
  full_name: string;
  singles_elo: number;
  doubles_elo: number;
}

export default function NewChallengePage() {
  const [type, setType] = useState<'singles' | 'doubles'>('singles');
  const [rated, setRated] = useState(true);
  const [format, setFormat] = useState('single_21');
  const [opponentId, setOpponentId] = useState('');
  const [partnerId, setPartnerId] = useState('');
  const [opponentPartnerId, setOpponentPartnerId] = useState('');
  const [note, setNote] = useState('');
  const [scheduledDate, setScheduledDate] = useState('');
  const [scheduledTime, setScheduledTime] = useState('');
  const [loading, setLoading] = useState(false);
  const [players, setPlayers] = useState<PlayerOption[]>([]);
  const [myElo, setMyElo] = useState({ singles: 1200, doubles: 1200 });
  const router = useRouter();
  const { toast } = useToast();

  useEffect(() => {
    async function load() {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data: me } = await supabase
        .from('players')
        .select('id, ratings(singles_elo, doubles_elo)')
        .eq('user_id', user.id)
        .single();

      if (me) {
        const r = Array.isArray(me.ratings) ? me.ratings[0] : me.ratings;
        setMyElo({ singles: r?.singles_elo ?? 1200, doubles: r?.doubles_elo ?? 1200 });
      }

      const { data } = await supabase
        .from('players')
        .select('id, full_name, ratings(singles_elo, doubles_elo)')
        .eq('active_flag', true)
        .not('status', 'in', '("pending_approval","suspended","inactive")')
        .neq('id', me?.id ?? '');

      setPlayers((data || []).map((p) => {
        const r = Array.isArray(p.ratings) ? p.ratings[0] : p.ratings;
        return {
          id: p.id,
          full_name: p.full_name,
          singles_elo: r?.singles_elo ?? 1200,
          doubles_elo: r?.doubles_elo ?? 1200,
        };
      }));
    }
    load();
  }, []);

  const opponent = players.find((p) => p.id === opponentId);
  const myRating = type === 'singles' ? myElo.singles : myElo.doubles;
  const oppRating = opponent ? (type === 'singles' ? opponent.singles_elo : opponent.doubles_elo) : 0;
  const eloPreview = opponent ? previewEloChange(
    myRating,
    oppRating,
    format as 'single_21' | 'bo3_21' | 'single_15' | 'single_11',
    rated ? 'rated_challenge' : 'casual',
    type,
    true
  ) : null;
  const winProbability = opponent
    ? Math.round((1 / (1 + Math.pow(10, (oppRating - myRating) / 400))) * 100)
    : null;
  const eloGap = opponent ? myRating - oppRating : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!opponentId) { toast('Select an opponent', 'error'); return; }
    setLoading(true);
    try {
      await createChallenge({
        type,
        rated_flag: rated,
        event_type: rated ? 'rated_challenge' : 'casual',
        format: format as 'single_21' | 'bo3_21' | 'single_15' | 'single_11',
        opponent_id: opponentId,
        partner_id: type === 'doubles' && partnerId ? partnerId : undefined,
        opponent_partner_id: type === 'doubles' && opponentPartnerId ? opponentPartnerId : undefined,
        note: note || undefined,
        scheduled_date: scheduledDate || undefined,
        scheduled_time: scheduledTime || undefined,
      });
      toast('Challenge sent!', 'success');
      router.push('/challenges');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to create challenge', 'error');
    }
    setLoading(false);
  }

  const playerOptions = players.map((p) => ({
    value: p.id,
    label: `${p.full_name} (${type === 'singles' ? p.singles_elo : p.doubles_elo})`,
  }));

  return (
    <div className="max-w-lg mx-auto space-y-5 pb-28 px-4 sm:px-0">
      {/* Back link */}
      <Link
        href="/challenges"
        className="inline-flex items-center gap-1.5 text-sm text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors duration-150 group min-h-[44px] py-2"
      >
        <ArrowLeft className="w-4 h-4 transition-transform duration-150 group-hover:-translate-x-0.5" />
        Back to Challenges
      </Link>

      <FadeIn>
        {/* Page header */}
        <div className="flex items-center gap-3 mb-5">
          <div className="w-10 h-10 bg-[var(--bg-accent)] flex items-center justify-center shrink-0 border-[0.5px] border-[var(--accent-border)]">
            <Swords className="w-4 h-4 text-[var(--accent)]" />
          </div>
          <div>
            <p className="text-[10px] tracking-[0.04em] uppercase text-[var(--text-muted)]">Create</p>
            <h1 className="text-[20px] font-medium text-[var(--text-primary)] mt-1">New Challenge</h1>
          </div>
        </div>

        <div className="bg-[var(--bg-card)] p-5 border-[0.5px] border-[var(--border)]">
          <form onSubmit={handleSubmit} className="space-y-5">

            {/* Match Type Toggle */}
            <div>
              <label className="block mb-2 text-[10px] tracking-[0.04em] uppercase text-[var(--text-muted)]">Match Type</label>
              <div className="flex gap-2">
                {(['singles', 'doubles'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setType(t)}
                    aria-pressed={type === t}
                    className={`flex-1 min-h-[40px] text-[13px] font-medium capitalize transition-colors duration-150 press border-[0.5px] active:scale-[0.99] ${
                      type === t
                        ? 'bg-[var(--bg-accent)] border-[var(--accent-border)] text-[var(--accent)] hover:border-[var(--accent)]'
                        : 'bg-[var(--bg-card)] border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
                    }`}
                  >
                    <span className="flex items-center justify-center gap-1.5">
                      <Swords className="w-3.5 h-3.5" /> {t === 'singles' ? 'Singles' : 'Doubles'}
                    </span>
                  </button>
                ))}
              </div>
            </div>

            <Select
              label="Opponent"
              value={opponentId}
              onChange={(e) => setOpponentId(e.target.value)}
              options={[{ value: '', label: 'Select opponent...' }, ...playerOptions]}
            />

            {type === 'doubles' && (
              <>
                <Select
                  label="Your Partner"
                  value={partnerId}
                  onChange={(e) => setPartnerId(e.target.value)}
                  options={[{ value: '', label: 'Select partner...' }, ...playerOptions.filter((p) => p.value !== opponentId)]}
                />
                <Select
                  label="Opponent's Partner"
                  value={opponentPartnerId}
                  onChange={(e) => setOpponentPartnerId(e.target.value)}
                  options={[{ value: '', label: 'Select...' }, ...playerOptions.filter((p) => p.value !== opponentId && p.value !== partnerId)]}
                />
              </>
            )}

            <Select
              label="Format"
              value={format}
              onChange={(e) => setFormat(e.target.value)}
              options={Object.entries(MATCH_FORMAT_LABELS).map(([value, label]) => ({ value, label }))}
            />

            {/* Rated Toggle */}
            <div>
              <label className="block mb-2 text-[10px] tracking-[0.04em] uppercase text-[var(--text-muted)]">Rating Impact</label>
              <button
                type="button"
                onClick={() => setRated(!rated)}
                aria-pressed={rated}
                className={`w-full min-h-[40px] text-[13px] font-medium flex items-center justify-center gap-2 transition-colors duration-150 press border-[0.5px] active:scale-[0.99] ${
                  rated
                    ? 'bg-[var(--bg-accent)] border-[var(--accent-border)] text-[var(--accent)] hover:border-[var(--accent)]'
                    : 'bg-[var(--bg-card)] border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:border-[var(--border-strong)]'
                }`}
              >
                <Zap className={`w-3.5 h-3.5 transition-transform duration-200 ${rated ? 'scale-110' : ''}`} />
                {rated ? 'Rated Match' : 'Casual (No Elo change)'}
              </button>
            </div>

            {/* Matchup Preview */}
            {opponent && rated && eloPreview && winProbability !== null && eloGap !== null && (
              <div className="bg-[var(--bg-card)] p-5 border-[0.5px] border-[var(--border)] overflow-hidden">
                <div className="flex items-center gap-2 mb-4">
                  <Info className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                  <span className="text-[10px] tracking-[0.04em] uppercase text-[var(--text-muted)]">Matchup Preview</span>
                </div>

                {/* Win probability bar */}
                <div className="mb-4">
                  <div className="flex items-baseline justify-between mb-2">
                    <span className="text-[10px] tracking-[0.04em] uppercase text-[var(--text-muted)]">Win probability</span>
                    <span className="text-[20px] font-medium text-[var(--accent)] tabular-nums">{winProbability}%</span>
                  </div>
                  <div className="relative h-1.5 w-full rounded-full bg-[var(--border)] overflow-hidden">
                    <div
                      className="absolute inset-y-0 left-0 rounded-full bg-[var(--accent)] transition-[width] duration-300"
                      style={{ width: `${winProbability}%` }}
                    />
                  </div>
                  <div className="mt-1.5 flex items-center justify-between text-[10px] text-[var(--text-faint)] tabular-nums tracking-[0.04em] uppercase">
                    <span>Elo Δ {eloGap >= 0 ? '+' : ''}{eloGap}</span>
                    <span>Your {myRating} · Opp {oppRating}</span>
                  </div>
                </div>

                {/* Delta split */}
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex items-center gap-2 bg-[var(--bg-accent)] border-[0.5px] border-[var(--accent-border)] px-3 py-2.5">
                    <TrendingUp className="w-3.5 h-3.5 text-[var(--accent)] shrink-0" />
                    <div>
                      <p className="text-[10px] tracking-[0.04em] uppercase text-[var(--text-muted)]">On Win</p>
                      <p className="text-[15px] font-medium text-[var(--accent)] tabular-nums">+{eloPreview.winDelta}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 bg-[var(--bg-loss)] border-[0.5px] border-[var(--loss-border)] px-3 py-2.5">
                    <TrendingDown className="w-3.5 h-3.5 text-[var(--loss)] shrink-0" />
                    <div>
                      <p className="text-[10px] tracking-[0.04em] uppercase text-[var(--text-muted)]">On Loss</p>
                      <p className="text-[15px] font-medium text-[var(--loss)] tabular-nums">{eloPreview.lossDelta}</p>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Scheduled Date/Time */}
            <div>
              <label className="block mb-2 text-[10px] tracking-[0.04em] uppercase text-[var(--text-muted)]">
                <span className="flex items-center gap-1.5">
                  <Calendar className="w-3.5 h-3.5" />
                  When to Play (optional)
                </span>
              </label>
              <div className="grid grid-cols-2 gap-3">
                <input
                  id="scheduled_date"
                  name="scheduled_date"
                  type="date"
                  value={scheduledDate}
                  onChange={(e) => setScheduledDate(e.target.value)}
                  min={new Date().toISOString().split('T')[0]}
                  className="bg-[var(--bg-card)] border-[0.5px] border-[var(--border)] px-3 text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:border-transparent transition-colors min-h-[40px] w-full"
                />
                <input
                  id="scheduled_time"
                  name="scheduled_time"
                  type="time"
                  value={scheduledTime}
                  onChange={(e) => setScheduledTime(e.target.value)}
                  className="bg-[var(--bg-card)] border-[0.5px] border-[var(--border)] px-3 text-[13px] text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent)] focus-visible:border-transparent transition-colors min-h-[40px] w-full"
                />
              </div>
            </div>

            <Textarea
              label="Note (optional)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Any message for your opponent..."
            />

            <button
              type="submit"
              disabled={loading}
              className="press w-full inline-flex items-center justify-center gap-2 min-h-[44px] bg-[var(--bg-accent)] border-[0.5px] border-[var(--accent-border)] text-[var(--accent)] text-[13px] font-medium hover:border-[var(--accent)] transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {!loading && <Send className="w-3.5 h-3.5" />}
              Send Challenge
            </button>
          </form>
        </div>
      </FadeIn>
    </div>
  );
}
