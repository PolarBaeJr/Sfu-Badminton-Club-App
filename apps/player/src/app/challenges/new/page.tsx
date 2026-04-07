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
  Clock,
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
    <div className="max-w-lg mx-auto space-y-6">
      <Link href="/challenges" className="inline-flex items-center gap-1.5 text-sm text-[#64748B] hover:text-[#94A3B8] transition-colors">
        <ArrowLeft className="w-4 h-4" />
        Back to Challenges
      </Link>

      <motion.div
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
      >
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-xl bg-[#EF4444]/10 flex items-center justify-center">
            <Swords className="w-5 h-5 text-[#EF4444]" />
          </div>
          <h1 className="text-3xl font-black font-display text-shuttle-white tracking-wider uppercase">
            New Challenge
          </h1>
        </div>

        <div className="bg-[#161B2E] border border-white/[0.06] rounded-xl p-6">
          <form onSubmit={handleSubmit} className="space-y-5">
            {/* Type Toggle */}
            <div>
              <label className="block text-sm text-[#94A3B8] font-medium mb-2">Match Type</label>
              <div className="flex gap-2">
                {(['singles', 'doubles'] as const).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setType(t)}
                    className={`flex-1 py-3 rounded-xl text-sm font-bold capitalize transition-all duration-200 ${
                      type === t
                        ? 'bg-[#EF4444]/15 border border-[#EF4444]/30 text-[#EF4444]'
                        : 'bg-white/[0.03] border border-white/[0.06] text-[#64748B] hover:text-[#94A3B8]'
                    }`}
                  >
                    {t}
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
              <label className="block text-sm text-[#94A3B8] font-medium mb-2">Rating Impact</label>
              <button
                type="button"
                onClick={() => setRated(!rated)}
                className={`w-full py-3 rounded-xl text-sm font-bold flex items-center justify-center gap-2 transition-all duration-200 ${
                  rated
                    ? 'bg-[#FFD700]/10 border border-[#FFD700]/20 text-[#FFD700]'
                    : 'bg-white/[0.03] border border-white/[0.06] text-[#64748B]'
                }`}
              >
                <Zap className="w-4 h-4" />
                {rated ? 'Rated Match' : 'Casual (No Elo change)'}
              </button>
            </div>

            {/* Elo Preview */}
            {eloPreview && rated && (
              <motion.div
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                className="bg-white/[0.03] border border-white/[0.06] rounded-xl p-4"
              >
                <div className="flex items-center gap-2 mb-3">
                  <Info className="w-3.5 h-3.5 text-[#94A3B8]" />
                  <span className="text-xs text-[#94A3B8] font-medium uppercase tracking-wider">Elo Preview</span>
                </div>
                <div className="flex justify-between">
                  <div className="flex items-center gap-2">
                    <TrendingUp className="w-4 h-4 text-emerald-400" />
                    <span className="text-sm font-bold text-emerald-400">Win: +{eloPreview.winDelta}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <TrendingDown className="w-4 h-4 text-[#EF4444]" />
                    <span className="text-sm font-bold text-[#EF4444]">Loss: {eloPreview.lossDelta}</span>
                  </div>
                </div>
              </motion.div>
            )}

            {/* Scheduled Date/Time */}
            <div>
              <label className="block text-sm text-[#94A3B8] font-medium mb-2">
                <span className="flex items-center gap-1.5">
                  <Calendar className="w-3.5 h-3.5" />
                  When to Play (optional)
                </span>
              </label>
              <div className="grid grid-cols-2 gap-3">
                <input
                  type="date"
                  value={scheduledDate}
                  onChange={(e) => setScheduledDate(e.target.value)}
                  min={new Date().toISOString().split('T')[0]}
                  className="bg-[var(--bg-secondary)] border border-white/[0.06] rounded-xl px-3 py-3 text-sm text-[var(--text-primary)] placeholder:text-[#64748B] focus:outline-none focus:ring-2 focus:ring-[#EF4444]/40 focus:border-transparent transition-colors"
                />
                <input
                  type="time"
                  value={scheduledTime}
                  onChange={(e) => setScheduledTime(e.target.value)}
                  className="bg-[var(--bg-secondary)] border border-white/[0.06] rounded-xl px-3 py-3 text-sm text-[var(--text-primary)] placeholder:text-[#64748B] focus:outline-none focus:ring-2 focus:ring-[#EF4444]/40 focus:border-transparent transition-colors"
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
              className="w-full h-12 bg-gradient-to-r from-[#EF4444] to-[#DC2626] hover:from-[#DC2626] hover:to-[#B91C1C] text-white font-bold tracking-wide shadow-lg shadow-[#EF4444]/20 hover:shadow-[#EF4444]/30 transition-all duration-300"
            >
              {loading ? (
                <Loader2 className="w-5 h-5 animate-spin mr-2" />
              ) : (
                <Send className="w-4 h-4 mr-2" />
              )}
              Send Challenge
            </Button>
          </form>
        </div>
      </motion.div>
    </div>
  );
}
