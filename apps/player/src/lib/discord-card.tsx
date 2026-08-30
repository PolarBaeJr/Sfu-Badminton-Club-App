import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CardAward, CardBackground, DiscordProfile } from './discord-profile';

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
export const H = 420;

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
  dim,
}: {
  label: string;
  value: string;
  sub?: string | null;
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
      <div style={{ fontFamily: 'Barlow', fontWeight: 400, fontSize: 17, color: MUTE }}>
        {sub ?? ' '}
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
            />
            <Stat
              label="SINGLES"
              value={`${singles.elo}${singles.provisional ? '*' : ''}`}
              sub={`#${singles.rank} · ${record(singles.wins, singles.losses)}`}
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

        <Rail awards={profile.awards} />
      </div>
    </div>
  );
}

