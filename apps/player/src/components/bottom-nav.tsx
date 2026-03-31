'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useEffect } from 'react';
import { cn } from '@badminton/ui';
import { createClient } from '@/lib/supabase-browser';
import { Home, Trophy, Swords, Calendar, Megaphone } from 'lucide-react';

const navItems = [
  { href: '/feed', label: 'Home', icon: Home },
  { href: '/leaderboard', label: 'Ranks', icon: Trophy },
  { href: '/challenges', label: 'Challenge', icon: Swords },
  { href: '/sessions', label: 'Sessions', icon: Calendar },
  { href: '/announcements', label: 'News', icon: Megaphone },
];

export function BottomNav() {
  const pathname = usePathname();
  const [unreadAnnouncements, setUnreadAnnouncements] = useState(0);

  useEffect(() => {
    const supabase = createClient();

    async function checkUnread() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      const { data: player } = await supabase.from('players').select('id').eq('user_id', user.id).single();
      if (!player) return;

      const { count: totalAnnouncements } = await supabase
        .from('announcements')
        .select('*', { count: 'exact', head: true })
        .eq('status', 'published');

      const { count: readCount } = await supabase
        .from('announcement_reads')
        .select('*', { count: 'exact', head: true })
        .eq('player_id', player.id);

      setUnreadAnnouncements(Math.max(0, (totalAnnouncements ?? 0) - (readCount ?? 0)));
    }

    checkUnread();

    const channel = supabase
      .channel('announcements-nav')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'announcements' }, () => {
        checkUnread();
      })
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  return (
    <nav className="fixed bottom-0 left-0 right-0 bg-[#0A0E1A]/95 backdrop-blur-xl border-t border-white/[0.06] z-50 md:hidden">
      <div className="flex justify-around max-w-md mx-auto">
        {navItems.map((item) => {
          const active = pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={cn(
                'flex flex-col items-center py-2 px-3 text-[10px] min-h-[56px] min-w-[56px] justify-center relative transition-colors duration-200',
                active
                  ? 'text-[#EF4444]'
                  : 'text-[#64748B]'
              )}
            >
              <div className={cn(
                'p-1.5 rounded-xl transition-all duration-200 mb-0.5',
                active && 'bg-[#EF4444]/10'
              )}>
                <item.icon className={cn('w-5 h-5', active && 'stroke-[2.5]')} />
              </div>
              <span className="font-semibold">{item.label}</span>
              {item.href === '/announcements' && unreadAnnouncements > 0 && (
                <span className="absolute top-1.5 right-1.5 w-4 h-4 bg-[#EF4444] text-white text-[9px] rounded-full flex items-center justify-center font-bold">
                  {unreadAnnouncements > 9 ? '9+' : unreadAnnouncements}
                </span>
              )}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
