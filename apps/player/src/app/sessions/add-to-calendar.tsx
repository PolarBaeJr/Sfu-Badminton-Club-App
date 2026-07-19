'use client';

import { useState, useRef, useEffect } from 'react';
import { Calendar, Download, ExternalLink } from 'lucide-react';

interface AddToCalendarProps {
  name: string;
  date: string;
  location: string;
  notes?: string | null;
}

function formatICSDate(dateStr: string): string {
  const d = new Date(dateStr);
  return d.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

function generateICS({ name, date, location, notes }: AddToCalendarProps): string {
  const start = formatICSDate(date);
  // Default 2 hour duration
  const end = formatICSDate(new Date(new Date(date).getTime() + 2 * 60 * 60 * 1000).toISOString());

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//SFU Badminton//EN',
    'BEGIN:VEVENT',
    `DTSTART:${start}`,
    `DTEND:${end}`,
    `SUMMARY:${name}`,
    `LOCATION:${location}`,
    notes ? `DESCRIPTION:${notes.replace(/\n/g, '\\n')}` : '',
    'END:VEVENT',
    'END:VCALENDAR',
  ].filter(Boolean).join('\r\n');
}

function getGoogleCalendarUrl({ name, date, location, notes }: AddToCalendarProps): string {
  const start = formatICSDate(date);
  const end = formatICSDate(new Date(new Date(date).getTime() + 2 * 60 * 60 * 1000).toISOString());
  const params = new URLSearchParams({
    action: 'TEMPLATE',
    text: name,
    dates: `${start}/${end}`,
    location: location,
    details: notes || '',
  });
  return `https://calendar.google.com/calendar/render?${params.toString()}`;
}

export function AddToCalendarButton({ name, date, location, notes }: AddToCalendarProps) {
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
    const ics = generateICS({ name, date, location, notes });
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
            href={getGoogleCalendarUrl({ name, date, location, notes })}
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
