'use client';

import { useState, useRef, useEffect } from 'react';
import { Calendar, Download, ExternalLink } from 'lucide-react';
import { buildICSCalendar, formatICSDates } from '@badminton/shared';

interface AddToCalendarProps {
  name: string;
  date: string;
  start_time?: string | null;
  end_time?: string | null;
  location: string;
  notes?: string | null;
}

// Session times are club-local wall-clock; formatICSDates/buildICSCalendar
// convert them to UTC instants (or an all-day event when untimed) so the
// event lands on the right day in every timezone.
function generateICS({ name, date, start_time, end_time, location, notes }: AddToCalendarProps): string {
  return buildICSCalendar([{
    id: `download-${date}`,
    name,
    date,
    start_time: start_time ?? null,
    end_time: end_time ?? null,
    location,
    notes: notes ?? null,
    updated_at: new Date().toISOString(),
  }]);
}

function getGoogleCalendarUrl({ name, date, start_time, end_time, location, notes }: AddToCalendarProps): string {
  const { start, end } = formatICSDates({
    date,
    start_time: start_time ?? null,
    end_time: end_time ?? null,
  });
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: name,
    dates: `${start}/${end}`,
    location: location,
    details: notes || '',
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

export function AddToCalendarButton({ name, date, start_time, end_time, location, notes }: AddToCalendarProps) {
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    if (open) document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  function handleDownloadICS() {
    const ics = generateICS({ name, date, start_time, end_time, location, notes });
    const blob = new Blob([ics], { type: 'text/calendar;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${name.replace(/\s+/g, '_')}.ics`;
    a.click();
    URL.revokeObjectURL(url);
    setOpen(false);
  }

  return (
    <div className="relative" ref={menuRef}>
      <button
        onClick={() => setOpen(!open)}
        className="press flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--bg-card)] border border-[var(--line)] text-xs font-medium text-[var(--text-muted)] hover:text-[var(--ink)] hover:bg-[var(--bg-elevated)] transition-all duration-200"
      >
        <Calendar className="w-3.5 h-3.5" />
        Add to Calendar
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-48 bg-[var(--bg-elevated)] border border-[var(--line)] rounded-lg shadow-xl z-50 overflow-hidden">
          <a
            href={getGoogleCalendarUrl({ name, date, start_time, end_time, location, notes })}
            target="_blank"
            rel="noopener noreferrer"
            className="press flex items-center gap-2 px-3 py-2.5 min-h-[44px] text-sm text-[var(--ink)] hover:bg-[var(--bg-card)] transition-colors"
            onClick={() => setOpen(false)}
          >
            <ExternalLink className="w-4 h-4 text-[var(--text-muted)]" />
            Google Calendar
          </a>
          <button
            onClick={handleDownloadICS}
            className="press flex items-center gap-2 px-3 py-2.5 min-h-[44px] text-sm text-[var(--ink)] hover:bg-[var(--bg-card)] transition-colors w-full text-left"
          >
            <Download className="w-4 h-4 text-[var(--text-muted)]" />
            Download .ics
          </button>
        </div>
      )}
    </div>
  );
}
