'use client';

import { useState } from 'react';
import { completeOnboarding } from '@/lib/actions';
import { useRouter } from 'next/navigation';
import { useToast } from '@/components/toast-provider';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent } from '@/components/ui/card';
import { motion, AnimatePresence } from 'framer-motion';
import {
  User,
  Phone,
  Sparkles,
  Trophy,
  Swords,
  TrendingUp,
  ChevronRight,
  ChevronLeft,
  Loader2,
  Rocket,
} from 'lucide-react';

const steps = [
  { number: 1, title: 'Your Profile', subtitle: 'Tell us about yourself' },
  { number: 2, title: 'Ready to Play!', subtitle: 'Your journey begins' },
];

const statCards = [
  { icon: Trophy, label: 'Starting Elo', value: '1200', color: 'var(--color-gold)' },
  { icon: Swords, label: 'Singles & Doubles', value: 'Both', color: 'var(--ds-accent)' },
  { icon: TrendingUp, label: 'Rank', value: 'Unranked', color: 'var(--text-secondary)' },
];

export default function OnboardingPage() {
  const [step, setStep] = useState(1);
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');
  const [loading, setLoading] = useState(false);
  const router = useRouter();
  const { toast } = useToast();

  async function handleComplete() {
    setLoading(true);
    try {
      await completeOnboarding({
        full_name: name,
        display_name: displayName || undefined,
        phone: phone || undefined,
      });
      router.push('/feed');
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-4 py-12 relative overflow-hidden">
      {/* Background effects */}
      <div className="absolute inset-0 pointer-events-none">
        <div className="absolute top-1/3 left-1/3 w-80 h-80 bg-[var(--ds-accent)]/5 rounded-full blur-3xl" />
        <div className="absolute bottom-1/3 right-1/4 w-64 h-64 bg-[var(--color-gold)]/5 rounded-full blur-3xl" />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5 }}
        className="w-full max-w-md relative z-10"
      >
        {/* Header */}
        <div className="text-center mb-6">
          <motion.div
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={{ type: 'spring', bounce: 0.5 }}
            className="w-14 h-14 mx-auto mb-4 rounded-2xl gradient-gold flex items-center justify-center glow-gold"
          >
            <Sparkles className="w-7 h-7 text-[#0A0E1A]" />
          </motion.div>
          <p className="eyebrow mb-1">New Player</p>
          <h1 className="display-lg text-shuttle-white">
            Welcome to the Club
          </h1>
        </div>

        {/* Progress Steps */}
        <div className="flex items-center gap-3 mb-6 px-2">
          {steps.map((s, i) => (
            <div key={s.number} className="flex items-center flex-1">
              <div className="flex items-center gap-2 flex-1">
                <motion.div
                  animate={{
                    backgroundColor: step >= s.number ? 'var(--ds-accent)' : 'var(--on-surface-med)',
                    scale: step === s.number ? 1.1 : 1,
                  }}
                  transition={{ type: 'spring', bounce: 0.4 }}
                  className="w-8 h-8 rounded-full flex items-center justify-center text-sm font-bold shrink-0"
                >
                  <span className={step >= s.number ? 'text-white' : 'text-[var(--text-muted)]'}>
                    {step > s.number ? '✓' : s.number}
                  </span>
                </motion.div>
                <div className="min-w-0">
                  <p className={`text-xs font-semibold truncate ${step >= s.number ? 'text-shuttle-white' : 'text-[var(--text-muted)]'}`}>
                    {s.title}
                  </p>
                </div>
              </div>
              {i < steps.length - 1 && (
                <div className="w-8 mx-2">
                  <div className="h-[2px] rounded-full overflow-hidden bg-white/[0.06]">
                    <motion.div
                      animate={{ width: step > s.number ? '100%' : '0%' }}
                      transition={{ duration: 0.4 }}
                      className="h-full bg-[var(--ds-accent)] rounded-full"
                    />
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>

        {/* Card */}
        <Card className="bg-[var(--bg-card)]/80 border-[var(--border)] backdrop-blur-xl shadow-2xl shadow-black/20">
          <CardContent className="p-6">
            <AnimatePresence mode="wait">
              {step === 1 && (
                <motion.div
                  key="step1"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.3 }}
                  className="space-y-5"
                >
                  <div>
                    <h2 className="text-lg font-bold text-shuttle-white mb-1">Set up your profile</h2>
                    <p className="text-sm text-[var(--text-secondary)]">This is how other players will see you</p>
                  </div>

                  <div className="space-y-4">
                    <div className="space-y-2">
                      <Label htmlFor="name" className="text-[var(--text-secondary)] text-sm font-medium">
                        Full Name <span className="text-[var(--ds-accent)]">*</span>
                      </Label>
                      <div className="relative">
                        <User className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
                        <Input
                          id="name"
                          value={name}
                          onChange={(e) => setName(e.target.value)}
                          placeholder="Your full name"
                          className="h-12 pl-10 bg-[var(--on-surface-soft)] border-[var(--border-hover)] text-shuttle-white placeholder:text-[var(--text-dim)] focus:border-[var(--ds-accent)]/50 focus:ring-[var(--ds-accent)]/20"
                        />
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="displayName" className="text-[var(--text-secondary)] text-sm font-medium">
                        Display Name <span className="text-[var(--text-muted)]">(optional)</span>
                      </Label>
                      <div className="relative">
                        <Sparkles className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
                        <Input
                          id="displayName"
                          value={displayName}
                          onChange={(e) => setDisplayName(e.target.value)}
                          placeholder="Nickname or gamertag"
                          className="h-12 pl-10 bg-[var(--on-surface-soft)] border-[var(--border-hover)] text-shuttle-white placeholder:text-[var(--text-dim)] focus:border-[var(--ds-accent)]/50 focus:ring-[var(--ds-accent)]/20"
                        />
                      </div>
                    </div>

                    <div className="space-y-2">
                      <Label htmlFor="phone" className="text-[var(--text-secondary)] text-sm font-medium">
                        Phone <span className="text-[var(--text-muted)]">(optional)</span>
                      </Label>
                      <div className="relative">
                        <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-[var(--text-muted)]" />
                        <Input
                          id="phone"
                          value={phone}
                          onChange={(e) => setPhone(e.target.value)}
                          placeholder="For session reminders"
                          className="h-12 pl-10 bg-[var(--on-surface-soft)] border-[var(--border-hover)] text-shuttle-white placeholder:text-[var(--text-dim)] focus:border-[var(--ds-accent)]/50 focus:ring-[var(--ds-accent)]/20"
                        />
                      </div>
                    </div>
                  </div>

                  <Button
                    onClick={() => { if (name.length >= 2) setStep(2); }}
                    disabled={name.length < 2}
                    size="lg"
                    className="w-full h-12 gradient-court text-white font-bold tracking-wide shadow-lg shadow-[var(--ds-accent)]/20 hover:shadow-[var(--ds-accent)]/30 disabled:opacity-40 disabled:shadow-none transition-all duration-300"
                  >
                    Continue
                    <ChevronRight className="w-4 h-4 ml-1" />
                  </Button>
                </motion.div>
              )}

              {step === 2 && (
                <motion.div
                  key="step2"
                  initial={{ opacity: 0, x: 20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, x: -20 }}
                  transition={{ duration: 0.3 }}
                  className="space-y-6"
                >
                  <div className="text-center">
                    <motion.div
                      initial={{ scale: 0, rotate: -180 }}
                      animate={{ scale: 1, rotate: 0 }}
                      transition={{ type: 'spring', bounce: 0.5, delay: 0.15 }}
                      className="w-16 h-16 mx-auto mb-4 rounded-full bg-[var(--ds-accent)]/15 flex items-center justify-center"
                    >
                      <Rocket className="w-8 h-8 text-[var(--ds-accent)]" />
                    </motion.div>
                    <h2 className="text-xl font-bold text-shuttle-white">
                      You&apos;re ready, {displayName || name.split(' ')[0]}!
                    </h2>
                    <p className="text-sm text-[var(--text-secondary)] mt-2">
                      Start exploring the club, check into sessions, and challenge other players.
                    </p>
                  </div>

                  {/* Starting Stats Cards */}
                  <div className="grid grid-cols-3 gap-3">
                    {statCards.map((card, i) => (
                      <motion.div
                        key={card.label}
                        initial={{ opacity: 0, y: 10 }}
                        animate={{ opacity: 1, y: 0 }}
                        transition={{ delay: 0.2 + i * 0.1 }}
                        className="card-surface p-3 text-center"
                      >
                        <card.icon
                          className="w-5 h-5 mx-auto mb-1.5"
                          style={{ color: card.color }}
                        />
                        <p className="display-md text-shuttle-white nums">
                          {card.value}
                        </p>
                        <p className="eyebrow mt-0.5" style={{ fontSize: '0.6rem' }}>
                          {card.label}
                        </p>
                      </motion.div>
                    ))}
                  </div>

                  {/* Tip */}
                  <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ delay: 0.5 }}
                    className="bg-[var(--color-gold)]/5 border border-[var(--color-gold)]/10 rounded-xl p-3 flex items-start gap-2.5"
                  >
                    <Trophy className="w-4 h-4 text-[var(--color-gold)] mt-0.5 shrink-0" />
                    <p className="text-xs text-[var(--text-secondary)]">
                      <span className="text-[var(--color-gold)] font-semibold">Pro tip:</span>{' '}
                      Challenge players near your Elo to climb the leaderboard faster!
                    </p>
                  </motion.div>

                  <div className="flex gap-3">
                    <Button
                      variant="outline"
                      onClick={() => setStep(1)}
                      className="h-12 px-5 bg-[var(--on-surface-soft)] border-[var(--border-hover)] hover:bg-[var(--on-surface-med)] text-[var(--text-secondary)]"
                    >
                      <ChevronLeft className="w-4 h-4 mr-1" />
                      Back
                    </Button>
                    <Button
                      onClick={handleComplete}
                      disabled={loading}
                      size="lg"
                      className="flex-1 h-12 gradient-gold text-[var(--bg-primary)] font-black tracking-wide shadow-lg shadow-[var(--color-gold)]/20 hover:shadow-[var(--color-gold)]/30 transition-all duration-300"
                    >
                      {loading ? (
                        <Loader2 className="w-5 h-5 animate-spin mr-2" />
                      ) : (
                        <Rocket className="w-4 h-4 mr-2" />
                      )}
                      Let&apos;s Go!
                    </Button>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}
