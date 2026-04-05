'use client';

import { useState, useEffect } from 'react';
import { createClient } from '@/lib/supabase-browser';
import { Button, Card, Input, Textarea, Switch } from '@badminton/ui';
import { updateProfile } from '@/lib/actions';
import { useToast } from '@/components/toast-provider';
import { useRouter } from 'next/navigation';
import { isPushSupported, isPushEnabled, subscribeToPush, unsubscribeFromPush } from '@/lib/push-client';
import { AvatarUpload } from '@/components/AvatarUpload';
import { motion, AnimatePresence } from 'framer-motion';
import {
  User,
  Camera,
  Moon,
  Sun,
  Monitor,
  Bell,
  BellOff,
  Shield,
  LogOut,
  Info,
  Check,
  Save,
  Palette,
} from 'lucide-react';

type Theme = 'light' | 'dark' | 'system';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const sectionVariants: any = {
  hidden: { opacity: 0, y: 20 },
  visible: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { delay: i * 0.08, duration: 0.4, ease: 'easeOut' },
  }),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const saveConfirmVariants: any = {
  hidden: { opacity: 0, scale: 0.8 },
  visible: { opacity: 1, scale: 1, transition: { type: 'spring', stiffness: 300, damping: 20 } },
  exit: { opacity: 0, scale: 0.8, transition: { duration: 0.2 } },
};

function SectionHeader({ icon: Icon, title }: { icon: React.ElementType; title: string }) {
  return (
    <div className="flex items-center gap-2.5 mb-4">
      <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-[#EF4444]/10">
        <Icon className="w-4 h-4 text-[#EF4444]" />
      </div>
      <h2 className="text-lg font-semibold text-[var(--text-primary)]">{title}</h2>
    </div>
  );
}

function Divider() {
  return <div className="border-t border-white/[0.06] my-4" />;
}

const themeOptions: { value: Theme; icon: React.ElementType; label: string }[] = [
  { value: 'light', icon: Sun, label: 'Light' },
  { value: 'dark', icon: Moon, label: 'Dark' },
  { value: 'system', icon: Monitor, label: 'System' },
];

export default function SettingsPage() {
  const [name, setName] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [phone, setPhone] = useState('');
  const [bio, setBio] = useState('');
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [theme, setThemeState] = useState<Theme>('dark');
  const [showOnLeaderboard, setShowOnLeaderboard] = useState(true);
  const [showActivity, setShowActivity] = useState(true);
  const [pushEnabled, setPushEnabled] = useState(false);
  const [pushSupported, setPushSupported] = useState(false);
  const [pushLoading, setPushLoading] = useState(false);
  const [playerId, setPlayerId] = useState('');
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const { toast } = useToast();
  const router = useRouter();

  useEffect(() => {
    async function load() {
      const supabase = createClient();
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const { data } = await supabase
        .from('players')
        .select('*')
        .eq('user_id', user.id)
        .single();

      if (data) {
        setPlayerId(data.id);
        setAvatarUrl(data.avatar_url);
        setName(data.full_name);
        setDisplayName(data.display_name || '');
        setPhone(data.phone || '');
        setBio(data.bio || '');
        setLoaded(true);
      }
    }
    load();
    const saved = localStorage.getItem('theme') as Theme || 'dark';
    setThemeState(saved);

    // Check push
    setPushSupported(isPushSupported());
    isPushEnabled().then(setPushEnabled);
  }, []);

  function handleThemeChange(newTheme: Theme) {
    setThemeState(newTheme);
    localStorage.setItem('theme', newTheme);
    const resolved = newTheme === 'system'
      ? window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
      : newTheme;
    document.documentElement.setAttribute('data-theme', resolved);
  }

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    setLoading(true);
    try {
      await updateProfile({ full_name: name, phone: phone || undefined, bio: bio || undefined });
      setSaved(true);
      toast('Profile updated', 'success');
      setTimeout(() => setSaved(false), 2000);
    } catch (err) {
      toast(err instanceof Error ? err.message : 'Failed', 'error');
    }
    setLoading(false);
  }

  async function handlePushToggle(enabled: boolean) {
    setPushLoading(true);
    try {
      if (enabled) {
        const ok = await subscribeToPush(playerId);
        if (ok) {
          setPushEnabled(true);
          toast('Push notifications enabled', 'success');
        } else {
          toast('Could not enable push notifications', 'error');
        }
      } else {
        await unsubscribeFromPush(playerId);
        setPushEnabled(false);
        toast('Push notifications disabled', 'info');
      }
    } catch {
      toast('Failed to update push settings', 'error');
    }
    setPushLoading(false);
  }

  async function handleSignOut() {
    const supabase = createClient();
    await supabase.auth.signOut();
    router.push('/login');
  }

  if (!loaded) return (
    <div className="flex justify-center py-12">
      <div className="animate-spin h-8 w-8 border-2 border-[var(--color-accent)] border-t-transparent rounded-full" />
    </div>
  );

  return (
    <div className="max-w-lg mx-auto space-y-5 pb-8">
      {/* Page Title */}
      <motion.div
        initial={{ opacity: 0, y: -10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
      >
        <h1 className="text-2xl font-bold text-[var(--text-primary)]">Settings</h1>
        <p className="text-sm text-[var(--text-muted)] mt-1">Manage your profile and preferences</p>
      </motion.div>

      {/* Profile Section */}
      <motion.div
        custom={0}
        variants={sectionVariants}
        initial="hidden"
        animate="visible"
      >
        <Card className="!bg-[#161B2E] !border-white/[0.06]">
          <SectionHeader icon={User} title="Profile" />
          {playerId && (
            <div className="mb-6 flex justify-center">
              <AvatarUpload
                playerId={playerId}
                playerName={name}
                currentUrl={avatarUrl}
                onUploaded={setAvatarUrl}
              />
            </div>
          )}
          <Divider />
          <form onSubmit={handleSave} className="space-y-4">
            <Input
              label="Full Name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
            />
            <Input
              label="Display Name / Nickname"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              placeholder="Optional"
            />
            <Input
              label="Phone"
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="Optional"
            />
            <Textarea
              label="Bio"
              value={bio}
              onChange={(e) => setBio(e.target.value)}
              placeholder="A few words about yourself"
            />
            <div className="relative">
              <Button type="submit" loading={loading} className="w-full">
                <span className="flex items-center justify-center gap-2">
                  <AnimatePresence mode="wait">
                    {saved ? (
                      <motion.span
                        key="check"
                        variants={saveConfirmVariants}
                        initial="hidden"
                        animate="visible"
                        exit="exit"
                        className="flex items-center gap-2"
                      >
                        <Check className="w-4 h-4" />
                        Saved!
                      </motion.span>
                    ) : (
                      <motion.span
                        key="save"
                        variants={saveConfirmVariants}
                        initial="hidden"
                        animate="visible"
                        exit="exit"
                        className="flex items-center gap-2"
                      >
                        <Save className="w-4 h-4" />
                        Save Profile
                      </motion.span>
                    )}
                  </AnimatePresence>
                </span>
              </Button>
            </div>
          </form>
        </Card>
      </motion.div>

      {/* Appearance Section */}
      <motion.div
        custom={1}
        variants={sectionVariants}
        initial="hidden"
        animate="visible"
      >
        <Card className="!bg-[#161B2E] !border-white/[0.06]">
          <SectionHeader icon={Palette} title="Appearance" />
          <p className="text-sm text-[var(--text-muted)] mb-4">Choose your preferred theme</p>
          <div className="grid grid-cols-3 gap-3">
            {themeOptions.map(({ value, icon: Icon, label }) => (
              <motion.button
                key={value}
                whileTap={{ scale: 0.96 }}
                onClick={() => handleThemeChange(value)}
                className={`relative flex flex-col items-center gap-2 px-4 py-4 rounded-xl border text-sm font-medium transition-all duration-200 ${
                  theme === value
                    ? 'border-[#EF4444] bg-[#EF4444]/10 text-[#EF4444] shadow-[0_0_12px_rgba(239,68,68,0.15)]'
                    : 'border-white/[0.06] text-[var(--text-muted)] hover:border-white/[0.12] hover:bg-white/[0.03]'
                }`}
              >
                <Icon className="w-5 h-5" />
                <span>{label}</span>
                {theme === value && (
                  <motion.div
                    layoutId="theme-indicator"
                    className="absolute -top-px -right-px w-5 h-5 bg-[#EF4444] rounded-bl-lg rounded-tr-[11px] flex items-center justify-center"
                    transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                  >
                    <Check className="w-3 h-3 text-white" />
                  </motion.div>
                )}
              </motion.button>
            ))}
          </div>
        </Card>
      </motion.div>

      {/* Notifications Section */}
      <motion.div
        custom={2}
        variants={sectionVariants}
        initial="hidden"
        animate="visible"
      >
        <Card className="!bg-[#161B2E] !border-white/[0.06]">
          <SectionHeader icon={Bell} title="Notifications" />
          <div className="space-y-2">
            {pushSupported ? (
              <div className="flex items-start gap-3">
                <div className="mt-0.5">
                  {pushEnabled ? (
                    <Bell className="w-4 h-4 text-[#EF4444]" />
                  ) : (
                    <BellOff className="w-4 h-4 text-[var(--text-muted)]" />
                  )}
                </div>
                <div className="flex-1">
                  <Switch
                    checked={pushEnabled}
                    onChange={handlePushToggle}
                    label="Push Notifications"
                    description="Get notified about challenges, results, and announcements"
                    disabled={pushLoading}
                  />
                </div>
              </div>
            ) : (
              <div className="flex items-center gap-3 p-3 rounded-lg bg-white/[0.03] border border-white/[0.06]">
                <BellOff className="w-4 h-4 text-[var(--text-muted)] flex-shrink-0" />
                <p className="text-sm text-[var(--text-muted)]">Push notifications not supported in this browser.</p>
              </div>
            )}
          </div>
        </Card>
      </motion.div>

      {/* Privacy Section */}
      <motion.div
        custom={3}
        variants={sectionVariants}
        initial="hidden"
        animate="visible"
      >
        <Card className="!bg-[#161B2E] !border-white/[0.06]">
          <SectionHeader icon={Shield} title="Privacy" />
          <div className="space-y-1">
            <Switch
              checked={showOnLeaderboard}
              onChange={setShowOnLeaderboard}
              label="Show on leaderboard"
              description="Your rank will be visible to others"
            />
            <Divider />
            <Switch
              checked={showActivity}
              onChange={setShowActivity}
              label="Show activity status"
              description="Others can see when you were last active"
            />
          </div>
        </Card>
      </motion.div>

      {/* About Section */}
      <motion.div
        custom={4}
        variants={sectionVariants}
        initial="hidden"
        animate="visible"
      >
        <Card className="!bg-[#161B2E] !border-white/[0.06]">
          <SectionHeader icon={Info} title="About" />
          <div className="space-y-3 text-sm">
            <div className="flex justify-between items-center p-3 rounded-lg bg-white/[0.03]">
              <span className="text-[var(--text-muted)]">Version</span>
              <span className="text-[var(--text-primary)] font-mono bg-white/[0.06] px-2.5 py-1 rounded-md text-xs">
                0.0.1
              </span>
            </div>
          </div>
        </Card>
      </motion.div>

      {/* Sign Out */}
      <motion.div
        custom={5}
        variants={sectionVariants}
        initial="hidden"
        animate="visible"
      >
        <motion.div whileTap={{ scale: 0.98 }}>
          <Button variant="danger" onClick={handleSignOut} className="w-full">
            <span className="flex items-center justify-center gap-2">
              <LogOut className="w-4 h-4" />
              Sign Out
            </span>
          </Button>
        </motion.div>
      </motion.div>
    </div>
  );
}
