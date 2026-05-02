// Shared mock data + utilities for SFU Badminton (Ferrari design system)

const C = {
  canvas: '#181818',
  elevated: '#303030',
  hairline: '#303030',
  ink: '#ffffff',
  body: '#969696',
  muted: '#666666',
  primary: '#da291c',
  primaryActive: '#b01e0a',
  success: '#03904a',
  warning: '#f59e0b',
};

const FONT = "'Inter', -apple-system, system-ui, sans-serif";

// ── Mock player roster ────────────────────────────────────────────────
const PLAYERS = [
  { id: 'p01', name: 'Alex Chen',     email: 'achen@sfu.ca',     status: 'competitive', singles: 1842, doubles: 1720, sw: 28, sl: 9,  dw: 22, dl: 8,  joined: '2024-09-12', rank: 1 },
  { id: 'p02', name: 'Jordan Park',   email: 'jpark@sfu.ca',     status: 'competitive', singles: 1798, doubles: 1685, sw: 24, sl: 11, dw: 18, dl: 9,  joined: '2024-09-15', rank: 2 },
  { id: 'p03', name: 'Tyler Ross',    email: 'tross@sfu.ca',     status: 'competitive', singles: 1721, doubles: 1644, sw: 21, sl: 12, dw: 15, dl: 10, joined: '2024-10-04', rank: 3 },
  { id: 'p04', name: 'Wei Liu',       email: 'wliu@sfu.ca',      status: 'competitive', singles: 1688, doubles: 1602, sw: 19, sl: 13, dw: 14, dl: 11, joined: '2024-10-22', rank: 4 },
  { id: 'p05', name: 'Priya Sharma',  email: 'psharma@sfu.ca',   status: 'competitive', singles: 1654, doubles: 1701, sw: 17, sl: 14, dw: 19, dl: 9,  joined: '2024-11-03', rank: 5 },
  { id: 'p06', name: 'Marcus Reid',   email: 'mreid@sfu.ca',     status: 'competitive', singles: 1612, doubles: 1538, sw: 16, sl: 15, dw: 12, dl: 12, joined: '2024-11-18', rank: 6 },
  { id: 'p07', name: 'Jamie Lu',      email: 'jlu@sfu.ca',       status: 'recreational', singles: 1542, doubles: 1488, sw: 14, sl: 16, dw: 11, dl: 13, joined: '2025-01-09', rank: 7 },
  { id: 'p08', name: 'David Nguyen',  email: 'dng@sfu.ca',       status: 'recreational', singles: 1498, doubles: 1422, sw: 12, sl: 18, dw: 9,  dl: 14, joined: '2025-01-15', rank: 8 },
  { id: 'p09', name: 'Connor Walsh',  email: 'cwalsh@sfu.ca',    status: 'recreational', singles: 1455, doubles: 1390, sw: 10, sl: 19, dw: 8,  dl: 15, joined: '2025-02-02', rank: 9 },
  { id: 'p10', name: 'Zoe Park',      email: 'zpark@sfu.ca',     status: 'recreational', singles: 1421, doubles: 1356, sw: 9,  sl: 21, dw: 7,  dl: 16, joined: '2025-02-21', rank: 10 },
  { id: 'p11', name: 'Sarah Kim',     email: 'skim@sfu.ca',      status: 'pending',     singles: null, doubles: null, sw: 0,  sl: 0,  dw: 0,  dl: 0,  joined: '2026-04-29', rank: null },
  { id: 'p12', name: 'Marcus Tran',   email: 'mtran@sfu.ca',     status: 'pending',     singles: null, doubles: null, sw: 0,  sl: 0,  dw: 0,  dl: 0,  joined: '2026-04-29', rank: null },
  { id: 'p13', name: 'Priya Iyer',    email: 'piyer@sfu.ca',     status: 'pending',     singles: null, doubles: null, sw: 0,  sl: 0,  dw: 0,  dl: 0,  joined: '2026-04-28', rank: null },
  { id: 'p14', name: 'Liam Tanaka',   email: 'ltanaka@sfu.ca',   status: 'pending',     singles: null, doubles: null, sw: 0,  sl: 0,  dw: 0,  dl: 0,  joined: '2026-04-27', rank: null },
];

const MATCHES = [
  { id: 'm1', a: 'Alex Chen',   b: 'Jordan Park', score: '21–15, 21–18',         type: 'Singles', status: 'confirmed', when: '2m ago' },
  { id: 'm2', a: 'Tyler Ross',  b: 'Jamie Lu',    score: '21–19, 18–21, 21–17',  type: 'Singles', status: 'confirmed', when: '2h ago' },
  { id: 'm3', a: 'Wei Liu',     b: 'Marcus Reid', score: '21–17, 19–21',         type: 'Singles', status: 'disputed',  when: '4h ago' },
  { id: 'm4', a: 'Priya / Connor', b: 'Ali / Sam', score: '21–12, 21–15',        type: 'Doubles', status: 'confirmed', when: '6h ago' },
  { id: 'm5', a: 'David Ng',    b: 'Zoe Park',    score: '—',                    type: 'Singles', status: 'pending',   when: '8h ago' },
];

const SESSIONS = [
  { id: 's1', name: 'Friday Open Play',     date: 'Fri · May 1',  time: '19:00 – 22:00', court: 'AQ Court 3',  going: 14, capacity: 16, status: 'open' },
  { id: 's2', name: 'Saturday Competitive', date: 'Sat · May 2',  time: '14:00 – 17:00', court: 'AQ Court 1–2',going: 8,  capacity: 12, status: 'open' },
  { id: 's3', name: 'Wednesday Drills',     date: 'Wed · May 6',  time: '20:00 – 22:00', court: 'AQ Court 4',  going: 6,  capacity: 8,  status: 'open' },
  { id: 's4', name: 'Tournament Qualifier', date: 'Sun · May 10', time: '10:00 – 16:00', court: 'AQ Courts 1–4',going: 22, capacity: 32, status: 'featured' },
];

const ANNOUNCEMENTS = [
  { id: 'a1', title: 'Spring Tournament Registration Open', body: 'Sign up by May 7. $15 entry. Singles + Doubles brackets.', when: '5h ago', pinned: true },
  { id: 'a2', title: 'New Court Booking Policy',  body: '48-hour cancellation window now in effect for all reservations.',     when: '2d ago', pinned: false },
  { id: 'a3', title: 'Welcome New Members',        body: 'Four new players approved this week. Say hello in the Discord.',     when: '4d ago', pinned: false },
];

const ACTIVITY = [
  { id: 'l1', kind: 'match',     text: 'Match confirmed',   sub: 'Alex Chen def. Jordan Park  21–15, 21–18',         when: '2m',  badge: 'confirmed' },
  { id: 'l2', kind: 'player',    text: 'New player joined', sub: 'Sarah Kim — pending approval',                     when: '14m', badge: 'pending'   },
  { id: 'l3', kind: 'dispute',   text: 'Dispute opened',    sub: 'Score discrepancy — Wei Liu vs Marcus Reid',       when: '31m', badge: 'disputed'  },
  { id: 'l4', kind: 'session',   text: 'Session created',   sub: 'Friday Open Play · AQ Court 3 · 7–10 PM',          when: '1h',  badge: 'session'   },
  { id: 'l5', kind: 'match',     text: 'Match confirmed',   sub: 'Tyler Ross def. Jamie Lu  21–19, 18–21, 21–17',    when: '2h',  badge: 'confirmed' },
  { id: 'l6', kind: 'player',    text: 'Player approved',   sub: 'David Nguyen — now active (Recreational)',         when: '3h',  badge: 'approved'  },
  { id: 'l7', kind: 'announce',  text: 'Announcement sent', sub: 'Spring tournament registration now open',          when: '5h',  badge: 'announce'  },
];

// ── Shared atoms ─────────────────────────────────────────────────────
function Pill({ children, color, bg, border }) {
  return (
    <span style={{
      display: 'inline-flex', alignItems: 'center', gap: 4,
      padding: '3px 10px', borderRadius: 9999,
      fontSize: 10, fontWeight: 700, letterSpacing: '1px',
      textTransform: 'uppercase', fontFamily: FONT,
      color: color || '#fff',
      background: bg || 'transparent',
      border: border || '1px solid rgba(255,255,255,0.2)',
      whiteSpace: 'nowrap',
    }}>{children}</span>
  );
}

function StatusPill({ status }) {
  const map = {
    confirmed:  { c: '#03904a', bg: 'rgba(3,144,74,0.12)',   bd: 'rgba(3,144,74,0.35)' },
    approved:   { c: '#03904a', bg: 'rgba(3,144,74,0.12)',   bd: 'rgba(3,144,74,0.35)' },
    pending:    { c: '#f59e0b', bg: 'rgba(245,158,11,0.12)', bd: 'rgba(245,158,11,0.35)' },
    disputed:   { c: '#da291c', bg: 'rgba(218,41,28,0.12)',  bd: 'rgba(218,41,28,0.35)' },
    competitive:{ c: '#da291c', bg: 'rgba(218,41,28,0.12)',  bd: 'rgba(218,41,28,0.35)' },
    recreational:{ c: '#969696',bg: 'rgba(255,255,255,0.05)',bd: 'rgba(255,255,255,0.15)' },
    session:    { c: '#4c98b9', bg: 'rgba(76,152,185,0.12)', bd: 'rgba(76,152,185,0.35)' },
    match:      { c: '#03904a', bg: 'rgba(3,144,74,0.12)',   bd: 'rgba(3,144,74,0.35)' },
    announce:   { c: '#fff',    bg: 'rgba(255,255,255,0.06)',bd: 'rgba(255,255,255,0.18)' },
  };
  const s = map[status] || map.recreational;
  return <Pill color={s.c} bg={s.bg} border={`1px solid ${s.bd}`}>{status}</Pill>;
}

function Avatar({ name = '', size = 36, ring = false }) {
  const initials = name.split(' ').map(p => p[0]).slice(0, 2).join('').toUpperCase();
  const hue = name.split('').reduce((n, c) => n + c.charCodeAt(0), 0) % 360;
  return (
    <div style={{
      width: size, height: size, flexShrink: 0,
      background: `oklch(28% 0.06 ${hue})`,
      color: `oklch(82% 0.07 ${hue})`,
      display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: size * 0.36, fontWeight: 600, fontFamily: FONT,
      borderRadius: 0,
      border: ring ? '1px solid rgba(255,255,255,0.18)' : 'none',
    }}>{initials}</div>
  );
}

function CTAButton({ children, onClick, variant = 'primary', size = 'md', full }) {
  const sizes = {
    sm: { h: 36, px: 18, fs: 12, ls: '1.2px' },
    md: { h: 44, px: 24, fs: 13, ls: '1.4px' },
    lg: { h: 52, px: 32, fs: 14, ls: '1.4px' },
  }[size];
  const variants = {
    primary: { bg: '#da291c', c: '#fff', bd: 'none' },
    ghost:   { bg: 'transparent', c: '#fff', bd: '1px solid rgba(255,255,255,0.4)' },
    light:   { bg: '#fff', c: '#181818', bd: 'none' },
    danger:  { bg: 'transparent', c: '#da291c', bd: '1px solid rgba(218,41,28,0.5)' },
  }[variant];
  return (
    <button onClick={onClick} style={{
      height: sizes.h, padding: `0 ${sizes.px}px`,
      background: variants.bg, color: variants.c, border: variants.bd,
      borderRadius: 0, cursor: 'pointer',
      fontFamily: FONT, fontSize: sizes.fs, fontWeight: 700,
      letterSpacing: sizes.ls, textTransform: 'uppercase',
      width: full ? '100%' : undefined,
      display: 'inline-flex', alignItems: 'center', justifyContent: 'center', gap: 8,
      transition: 'opacity 120ms ease, background 120ms ease',
    }}
    onMouseEnter={e => { if (variant === 'primary') e.currentTarget.style.background = '#b01e0a'; }}
    onMouseLeave={e => { if (variant === 'primary') e.currentTarget.style.background = '#da291c'; }}
    >{children}</button>
  );
}

function Eyebrow({ children, color }) {
  return (
    <div style={{
      color: color || '#da291c',
      fontSize: 11, fontWeight: 600, letterSpacing: '1.1px',
      textTransform: 'uppercase', fontFamily: FONT,
    }}>{children}</div>
  );
}

function CavallinoMark({ size = 22 }) {
  return (
    <svg width={size} height={size * 28/22} viewBox="0 0 22 28" fill="none" style={{ flexShrink: 0 }}>
      <rect width="22" height="28" fill="#da291c"/>
      <rect y="0" width="22" height="4" fill="#f6e500"/>
      <rect x="1" y="1" width="20" height="26" fill="none" stroke="rgba(255,255,255,0.12)" strokeWidth="0.5"/>
      <ellipse cx="11" cy="17" rx="5" ry="6" fill="white" opacity="0.9"/>
      <ellipse cx="14" cy="11" rx="3" ry="3.5" fill="white" opacity="0.9"/>
      <line x1="8" y1="21" x2="7" y2="27" stroke="white" strokeWidth="1.5" opacity="0.9"/>
      <line x1="11" y1="22" x2="11" y2="27" stroke="white" strokeWidth="1.5" opacity="0.9"/>
      <line x1="14" y1="21" x2="15" y2="27" stroke="white" strokeWidth="1.5" opacity="0.9"/>
    </svg>
  );
}

function ShuttleMark({ size = 22, color = '#fff' }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" style={{ flexShrink: 0 }}>
      <circle cx="12" cy="18" r="3.5" fill={color}/>
      <path d="M12 14 L7 4 L9 4 L12 13 Z" fill={color} opacity="0.85"/>
      <path d="M12 14 L17 4 L15 4 L12 13 Z" fill={color} opacity="0.85"/>
      <path d="M12 14 L4 7 L6 5 L12 13 Z" fill={color} opacity="0.6"/>
      <path d="M12 14 L20 7 L18 5 L12 13 Z" fill={color} opacity="0.6"/>
    </svg>
  );
}

Object.assign(window, { C, FONT, PLAYERS, MATCHES, SESSIONS, ANNOUNCEMENTS, ACTIVITY, Pill, StatusPill, Avatar, CTAButton, Eyebrow, CavallinoMark, ShuttleMark });
