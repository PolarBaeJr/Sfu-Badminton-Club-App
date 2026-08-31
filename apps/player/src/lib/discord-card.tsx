import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CardAward, CardBackground, CardMatch, DiscordProfile } from './discord-profile';
import { formatStreak } from './ladder';

/**
 * The profile card's pixels.
 *
 * SEPARATE FROM THE ROUTE so the card can be rendered from a fixture without a
 * database and without a signed token -- see __tests__/discord-card-render.
 * The route decides who may see a card; this decides what one looks like.
 *
 * THE FONTS ARE .ttf, NOT THE .woff2 THE BROWSER GETS. satori, which next/og
 * renders through, cannot read WOFF2 at all. The three files are the same
 * Barlow the app uses, with the latin, latin-ext and vietnamese subsets merged
 * into one face each so an accented or Vietnamese name renders as itself
 * instead of as tofu. They reach the container through
 * outputFileTracingIncludes in next.config.js -- nothing imports them, so
 * nothing traces them, and without that entry the route builds clean and 500s
 * on its first real request.
 */

export const W = 1000;
// 420 until the card carried only the three ladder figures. The extra 160 is
// the recent-form block and the rival/nights line beneath it; Discord scales
// the image to the channel's width either way, so height costs nothing but
// pixels.
export const H = 580;

const INK = '#f0f0f0';
const MUTE = '#8a8a8a';
const RED = '#cc0000';
const LINE = 'rgba(255,255,255,0.10)';

// Read once per process rather than per request. The files are ~68KB each and
// never change while the container lives.
const fontFile = (f: string) => readFileSync(join(process.cwd(), 'src/fonts', f));
export const FONTS = [
  { name: 'Barlow Condensed', data: fontFile('BarlowCondensed-Bold.ttf'), weight: 700 as const, style: 'normal' as const },
  { name: 'Barlow', data: fontFile('Barlow-Regular.ttf'), weight: 400 as const, style: 'normal' as const },
  { name: 'Barlow', data: fontFile('Barlow-SemiBold.ttf'), weight: 600 as const, style: 'normal' as const },
];

/**
 * The background, as its own layer.
 *
 * ONE ABSOLUTELY-POSITIONED CHILD behind everything else, rather than a
 * `background` on the root. That is the whole point of the split: a member-
 * chosen image, a seasonal treatment or an award-earned pattern all become a
 * new case here, and nothing above this function moves. resolveBackground in
 * lib/discord-profile.ts decides WHICH; this decides what it looks like.
 */
function Background({ background }: { background: CardBackground }) {
  switch (background.kind) {
    case 'default':
    default:
      return (
        <div
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: W,
            height: H,
            display: 'flex',
            background: '#0a0a0a',
          }}
        >
          {/* The club's red, bled in from the left edge the way the app's
              brand mark sits against the surface. Kept low so a future photo
              background can replace this block without the type needing new
              contrast rules. */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: 10,
              height: H,
              display: 'flex',
              background: RED,
            }}
          />
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: W,
              height: H,
              display: 'flex',
              background: 'linear-gradient(120deg, rgba(204,0,0,0.16) 0%, rgba(10,10,10,0) 55%)',
            }}
          />
        </div>
      );
  }
}

/** Two initials, when there is no avatar or it could not be fetched in time. */
function initials(name: string) {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase() ?? '')
    .join('');
}

/**
 * The avatar, inlined.
 *
 * Fetched HERE rather than handed to satori as a remote src, because satori's
 * own fetch has no timeout: a slow storage bucket would hold the render past
 * Discord's patience and the card would fail as a whole. This one gives up
 * after 1.5s and the caller falls back to initials — a card with a monogram is
 * a card; a card that never arrives is a broken embed.
 */
export async function avatarDataUri(url: string | null): Promise<string | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return null;
    const type = res.headers.get('content-type') ?? '';
    if (!type.startsWith('image/')) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    // A profile photo an order of magnitude bigger than this is not a profile
    // photo; refusing it keeps one bad row from stalling every card render.
    if (buf.byteLength > 3_000_000) return null;
    return `data:${type};base64,${buf.toString('base64')}`;
  } catch {
    return null;
  }
}

function Stat({
  label,
  value,
  sub,
  sub2,
  dim,
}: {
  label: string;
  value: string;
  sub?: string | null;
  /** Second muted line -- win rate and streak, which are per discipline. */
  sub2?: string | null;
  dim?: boolean;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 168 }}>
      <div
        style={{
          fontFamily: 'Barlow',
          fontWeight: 600,
          fontSize: 15,
          letterSpacing: 1.4,
          color: MUTE,
        }}
      >
        {label}
      </div>
      <div
        style={{
          fontFamily: 'Barlow Condensed',
          fontWeight: 700,
          fontSize: 54,
          lineHeight: 1,
          color: dim ? MUTE : INK,
        }}
      >
        {value}
      </div>
      <div style={{ display: 'flex', fontFamily: 'Barlow', fontWeight: 400, fontSize: 17, color: MUTE }}>
        {sub ?? ' '}
      </div>
      <div style={{ display: 'flex', fontFamily: 'Barlow', fontWeight: 400, fontSize: 17, color: MUTE }}>
        {sub2 ?? ' '}
      </div>
    </div>
  );
}

/**
 * The bottom rail — and the reserved home for awards.
 *
 * IT IS NOT AN EMPTY ROW WAITING TO BE FILLED. The rail exists in its own right
 * as the card's footer, carrying the club line every card needs; awards fill it
 * from the right when there are any. So the empty case — which is the only case
 * that exists today — is not a gap, and the day awards ship the layout does not
 * change at all.
 */
function Rail({ awards }: { awards: CardAward[] }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        borderTop: `1px solid ${LINE}`,
        paddingTop: 14,
        marginTop: 4,
      }}
    >
      <div
        style={{
          display: 'flex',
          fontFamily: 'Barlow',
          fontWeight: 600,
          fontSize: 15,
          letterSpacing: 1.6,
          color: MUTE,
        }}
      >
        SFU BADMINTON CLUB
      </div>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        {awards.slice(0, 4).map((a, i) => (
          <div
            key={i}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              border: `1px solid ${LINE}`,
              padding: '5px 10px',
              fontFamily: 'Barlow',
              fontWeight: 600,
              fontSize: 15,
              color: INK,
            }}
          >
            <div style={{ display: 'flex' }}>{a.label}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * A name cut down to fit, e.g. "Christopher Wong" -> "Christopher W.".
 *
 * satori supports neither text-overflow nor a measured width, so anything that
 * has to fit is shortened by rule rather than by the layout. A doubles row can
 * carry two names and the card is a fixed 1000px, so the pair is abbreviated
 * together or not at all -- one full name beside one initial reads as a
 * mistake.
 */
function shortName(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const last = parts[parts.length - 1];
  if (parts.length < 2 || !last) return name;
  return `${parts[0]} ${last[0]}.`;
}

/** The opposing side, named if the card is allowed to name them. */
function opponentLine(opponents: string[]): string | null {
  const first = opponents[0];
  if (!first) return null;
  const full = opponents.join(', ');
  if (full.length <= 30) return `vs ${full}`;
  const short = opponents.map(shortName).join(', ');
  if (short.length <= 30) return `vs ${short}`;
  return `vs ${shortName(first)} +${opponents.length - 1}`;
}

/**
 * One recent match.
 *
 * W AND L AS LETTERS, not a tick and a cross. Barlow ships here as latin,
 * latin-ext and vietnamese only, and satori draws a glyph outside those subsets
 * as a tofu box with no warning anywhere -- see CardAward. Every mark on this
 * row is a letter, a digit, a hyphen or the middot the card already uses.
 *
 * The partner in a doubles match is deliberately not named: two more names
 * would double the row's width budget on a card that cannot measure text, and
 * the D marker already says there was one.
 */
function MatchRow({ match }: { match: CardMatch }) {
  const versus = opponentLine(match.opponents);
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 14, height: 32 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 26,
          height: 26,
          background: match.won ? RED : '#1e1e1e',
          border: `1px solid ${LINE}`,
          fontFamily: 'Barlow',
          fontWeight: 600,
          fontSize: 16,
          color: match.won ? '#ffffff' : MUTE,
        }}
      >
        {match.won ? 'W' : 'L'}
      </div>
      <div
        style={{
          display: 'flex',
          width: 18,
          fontFamily: 'Barlow',
          fontWeight: 600,
          fontSize: 16,
          color: MUTE,
        }}
      >
        {match.type === 'doubles' ? 'D' : 'S'}
      </div>
      <div
        style={{
          display: 'flex',
          width: 260,
          fontFamily: 'Barlow',
          fontWeight: 600,
          fontSize: 20,
          color: INK,
        }}
      >
        {match.score ?? 'no score recorded'}
      </div>
      <div
        style={{
          display: 'flex',
          fontFamily: 'Barlow',
          fontWeight: 400,
          fontSize: 19,
          color: MUTE,
        }}
      >
        {versus ?? ''}
      </div>
    </div>
  );
}

/**
 * Recent form, and the empty case is a finished thing rather than a gap.
 *
 * A member with no confirmed matches is a normal member -- new, or one who has
 * only ever played casually without a result being entered -- and the block
 * says so in the same voice the Unranked block uses.
 */
function RecentForm({ recent }: { recent: CardMatch[] }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <div
        style={{
          display: 'flex',
          fontFamily: 'Barlow',
          fontWeight: 600,
          fontSize: 15,
          letterSpacing: 1.4,
          color: MUTE,
        }}
      >
        RECENT
      </div>
      {recent.length > 0 ? (
        recent.map((m, i) => <MatchRow key={i} match={m} />)
      ) : (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            height: 32,
            fontFamily: 'Barlow',
            fontWeight: 400,
            fontSize: 19,
            color: MUTE,
          }}
        >
          No matches on the record yet
        </div>
      )}
    </div>
  );
}

/** A small label/value pair for the line under recent form. */
function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
      <div
        style={{
          display: 'flex',
          fontFamily: 'Barlow',
          fontWeight: 600,
          fontSize: 15,
          letterSpacing: 1.4,
          color: MUTE,
        }}
      >
        {label}
      </div>
      <div
        style={{
          display: 'flex',
          fontFamily: 'Barlow',
          fontWeight: 600,
          fontSize: 20,
          color: INK,
        }}
      >
        {value}
      </div>
    </div>
  );
}

/**
 * Win rate as a whole percent, or null when there is nothing to divide.
 *
 * A member with no completed matches has no win rate, and "0%" is a different
 * and much worse claim than nothing at all.
 */
function winRate(w: number, l: number): string | null {
  const played = w + l;
  if (played === 0) return null;
  return `${Math.round((w / played) * 100)}%`;
}

/** Win rate and streak, the two figures already in the payload and unused. */
function formLine(w: number, l: number, streak: number): string | null {
  const parts = [winRate(w, l), formatStreak(streak)?.label].filter(Boolean);
  return parts.length > 0 ? parts.join(' \u00b7 ') : null;
}

function record(w: number, l: number) {
  return `${w}W ${l}L`;
}

export function Card({ profile, avatar }: { profile: DiscordProfile; avatar: string | null }) {
  const { doubles, singles } = profile;

  return (
    <div style={{ position: 'relative', display: 'flex', width: W, height: H }}>
      <Background background={profile.background} />

      <div
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          width: W,
          height: H,
          padding: '38px 44px 30px 52px',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 26 }}>
          {avatar ? (
            <img
              src={avatar}
              width={124}
              height={124}
              style={{ width: 124, height: 124, objectFit: 'cover', border: `1px solid ${LINE}` }}
            />
          ) : (
            <div
              style={{
                width: 124,
                height: 124,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: '#161616',
                border: `1px solid ${LINE}`,
                fontFamily: 'Barlow Condensed',
                fontWeight: 700,
                fontSize: 52,
                color: MUTE,
              }}
            >
              {initials(profile.name)}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
            <div
              style={{
                fontFamily: 'Barlow Condensed',
                fontWeight: 700,
                // satori supports neither text-overflow nor a fitted size, and
                // the card is a fixed 1000px -- so a long name is stepped down
                // by hand. Barlow Condensed at 62px runs about 26 characters
                // in the space beside the avatar.
                fontSize: profile.name.length > 34 ? 40 : profile.name.length > 26 ? 50 : 62,
                lineHeight: 1,
                letterSpacing: -0.5,
                color: INK,
              }}
            >
              {profile.name}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              {profile.handle ? (
                <div
                  style={{
                    display: 'flex',
                    fontFamily: 'Barlow',
                    fontWeight: 400,
                    fontSize: 21,
                    color: MUTE,
                  }}
                >
                  @{profile.handle}
                </div>
              ) : null}
              {profile.status ? (
                <div
                  style={{
                    display: 'flex',
                    border: `1px solid ${LINE}`,
                    padding: '3px 9px',
                    fontFamily: 'Barlow',
                    fontWeight: 600,
                    fontSize: 14,
                    letterSpacing: 1.2,
                    color: MUTE,
                  }}
                >
                  {profile.status.toUpperCase()}
                </div>
              ) : null}
            </div>
          </div>
        </div>

        {profile.ranked && doubles && singles ? (
          <div style={{ display: 'flex', gap: 34 }}>
            <Stat
              label="DOUBLES"
              value={`${doubles.elo}${doubles.provisional ? '*' : ''}`}
              sub={`#${doubles.rank} · ${record(doubles.wins, doubles.losses)}`}
              sub2={formLine(doubles.wins, doubles.losses, doubles.streak)}
            />
            <Stat
              label="SINGLES"
              value={`${singles.elo}${singles.provisional ? '*' : ''}`}
              sub={`#${singles.rank} · ${record(singles.wins, singles.losses)}`}
              sub2={formLine(singles.wins, singles.losses, singles.streak)}
            />
            <Stat
              label="TOURNAMENT"
              value={String(profile.tournamentPoints ?? 0)}
              sub="points"
            />
          </div>
        ) : (
          // NOT AN ERROR STATE. The member is off the public ladder — their own
          // setting, or a status the club set — and the card says so plainly
          // rather than printing zeroes that read as a real record.
          <div style={{ display: 'flex' }}>
            <Stat label="LADDER" value="Unranked" sub="not shown on the club ladder" dim />
          </div>
        )}

        {/* Only for a member the ladder lists. resolveProfile fetches none of
            this for anyone else -- their games are as private as the rating
            they chose to keep off the ladder -- so an unranked card keeps the
            shape it has always had, one block and the rail. */}
        {profile.ranked ? <RecentForm recent={profile.recent} /> : null}

        {profile.ranked ? (
          <div style={{ display: 'flex', gap: 40, alignItems: 'baseline' }}>
            <Meta
              label="RIVAL"
              value={
                profile.rival
                  ? `${profile.rival.name} ${profile.rival.wins}-${profile.rival.losses}`
                  : 'none yet'
              }
            />
            <Meta label="NIGHTS" value={String(profile.nights ?? 0)} />
          </div>
        ) : null}

        <Rail awards={profile.awards} />
      </div>
    </div>
  );
}

