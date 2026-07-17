import type { UserRole } from '../types/database';

export function formatDate(dateString: string): string {
  return new Date(dateString).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function formatDateTime(dateString: string): string {
  return new Date(dateString).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function formatRelativeTime(dateString: string): string {
  const now = Date.now();
  const then = new Date(dateString).getTime();
  const diff = now - then;
  const minutes = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);

  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes}m ago`;
  if (hours < 24) return `${hours}h ago`;
  if (days < 7) return `${days}d ago`;
  return formatDate(dateString);
}

export function isAdmin(role: UserRole): boolean {
  return role === 'admin';
}

export function getWinRate(wins: number, losses: number): string {
  const total = wins + losses;
  if (total === 0) return '0%';
  return `${Math.round((wins / total) * 100)}%`;
}

// null (not 0) when no games played, so sorts can push unplayed records to
// the bottom instead of treating them as genuine 0% win rates.
export function getWinRateNumeric(wins: number, losses: number): number | null {
  const total = wins + losses;
  if (total === 0) return null;
  return wins / total;
}

export function getOverallRecord(r: {
  singles_wins: number;
  singles_losses: number;
  doubles_wins: number;
  doubles_losses: number;
}): { wins: number; losses: number; played: number; winRate: string; winRateNumeric: number | null } {
  const wins = r.singles_wins + r.doubles_wins;
  const losses = r.singles_losses + r.doubles_losses;
  return {
    wins,
    losses,
    played: wins + losses,
    winRate: getWinRate(wins, losses),
    winRateNumeric: getWinRateNumeric(wins, losses),
  };
}

export function getPointDifferential(scored: number, allowed: number): string {
  const diff = scored - allowed;
  return diff >= 0 ? `+${diff}` : `${diff}`;
}

export function getStreakDisplay(streak: number): string {
  if (streak > 0) return `W${streak}`;
  if (streak < 0) return `L${Math.abs(streak)}`;
  return '-';
}

export function cn(...classes: (string | boolean | undefined | null)[]): string {
  return classes.filter(Boolean).join(' ');
}

// Supabase embeds a joined relation as either an object or a one-element
// array depending on how it infers the relationship cardinality — normalize
// to object-or-null.
export function pickOne<T>(value: T | T[] | null | undefined): T | null {
  if (value == null) return null;
  return Array.isArray(value) ? (value[0] ?? null) : value;
}

export type SeasonTier = 'Bronze' | 'Silver' | 'Gold' | 'Platinum' | 'Diamond' | 'Elite';

const TIER_THRESHOLDS: { tier: SeasonTier; min: number; color: string; bg: string }[] = [
  { tier: 'Elite', min: 1900, color: '#EF4444', bg: '#EF4444' },
  { tier: 'Diamond', min: 1700, color: '#60A5FA', bg: '#60A5FA' },
  { tier: 'Platinum', min: 1500, color: '#22D3EE', bg: '#22D3EE' },
  { tier: 'Gold', min: 1300, color: '#FFD700', bg: '#FFD700' },
  { tier: 'Silver', min: 1100, color: '#C0C0C0', bg: '#C0C0C0' },
  { tier: 'Bronze', min: 0, color: '#CD7F32', bg: '#CD7F32' },
];

export function getSeasonTier(elo: number): { tier: SeasonTier; color: string; bg: string } {
  const match = TIER_THRESHOLDS.find((t) => elo >= t.min) ?? TIER_THRESHOLDS[TIER_THRESHOLDS.length - 1]!;
  return { tier: match.tier, color: match.color, bg: match.bg };
}
