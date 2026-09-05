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
 *
 * THE LAYOUT IS A PANEL GRID, and the panels are the whole reason it reads as
 * a card rather than as a page. Every figure sits in a bordered box that says
 * what it is, so the eye lands on a value and finds its label without
 * tracking; the previous flat rows left three big numbers floating over an
 * empty field and a reader had to work out which was which. Panels also make
 * the empty cases honest -- a member with no rival gets a panel that says so,
 * where a flat line just went missing.
 */

export const W = 1000;

/**
 * BOTH HEIGHTS ARE THE SUM OF THE BLOCKS, not round numbers.
 *
 * satori cannot size an image to its content, so the height is asserted here
 * and the layout has to match it. Assert too little and the last row is cropped
 * with no error anywhere; assert too much -- which is what 420/580 did -- and
 * the card posts a band of empty black into the channel, because the rail is
 * pinned to the bottom and nothing fills the gap above it.
 *
 * Unranked: 32 top + 106 hero + 22 + 132 panel + 31 rail + 26 bottom = 349.
 * Ranked:   that, + 12 + 156 for the recent/rival row               = 517.
 *
 * THE CONSTANTS ARE EACH 7 MORE THAN THAT SUM, on purpose: 349 + 7 = 356 and
 * 517 + 7 = 524. A font's real line box is a little taller than its nominal
 * size, so the blocks measure fractionally over their nominal heights, and
 * being short is the failure that loses information rather than merely looking
 * untidy. Do not "correct" 356 down to 349 -- that reintroduces the crop.
 *
 * discord-card-render.test.ts draws every shape and checks that nothing was
 * cropped at the bottom edge. It CANNOT see the opposite mistake: an over-tall
 * constant leaves dead black above the rail, which no assertion here detects,
 * so run that test with CARD_RENDER_OUT set and look at the images whenever
 * these numbers change.
 */
export const H = 356;

/** With the recent-form block and the rival panel beside it. */
export const H_WITH_FORM = 524;

/**
 * The bio block: 18 marginTop + two 24px lines.
 *
 * THE BIO CANNOT CROP THE CARD, and that is worth stating because it is the
 * opposite of the failure H warns about. The block below is drawn at a fixed
 * 48px, and satori CLIPS a flex box's overflow rather than letting it push the
 * layout down -- measured: a 599-character bio leaves the bottom edge as clean
 * as a 149-character one. So the render test's crop check, which is what
 * catches every other overrun in this file, can never fail for a bio.
 *
 * WHAT GOES WRONG INSTEAD IS QUIETER. A bio that wraps to a third line has
 * that line clipped away inside the box: the card still looks right, and the
 * member's words are simply gone. BIO_MAX is the only thing standing between
 * this layout and that, which is why it is a measured number and not a guess.
 */
export const H_BIO = 66;

/**
 * How much of a bio the card draws.
 *
 * Shorter than the 240 the bot used to put in the message body, because a
 * message can be any height and this block is exactly two lines.
 *
 * 150 IS MEASURED, NOT CHOSEN. Barlow 400 at 17px across the 910px of usable
 * width fits 150 characters in two lines both for text of short words, which
 * wraps as late as possible and so packs the most in, and for long unbroken
 * names, which wrap early. 160 still fits; 150 keeps a margin for a face that
 * measures differently. Raising it is a layout change -- see the wrap test in
 * discord-card-render.test.ts, which is the assertion that holds this, because
 * the crop check cannot.
 */
export const BIO_MAX = 150;

/** The bio as it will be drawn, or null when there is nothing to draw. */
export function cardBio(bio: string | null | undefined): string | null {
  const text = (bio ?? '').trim();
  if (!text) return null;
  return text.length > BIO_MAX ? `${text.slice(0, BIO_MAX - 3).trimEnd()}...` : text;
}

/**
 * Whether the card carries the provisional footnote.
 *
 * The asterisk is drawn on the rating itself either way; this is the line that
 * says what it means. It lives on the rail, which has spare width and a fixed
 * height, so unlike the bio it costs the card nothing.
 */
export function isProvisional(profile: DiscordProfile): boolean {
  return !!(profile.doubles?.provisional || profile.singles?.provisional);
}

/**
 * How tall to draw THIS card.
 *
 * An unranked member gets neither recent form nor rival nor nights -- see
 * loadForm -- so drawing them at the full height would post 160px of nothing
 * into a channel. satori cannot size an image to its content, but the caller
 * chooses the height it renders at, so the two just have to agree; both the
 * route and Card ask this.
 */
export function cardHeight(profile: DiscordProfile): number {
  const base = profile.ranked ? H_WITH_FORM : H;
  // The bio is the one block whose PRESENCE varies independently of `ranked`,
  // so it is added rather than folded into either constant. A member with no
  // bio must not get 66px of empty card.
  return base + (cardBio(profile.bio) ? H_BIO : 0);
}

const INK = '#f2f2f2';
const MUTE = '#8d8d8d';
const FAINT = '#666666';
const RED = '#cc0000';
const LINE = 'rgba(255,255,255,0.10)';
/** Panel fill and edge. Two values used everywhere, so a panel cannot drift. */
const PANEL = 'rgba(255,255,255,0.045)';
const PANEL_LINE = 'rgba(255,255,255,0.09)';

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
function Background({ background, height }: { background: CardBackground; height: number }) {
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
            height,
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
              height,
              display: 'flex',
              background: RED,
            }}
          />
          {/* Two washes rather than one. The corner glow gives the hero band a
              light source so the avatar is not floating on flat black, and the
              long diagonal keeps the bottom half from going dead -- a card is
              mostly seen at thumbnail size, where an even field reads as an
              image that failed to load. */}
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: W,
              height,
              display: 'flex',
              background: 'radial-gradient(120% 90% at 6% 0%, rgba(204,0,0,0.30) 0%, rgba(10,10,10,0) 60%)',
            }}
          />
          <div
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: W,
              height,
              display: 'flex',
              background: 'linear-gradient(160deg, rgba(255,255,255,0.05) 0%, rgba(10,10,10,0) 45%)',
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

/**
 * A section label. One definition, because there are now six of them and they
 * have to be identical or the grid stops reading as a grid.
 */
function Label({ text }: { text: string }) {
  return (
    <div
      style={{
        display: 'flex',
        fontFamily: 'Barlow',
        fontWeight: 600,
        fontSize: 14,
        letterSpacing: 1.5,
        color: FAINT,
      }}
    >
      {text}
    </div>
  );
}

/**
 * One figure in the stat row.
 *
 * `accent` marks the club's primary discipline so the row has a first item
 * rather than four equal ones -- a red top edge and brighter ink, which is the
 * whole of the emphasis. Nothing here is a different SIZE, because four panels
 * of different heights stop being a grid.
 */
function StatPanel({
  label,
  value,
  sub,
  sub2,
  accent,
  dim,
}: {
  label: string;
  value: string;
  sub?: string | null;
  sub2?: string | null;
  accent?: boolean;
  dim?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        height: 132,
        padding: '14px 16px 0 16px',
        background: PANEL,
        border: `1px solid ${PANEL_LINE}`,
        borderTop: accent ? `2px solid ${RED}` : `1px solid ${PANEL_LINE}`,
      }}
    >
      <Label text={label} />
      <div
        style={{
          display: 'flex',
          fontFamily: 'Barlow Condensed',
          fontWeight: 700,
          fontSize: 50,
          lineHeight: 1.12,
          color: dim ? MUTE : INK,
        }}
      >
        {value}
      </div>
      <div style={{ display: 'flex', fontFamily: 'Barlow', fontWeight: 400, fontSize: 16, color: MUTE }}>
        {sub ?? ' '}
      </div>
      <div style={{ display: 'flex', fontFamily: 'Barlow', fontWeight: 400, fontSize: 16, color: FAINT }}>
        {sub2 ?? ' '}
      </div>
    </div>
  );
}

/**
 * The headline rank, top right.
 *
 * THE BETTER OF THE TWO LADDERS, named. A card needs one figure the eye reaches
 * first, and "#3 DOUBLES" is the only fact on here that is both a single number
 * and worth boasting about -- the ratings themselves are already in the grid
 * below, and repeating one of them at four times the size would just be louder,
 * not clearer. Ties go to doubles, which is what the club mostly plays.
 */
function bestLadder(profile: DiscordProfile): { rank: number; label: string } | null {
  const { doubles, singles } = profile;
  if (!doubles && !singles) return null;
  if (doubles && singles) {
    return singles.rank < doubles.rank
      ? { rank: singles.rank, label: 'SINGLES' }
      : { rank: doubles.rank, label: 'DOUBLES' };
  }
  if (doubles) return { rank: doubles.rank, label: 'DOUBLES' };
  return { rank: singles!.rank, label: 'SINGLES' };
}

function RankBadge({ rank, label }: { rank: number; label: string }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        width: 132,
        height: 106,
        background: 'rgba(204,0,0,0.13)',
        border: `1px solid rgba(204,0,0,0.45)`,
      }}
    >
      <div
        style={{
          display: 'flex',
          fontFamily: 'Barlow Condensed',
          fontWeight: 700,
          fontSize: 58,
          lineHeight: 1,
          color: INK,
        }}
      >
        {`#${rank}`}
      </div>
      <div
        style={{
          display: 'flex',
          marginTop: 6,
          fontFamily: 'Barlow',
          fontWeight: 600,
          fontSize: 13,
          letterSpacing: 1.6,
          color: '#e07070',
        }}
      >
        {label}
      </div>
    </div>
  );
}

/** A small outlined tag — the handle and the moderation status. */
function Chip({ text, tone }: { text: string; tone: 'quiet' | 'warn' }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        height: 26,
        padding: '0 10px',
        border: `1px solid ${tone === 'warn' ? 'rgba(204,0,0,0.55)' : LINE}`,
        background: tone === 'warn' ? 'rgba(204,0,0,0.12)' : 'rgba(255,255,255,0.03)',
        fontFamily: 'Barlow',
        fontWeight: 600,
        fontSize: 14,
        letterSpacing: 1.1,
        color: tone === 'warn' ? '#e58a8a' : MUTE,
      }}
    >
      {text}
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

/**
 * The opposing side, named if the card is allowed to name them.
 *
 * The budget is 22 characters now, not 30: the recent block shares its row with
 * the rival panel and lost about a third of its width. A name that does not fit
 * is abbreviated, then dropped to a count -- never clipped, because satori
 * clips by overflowing the box rather than by truncating the string.
 */
function opponentLine(opponents: string[]): string | null {
  const first = opponents[0];
  if (!first) return null;
  const full = opponents.join(', ');
  if (full.length <= 22) return `vs ${full}`;
  const short = opponents.map(shortName).join(', ');
  if (short.length <= 22) return `vs ${short}`;
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
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, height: 34 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          width: 26,
          height: 26,
          background: match.won ? RED : 'rgba(255,255,255,0.05)',
          border: `1px solid ${match.won ? RED : LINE}`,
          fontFamily: 'Barlow',
          fontWeight: 600,
          fontSize: 15,
          color: match.won ? '#ffffff' : MUTE,
        }}
      >
        {match.won ? 'W' : 'L'}
      </div>
      <div
        style={{
          display: 'flex',
          width: 14,
          fontFamily: 'Barlow',
          fontWeight: 600,
          fontSize: 15,
          color: FAINT,
        }}
      >
        {match.type === 'doubles' ? 'D' : 'S'}
      </div>
      <div
        style={{
          display: 'flex',
          width: 218,
          fontFamily: 'Barlow',
          fontWeight: 600,
          fontSize: 19,
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
          fontSize: 17,
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
function RecentPanel({ recent }: { recent: CardMatch[] }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        flex: 1,
        height: 156,
        padding: '14px 16px',
        background: PANEL,
        border: `1px solid ${PANEL_LINE}`,
      }}
    >
      <Label text="RECENT" />
      <div style={{ display: 'flex', flexDirection: 'column', marginTop: 6 }}>
        {recent.length > 0 ? (
          recent.map((m, i) => <MatchRow key={i} match={m} />)
        ) : (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              height: 34,
              fontFamily: 'Barlow',
              fontWeight: 400,
              fontSize: 18,
              color: MUTE,
            }}
          >
            No matches on the record yet
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * The rival, as a panel rather than a line.
 *
 * It used to sit in a bare label/value row under recent form, where "none yet"
 * read as something missing from the card. A panel that is present and says
 * "none yet" reads as an answer -- and it gives the recent block a right-hand
 * edge to end against, which is what stops three match rows of different
 * lengths looking ragged.
 */
function RivalPanel({ rival }: { rival: DiscordProfile['rival'] }) {
  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        width: 268,
        height: 156,
        padding: '14px 16px',
        background: PANEL,
        border: `1px solid ${PANEL_LINE}`,
      }}
    >
      <Label text="RIVAL" />
      {rival ? (
        <div style={{ display: 'flex', flexDirection: 'column', marginTop: 10 }}>
          <div
            style={{
              display: 'flex',
              fontFamily: 'Barlow Condensed',
              fontWeight: 700,
              // The panel is 268px wide with 32px of padding. Barlow Condensed
              // at 34px runs about 15 characters in what is left, so a longer
              // name steps down once and then abbreviates -- the same rule the
              // member's own name follows in the hero.
              fontSize: rival.name.length > 15 ? 26 : 34,
              lineHeight: 1.15,
              color: INK,
            }}
          >
            {rival.name.length > 20 ? shortName(rival.name) : rival.name}
          </div>
          <div
            style={{
              display: 'flex',
              marginTop: 8,
              fontFamily: 'Barlow Condensed',
              fontWeight: 700,
              fontSize: 40,
              lineHeight: 1,
              color: rival.wins >= rival.losses ? INK : MUTE,
            }}
          >
            {`${rival.wins}-${rival.losses}`}
          </div>
          <div
            style={{
              display: 'flex',
              marginTop: 4,
              fontFamily: 'Barlow',
              fontWeight: 400,
              fontSize: 15,
              color: FAINT,
            }}
          >
            {rival.wins >= rival.losses ? 'ahead in the series' : 'behind in the series'}
          </div>
        </div>
      ) : (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            marginTop: 10,
            height: 34,
            fontFamily: 'Barlow',
            fontWeight: 400,
            fontSize: 18,
            color: MUTE,
          }}
        >
          Nobody played twice yet
        </div>
      )}
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
function Rail({ awards, provisional }: { awards: CardAward[]; provisional: boolean }) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        marginTop: 'auto',
        borderTop: `1px solid ${LINE}`,
        paddingTop: 13,
      }}
    >
      {/* THE FOOTNOTE LIVES HERE, beside the club name, and it is the reason
          the rail's left half is a row rather than one label. The asterisk is
          drawn on the rating in the panel above; without this line the card
          shows an unexplained `*` on an image Discord caches publicly and
          forever, and a provisional rating with no footnote reads as settled.
          The rail is a fixed height with spare width, so this costs the card
          nothing -- which is why it is here and not in its own block. */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
        <div
          style={{
            display: 'flex',
            fontFamily: 'Barlow',
            fontWeight: 600,
            fontSize: 14,
            letterSpacing: 1.7,
            color: FAINT,
          }}
        >
          SFU BADMINTON CLUB
        </div>
        {provisional ? (
          <div
            style={{
              display: 'flex',
              fontFamily: 'Barlow',
              fontWeight: 600,
              fontSize: 14,
              letterSpacing: 1.7,
              color: MUTE,
            }}
          >
            * RATING STILL PROVISIONAL
          </div>
        ) : null}
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
              padding: '4px 10px',
              fontFamily: 'Barlow',
              fontWeight: 600,
              fontSize: 14,
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
  return parts.length > 0 ? parts.join(' · ') : null;
}

function record(w: number, l: number) {
  return `${w}W ${l}L`;
}

export function Card({ profile, avatar }: { profile: DiscordProfile; avatar: string | null }) {
  const { doubles, singles } = profile;
  const height = cardHeight(profile);
  const best = profile.ranked ? bestLadder(profile) : null;
  const bio = cardBio(profile.bio);

  return (
    <div style={{ position: 'relative', display: 'flex', width: W, height }}>
      <Background background={profile.background} height={height} />

      <div
        style={{
          position: 'relative',
          display: 'flex',
          flexDirection: 'column',
          width: W,
          height,
          padding: '32px 40px 26px 50px',
        }}
      >
        {/* HERO. The avatar, who they are, and the one figure the eye should
            reach first. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 24, height: 106 }}>
          {avatar ? (
            <img
              src={avatar}
              width={106}
              height={106}
              style={{ width: 106, height: 106, objectFit: 'cover', border: `1px solid ${LINE}` }}
            />
          ) : (
            <div
              style={{
                width: 106,
                height: 106,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                background: '#161616',
                border: `1px solid ${LINE}`,
                fontFamily: 'Barlow Condensed',
                fontWeight: 700,
                fontSize: 46,
                color: MUTE,
              }}
            >
              {initials(profile.name)}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, flex: 1 }}>
            <div
              style={{
                display: 'flex',
                fontFamily: 'Barlow Condensed',
                fontWeight: 700,
                // satori supports neither text-overflow nor a fitted size, and
                // the card is a fixed 1000px -- so a long name is stepped down
                // by hand. The rank badge took 156px off this line, so the
                // thresholds are tighter than they were: Barlow Condensed at
                // 58px runs about 22 characters in what is left.
                fontSize: profile.name.length > 30 ? 38 : profile.name.length > 22 ? 46 : 58,
                lineHeight: 1,
                letterSpacing: -0.5,
                color: INK,
              }}
            >
              {profile.name}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              {profile.handle ? <Chip text={`@${profile.handle}`} tone="quiet" /> : null}
              {profile.status ? <Chip text={profile.status.toUpperCase()} tone="warn" /> : null}
            </div>
          </div>

          {best ? <RankBadge rank={best.rank} label={best.label} /> : null}
        </div>

        {/* THE MEMBER'S OWN WORDS. Drawn on the card rather than sent as
            Discord message text, so the card is the whole post: the image is
            what gets forwarded, quoted and cached, and text beside it does not
            travel with it.

            HEIGHT IS FIXED, not measured, and that is what makes the block
            safe: cardHeight has committed the card to exactly H_BIO here, and
            a self-measuring div would let a long bio disagree with that number
            and crop the rail off the bottom. The cost of fixing it is that a
            third line is clipped in silence instead -- see H_BIO -- so cardBio
            truncates before it can come to that. */}
        {bio ? (
          <div
            style={{
              display: 'flex',
              marginTop: 18,
              height: 48,
              fontFamily: 'Barlow',
              fontWeight: 400,
              fontSize: 17,
              lineHeight: '24px',
              color: MUTE,
            }}
          >
            {bio}
          </div>
        ) : null}

        {/* THE GRID. Four panels for a ranked member, one for everyone else. */}
        {profile.ranked && doubles && singles ? (
          <div style={{ display: 'flex', gap: 12, marginTop: 22 }}>
            <StatPanel
              label="DOUBLES"
              value={`${doubles.elo}${doubles.provisional ? '*' : ''}`}
              sub={`#${doubles.rank} · ${record(doubles.wins, doubles.losses)}`}
              sub2={formLine(doubles.wins, doubles.losses, doubles.streak)}
              accent
            />
            <StatPanel
              label="SINGLES"
              value={`${singles.elo}${singles.provisional ? '*' : ''}`}
              sub={`#${singles.rank} · ${record(singles.wins, singles.losses)}`}
              sub2={formLine(singles.wins, singles.losses, singles.streak)}
            />
            <StatPanel
              label="TOURNAMENT"
              value={String(profile.tournamentPoints ?? 0)}
              sub="points"
            />
            {/* Nights used to sit in a bare meta line with the rival, where a
                single digit beside a name read as an afterthought. It is a
                season-long figure like the three beside it and belongs in the
                same row. */}
            <StatPanel
              label="NIGHTS"
              value={String(profile.nights ?? 0)}
              sub="attended"
            />
          </div>
        ) : (
          // NOT AN ERROR STATE. The member is off the public ladder — their own
          // setting, or a status the club set — and the card says so plainly
          // rather than printing zeroes that read as a real record.
          <div style={{ display: 'flex', marginTop: 22 }}>
            <StatPanel
              label="LADDER"
              value="Unranked"
              sub="not shown on the club ladder"
              dim
            />
          </div>
        )}

        {/* Only for a member the ladder lists. resolveProfile fetches none of
            this for anyone else -- their games are as private as the rating
            they chose to keep off the ladder -- so an unranked card keeps the
            shape it has always had, one block and the rail. */}
        {profile.ranked ? (
          <div style={{ display: 'flex', gap: 12, marginTop: 12 }}>
            <RecentPanel recent={profile.recent} />
            <RivalPanel rival={profile.rival} />
          </div>
        ) : null}

        <Rail awards={profile.awards} provisional={isProvisional(profile)} />
      </div>
    </div>
  );
}
