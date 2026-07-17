'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { Select, Input, Textarea } from '@badminton/ui';
import { MATCH_FORMAT_LABELS, previewEloChange } from '@badminton/shared';
import { createChallenge } from '@/lib/actions';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/toast-provider';
import { Button } from '@/components/ui/button';
import { motion } from 'framer-motion';
import {
  Swords,
  ArrowLeft,
  TrendingUp,
  TrendingDown,
  Send,
  Loader2,
  Zap,
  Info,
  Calendar,
} from 'lucide-react';
import Link from 'next/link';

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
  const [myElo, setMyElo] = useState({ singles: 400, doubles: 400 });
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
        setMyElo({ singles: r?.singles_elo ?? 400, doubles: r?.doubles_elo ?? 400 });
      }

      const { data } = await supabase
        .from('players')
        .select('id, full_name, ratings(singles_elo, doubles_elo)')
        .eq('active_flag', true)
        .not('status', 'in', '("pending_approval","suspended")')
        .neq('id', me?.id ?? '');

      setPlayers((data || []).map((p) => {
        const r = Array.isArray(p.ratings) ? p.ratings[0] : p.ratings;
        return {
          id: p.id,
          full_name: p.full_name,
          singles_elo: r?.singles_elo ?? 400,
          doubles_elo: r?.doubles_elo ?? 400,
        };
      }));
    }
    load();
  }, []);

  const opponent = players.find((p) => p.id === opponentId);
  const eloPreview = opponent ? previewEloChange(
    type === 'singles' ? myElo.singles : myElo.doubles,
    type === 'singles' ? opponent.singles_elo : opponent.doubles_elo,
    format as 'single_21' | 'bo3_21' | 'single_15' | 'single_11',
    rated ? 'rated_challenge' : 'casual',
    type,
    true
  ) : null;

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

      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.38, ease: [0.16, 1, 0.3, 1] }}
      >
        {/* Page header */}
        <div className="flex items-center gap-3 mb-5">
          <div className="w-11 h-11 rounded-xl bg-[var(--color-accent)]/10 flex items-center justify-center glow-red shrink-0">
            <Swords className="w-5 h-5 text-[var(--color-accent)]" />
          </div>
          <div>
            <p className="eyebrow">Create</p>
            <h1 className="display-lg">New Challenge</h1>
          </div>
        </div>

        <div className="card-elevated rounded-xl p-5 bg-court-lines">
          <form onSubmit={handleSubmit} className="space-y-5">

            {/* Match Type Toggle */}
            <div>
              <label className="eyebrow block mb-2">Match Type</label>
              <div className="flex gap-2">
                {(['singles', 'doubles'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setType(t)}
                    className={`flex-1 min-h-[44px] py-2.5 rounded-xl text-sm font-bold capitalize transition-all duration-200 press border ${
                      type === t
                        ? 'bg-[var(--color-accent)]/15 border-[var(--color-accent)]/30 text-[var(--color-accent)] glow-red'
                        : 'bg-white/[0.03] border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:border-[var(--border-hover)]'
                    }`}
                  >
                    {t === 'singles' ? (
                      <span className="flex items-center justify-center gap-1.5">
                        <Swords className="w-3.5 h-3.5" /> Singles
                      </span>
                    ) : (
                      <span className="flex items-center justify-center gap-1.5">
                        <Swords className="w-3.5 h-3.5" /> Doubles
                      </span>
                    )}
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
              <label className="eyebrow block mb-2">Rating Impact</label>
              <button
                type="button"
                onClick={() => setRated(!rated)}
                className={`w-full min-h-[44px] py-3 rounded-xl text-sm font-bold flex items-center justify-center gap-2 transition-all duration-200 press border ${
                  rated
                    ? 'bg-[var(--color-gold)]/10 border-[var(--color-gold)]/25 text-[var(--color-gold)] glow-gold'
                    : 'bg-white/[0.03] border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--border-hover)]'
                }`}
              >
                <Zap className={`w-4 h-4 transition-transform duration-200 ${rated ? 'scale-110' : ''}`} />
                {rated ? 'Rated Match' : 'Casual (No Elo change)'}
              </button>
            </div>

            {/* Elo Preview */}
            {eloPreview && rated && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={{ duration: 0.25 }}
                className="card-surface rounded-xl p-4 overflow-hidden"
              >
                <div className="flex items-center gap-2 mb-3">
                  <Info className="w-3.5 h-3.5 text-[var(--text-muted)]" />
                  <span className="eyebrow">Elo Preview</span>
                </div>
                <div className="flex justify-between gap-3">
                  <div className="flex items-center gap-2 bg-[var(--color-success)]/5 rounded-lg px-3 py-2 flex-1">
                    <TrendingUp className="w-4 h-4 text-[var(--color-success)] shrink-0" />
                    <div>
                      <p className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide">Win</p>
                      <p className="nums text-base font-black text-[var(--color-success)]">+{eloPreview.winDelta}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2 bg-[var(--color-accent)]/5 rounded-lg px-3 py-2 flex-1">
                    <TrendingDown className="w-4 h-4 text-[var(--color-accent)] shrink-0" />
                    <div>
                      <p className="text-[10px] text-[var(--text-muted)] uppercase tracking-wide">Loss</p>
                      <p className="nums text-base font-black text-[var(--color-accent)]">{eloPreview.lossDelta}</p>
                    </div>
                  </div>
                </div>
              </motion.div>
            )}

            {/* Scheduled Date/Time */}
            <div>
              <label className="eyebrow block mb-2">
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
                  className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl px-3 py-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/40 focus:border-transparent transition-colors min-h-[44px] w-full"
                />
                <input
                  id="scheduled_time"
                  name="scheduled_time"
                  type="time"
                  value={scheduledTime}
                  onChange={(e) => setScheduledTime(e.target.value)}
                  className="bg-[var(--bg-card)] border border-[var(--border)] rounded-xl px-3 py-3 text-sm text-[var(--text-primary)] placeholder:text-[var(--text-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--color-accent)]/40 focus:border-transparent transition-colors min-h-[44px] w-full"
                />
              </div>
            </div>

            <Textarea
              label="Note (optional)"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="Any message for your opponent..."
            />

            <Button
              type="submit"
              disabled={loading}
              size="lg"
              className="w-full min-h-[52px] btn-primary-cta press"
            >
              {loading ? (
                <Loader2 className="w-5 h-5 animate-spin mr-2" />
              ) : (
                <Send className="w-4 h-4 mr-2 transition-transform duration-150 group-hover:translate-x-0.5" />
              )}
              Send Challenge
            </Button>
          </form>
        </div>
      </motion.div>
    </div>
  );
}
