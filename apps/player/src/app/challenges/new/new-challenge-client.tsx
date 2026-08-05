'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { Select, Input, Textarea, DatePicker, Button, PlayerPicker } from '@badminton/ui';
import { previewEloChange } from '@badminton/shared';
import { createChallenge } from '@/lib/actions';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/toast-provider';
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
  avatar_url?: string | null;
  singles_elo: number;
  doubles_elo: number;
}

export default function NewChallengeClient({ initialOpponentId }: { initialOpponentId?: string }) {
  const [type, setType] = useState<'singles' | 'doubles'>('singles');
  const [rated, setRated] = useState(true);
  // Custom shape: "best of X games to Y points". Held as text so the fields can
  // be cleared while typing; only sent when the Custom option is chosen.
  const [customGames, setCustomGames] = useState('3');
  const [customPoints, setCustomPoints] = useState('21');
  // Every challenge now carries an explicit shape, so the enum is only the
  // fallback the DB coalesces to when the custom columns are null.
  const isCustom = true;
  const format = Number(customGames) > 1 ? 'bo3_21' : 'single_21';
  // Checked here as well as by the CHECK constraint, so the form never submits
  // a shape the database will refuse.
  const pointsInvalid = isCustom && (Number(customPoints) < 5 || Number(customPoints) > 30 || !customPoints);
  const [opponentId, setOpponentId] = useState(initialOpponentId ?? '');
  const [partnerId, setPartnerId] = useState('');
  const [opponentPartnerId, setOpponentPartnerId] = useState('');
  const [note, setNote] = useState('');
  const [scheduledDate, setScheduledDate] = useState('');
  const [scheduledTime, setScheduledTime] = useState('');
  const [loading, setLoading] = useState(false);
  const [players, setPlayers] = useState<PlayerOption[]>([]);
  const [myElo, setMyElo] = useState({ singles: 400, doubles: 400 });
  const [myName, setMyName] = useState('');
  const router = useRouter();
  const { toast } = useToast();

  useEffect(() => {
    async function load() {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data: me } = await supabase
        .from('players')
        .select('id, full_name, ratings(singles_elo, doubles_elo)')
        .eq('user_id', user.id)
        .single();

      if (me) {
        const r = Array.isArray(me.ratings) ? me.ratings[0] : me.ratings;
        setMyElo({ singles: r?.singles_elo ?? 400, doubles: r?.doubles_elo ?? 400 });
        setMyName(me.full_name ?? '');
      }

      const { data } = await supabase
        .from('players')
        .select('id, full_name, avatar_url, ratings(singles_elo, doubles_elo)')
        .eq('active_flag', true)
        .not('status', 'in', '("pending_approval","suspended")')
        .neq('id', me?.id ?? '');

      const options = (data || []).map((p) => {
        const r = Array.isArray(p.ratings) ? p.ratings[0] : p.ratings;
        return {
          id: p.id,
          full_name: p.full_name,
          singles_elo: r?.singles_elo ?? 400,
          doubles_elo: r?.doubles_elo ?? 400,
        };
      });
      setPlayers(options);

      // ?opponent= (the profile QR target) can name someone who is no longer
      // challengeable — deactivated, suspended, pending_approval — or the
      // scanner themselves. The query above already excludes all of those, so
      // absence from the list means the prefill is stale: clear it rather than
      // leave the form looking armed. UX only; validate_challenge_creation
      // remains the authority on whether the challenge is allowed.
      if (initialOpponentId && !options.some((p) => p.id === initialOpponentId)) {
        setOpponentId('');
        toast("That player can't be challenged right now.", 'error');
      }
    }
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const opponent = players.find((p) => p.id === opponentId);
  const eloPreview = opponent ? previewEloChange(
    type === 'singles' ? myElo.singles : myElo.doubles,
    type === 'singles' ? opponent.singles_elo : opponent.doubles_elo,
    (isCustom ? (Number(customGames) > 1 ? 'bo3_21' : 'single_21') : format) as 'single_21' | 'bo3_21' | 'single_15' | 'single_11',
    rated ? 'rated_challenge' : 'casual',
    type,
    true,
    undefined,
    undefined,
    isCustom
      ? { gamesPerMatch: Number(customGames) || 3, pointsPerGame: Number(customPoints) || 21 }
      : undefined,
  ) : null;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!opponentId) { toast('Select an opponent', 'error'); return; }
    if (pointsInvalid) { toast('Points per game must be between 5 and 30', 'error'); return; }
    setLoading(true);
    try {
      const res = await createChallenge({
        type,
        rated_flag: rated,
        event_type: rated ? 'rated_challenge' : 'casual',
        // The enum stays the fallback the DB coalesces to; the custom columns
        // win when present (migration 00031).
        format: (isCustom
          ? (Number(customGames) > 1 ? 'bo3_21' : 'single_21')
          : format) as 'single_21' | 'bo3_21' | 'single_15' | 'single_11',
        ...(isCustom
          ? { games_per_match: Number(customGames) || 3, points_per_game: Number(customPoints) || 21 }
          : {}),
        opponent_id: opponentId,
        partner_id: type === 'doubles' && partnerId ? partnerId : undefined,
        opponent_partner_id: type === 'doubles' && opponentPartnerId ? opponentPartnerId : undefined,
        note: note || undefined,
        scheduled_date: scheduledDate || undefined,
        scheduled_time: scheduledTime || undefined,
      });
      if (!res.ok) { toast(res.error, 'error'); setLoading(false); return; }
      toast('Challenge sent!', 'success');
      router.push('/challenges');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed to create challenge', 'error');
    }
    setLoading(false);
  }

  // Rating goes in `meta`, not the label. Glued into the name it made the
  // search match "(1423)" as if it were part of someone's name; as a secondary
  // line it stays visible AND searchable without polluting the name.
  const playerOptions = players.map((p) => ({
    id: p.id,
    name: p.full_name,
    avatarUrl: p.avatar_url ?? null,
    meta: String(type === 'singles' ? p.singles_elo : p.doubles_elo),
  }));

  // Nobody can fill two slots on the court. Each select drops whoever is
  // already chosen elsewhere, while keeping its own current value so the field
  // still shows what it is set to. This has to be symmetric now that the fields
  // are grouped by side: the old one-directional filters only worked because
  // Opponent was always picked first.
  const availableFor = (current: string) =>
    playerOptions.filter(
      (p) => p.id === current || ![opponentId, partnerId, opponentPartnerId].includes(p.id),
    );

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

            {/* Grouped by side. Listing Opponent between "Your Partner" and
                "Opponent's Partner" interleaved the two halves, so the form read
                as three unrelated people instead of two pairs. Your side first,
                since that is the half the player already knows. */}
            {type === 'doubles' ? (
              <>
                <div className="space-y-3">
                  <label className="eyebrow block">Your Side</label>
                  {/* Static, not a disabled <Select> — you are never a choice,
                      and a greyed-out dropdown reads as "not available yet". */}
                  <div>
                    <label className="eyebrow block mb-2">You</label>
                    <div className="flex items-center justify-between rounded-xl border border-[var(--border)] bg-white/[0.03] px-3 min-h-[44px] text-sm text-[var(--text-secondary)]">
                      <span>{myName || 'You'}</span>
                      <span className="mono text-xs text-[var(--text-muted)]">{myElo.doubles}</span>
                    </div>
                  </div>
                  <PlayerPicker
                    label="Partner"
                    value={partnerId}
                    onChange={setPartnerId}
                    players={availableFor(partnerId)}
                    placeholder="Search for a partner…"
                  />
                </div>

                <div className="space-y-3">
                  <label className="eyebrow block">Opponents</label>
                  <PlayerPicker
                    label="Opponent"
                    value={opponentId}
                    onChange={setOpponentId}
                    players={availableFor(opponentId)}
                    placeholder="Search for an opponent…"
                  />
                  <PlayerPicker
                    label="Their Partner"
                    value={opponentPartnerId}
                    onChange={setOpponentPartnerId}
                    players={availableFor(opponentPartnerId)}
                    placeholder="Search…"
                  />
                </div>
              </>
            ) : (
              <PlayerPicker
                label="Opponent"
                value={opponentId}
                onChange={setOpponentId}
                players={availableFor(opponentId)}
                placeholder="Search for an opponent…"
              />
            )}

            {/* The four presets were just (games, points) pairs — "Best of 3 to
                21" is 3 and 21 — so the dropdown only added a step. Pick the two
                numbers directly; the defaults are the old bo3_21. */}
            <div className="grid grid-cols-2 gap-3">
              <Select
                label="Best of (games)"
                  value={customGames}
                  onChange={(e) => setCustomGames(e.target.value)}
                  options={[
                    { value: '1', label: '1 game' },
                    { value: '3', label: 'Best of 3' },
                    { value: '5', label: 'Best of 5' },
                    { value: '7', label: 'Best of 7' },
                  ]}
                />
                <Input
                  label="Points per game"
                  type="text"
                  inputMode="numeric"
                  value={customPoints}
                  onChange={(e) => setCustomPoints(e.target.value.replace(/\D/g, '').slice(0, 2))}
                  placeholder="21"
                />
                <p className="col-span-2 text-xs text-[var(--mute)]">
                  {pointsInvalid
                    ? 'Points per game must be between 5 and 30.'
                    : `A game is won by two clear points, or at ${(Number(customPoints) || 21) + 9}.`}
                </p>
            </div>

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
                <DatePicker
                  value={scheduledDate}
                  onChange={setScheduledDate}
                  placeholder="Pick a date"
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
              disabled={loading || pointsInvalid}
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
