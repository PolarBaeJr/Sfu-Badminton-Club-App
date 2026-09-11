import type { CSSProperties, ReactNode } from 'react';

// An announcement body, drawn as the exec wrote it.
//
// WHY THIS EXISTS. The console's Body box now carries a formatting toolbar
// (apps/admin/src/app/announcements/format-bar.tsx), and until this file existed
// every screen that showed a post rendered the result as one run of plain text:
// a bold heading arrived as `**like this**`, a hand-typed list as `- ` and the
// asterisks were the only thing a member saw. A BUTTON on markup the reader is
// then shown raw is worse than no button.
//
// HAND-ROLLED, TO REACT NODES, NO MARKDOWN DEPENDENCY, exactly the posture of
// `packages/ui/src/components/LegalMarkdown.tsx` and of the console's own
// `discord-markdown.tsx`. `dangerouslySetInnerHTML` appears nowhere in this file
// and must not: React escapes every text child, so an exec-typed
// `<script>alert(1)</script>` lands in the DOM as those characters.
//
// AND NO ANCHORS AT ALL, which is the one hard difference from the console's
// facsimile. The feed's CLUB NOTICE body sits inside a `<Link>`
// (apps/player/src/app/feed/page.tsx), so an `<a>` emitted here would be an
// anchor nested in an anchor: invalid markup the browser reflows. Because no
// `href` is ever emitted there is also no scheme allowlist in this file to get
// wrong, which is the other half of why the absence is the design.
//
// ONE LEFT-TO-RIGHT SCAN on `startsWith`/`indexOf`, and no nested-quantifier
// regexes: this app's measured ceiling is render CPU, and every published notice
// is re-parsed on every page view.
//
// The plain-text twin of this file is
// `packages/shared/src/utils/announcement-markdown.ts`, which strips the same
// set for the bell row and the lock-screen push. The two must support the same
// syntax, so a change here is a change there.

/** How deep a wrapper may nest before the parse stops recursing. */
const MAX_DEPTH = 6;

// STYLED WITH INLINE STYLES READING CSS VARS, the way LegalMarkdown and the feed
// page already do, so the renderer is independent of either app's Tailwind
// config.
//
// AND TAILWIND PREFLIGHT IS ACTIVE IN THIS APP (`@tailwind base` in
// globals.css), which resets h1..h6 to inherited size and weight, zeroes every
// margin and sets `ul { list-style: none; padding: 0 }`. So each construct has
// to state what it needs or it renders as invisible structure: a heading that
// looks like a paragraph, and a list with no bullets and no indent.
//
// Only what the construct itself needs. Colour and base font size are inherited
// so `.news-body` keeps owning the typography of the page it sits on.
//
// Margins are BOTTOM-ONLY on the text blocks and top-and-bottom on headings: a
// top margin on the first block would open a gap inside the feed card, which
// passes `margin: 0` to the wrapper and can do nothing about a child.
const BLOCK_MARGIN = '0 0 10px';

const PARA_STYLE = { margin: BLOCK_MARGIN, whiteSpace: 'pre-wrap' } as const;

const LIST_STYLE = {
  margin: BLOCK_MARGIN,
  paddingLeft: 22,
  listStyleType: 'disc',
} as const;

const QUOTE_STYLE = {
  margin: BLOCK_MARGIN,
  paddingLeft: 10,
  borderLeft: '2px solid var(--line)',
  color: 'var(--mute)',
  whiteSpace: 'pre-wrap',
} as const;

const PRE_STYLE = {
  margin: BLOCK_MARGIN,
  padding: 8,
  background: 'var(--surface-2)',
  fontFamily: 'var(--mono)',
  fontSize: '0.9em',
  whiteSpace: 'pre-wrap',
  overflowWrap: 'anywhere',
} as const;

const CODE_STYLE = {
  background: 'var(--surface-2)',
  fontFamily: 'var(--mono)',
  fontSize: '0.9em',
  padding: '1px 3px',
} as const;

/**
 * `# `, `## ` and `### ` land on h3, h4 and h5, NOT h1..h3: the post's own title
 * is already the `h2` beside this body (announcements/announcement-item.tsx), so
 * a heading typed in the composer is a subheading of it.
 */
const HEADINGS = {
  1: { tag: 'h3', style: { margin: '14px 0 6px', fontSize: 18, fontWeight: 700, color: 'var(--ink)' } },
  2: { tag: 'h4', style: { margin: '12px 0 6px', fontSize: 16, fontWeight: 700, color: 'var(--ink)' } },
  3: { tag: 'h5', style: { margin: '10px 0 4px', fontSize: 15, fontWeight: 600, color: 'var(--ink)' } },
} as const;

/**
 * The paired-delimiter constructs, IN PRECEDENCE ORDER.
 *
 * `**` sits before `*` because the scan takes the first entry that matches at
 * the cursor, so this array IS the precedence rule and reordering it is a
 * behaviour change.
 *
 * A SINGLE `_` IS DELIBERATELY NOT ITALIC, unlike the Discord facsimile in
 * apps/admin (discord-markdown.tsx), which takes `_text_` because Discord does.
 * `some_file_name.pdf` and `first_last@sfu.ca` are ordinary announcement
 * content, and a literal underscore is the safer divergence: the cost of being
 * wrong is an underscore on screen, where the other way round it is half a
 * filename in italics and a missing character.
 */
const WRAPPERS: {
  marker: string;
  render: (children: ReactNode, key: number) => ReactNode;
}[] = [
  { marker: '**', render: (children, key) => <strong key={key}>{children}</strong> },
  { marker: '__', render: (children, key) => <u key={key}>{children}</u> },
  { marker: '~~', render: (children, key) => <s key={key}>{children}</s> },
  { marker: '*', render: (children, key) => <em key={key}>{children}</em> },
];

/**
 * One run of text, to nodes.
 *
 * A WRAPPER MAY NOT SPAN A NEWLINE. The closing marker has to sit on the same
 * line as the opening one, which is a deliberate divergence from the Discord
 * preview, whose scan is not line-bounded. Two footnote lines each starting with
 * a `*` in the same paragraph run must not italicise the gap between them, and
 * one stray backtick must not swallow the rest of the post.
 */
function renderInline(text: string, depth: number): ReactNode[] {
  const out: ReactNode[] = [];
  let plain = '';
  let key = 0;
  let i = 0;

  const flush = () => {
    if (plain) {
      out.push(plain);
      plain = '';
    }
  };
  const push = (node: ReactNode) => {
    flush();
    out.push(node);
  };
  /** Formatting inside a wrapper, or its raw text once the depth cap is hit. */
  const inner = (raw: string): ReactNode => (depth < MAX_DEPTH ? renderInline(raw, depth + 1) : raw);
  /** The end of the line the cursor is on, which is as far as a closer may be. */
  const lineEnd = (from: number): number => {
    const nl = text.indexOf('\n', from);
    return nl === -1 ? text.length : nl;
  };

  while (i < text.length) {
    const ch = text[i]!;

    // INLINE CODE WINS OVER EVERYTHING AND DOES NOT RECURSE, which is Discord's
    // own rule and what protects a literal `**`: stars between backticks keep
    // their stars. Checked before the wrappers because protecting them is the
    // whole point of it.
    if (ch === '`') {
      const close = text.indexOf('`', i + 1);
      if (close > i + 1 && close < lineEnd(i)) {
        push(
          <code key={key++} style={CODE_STYLE}>
            {text.slice(i + 1, close)}
          </code>,
        );
        i = close + 1;
        continue;
      }
    }

    let wrapped = false;
    for (const w of WRAPPERS) {
      if (!text.startsWith(w.marker, i)) continue;
      const close = text.indexOf(w.marker, i + w.marker.length);
      // An absent closer (-1), an empty pair and a closer on a later line all
      // fail this, and all then render as the markers typed: somebody who wrote
      // `**` and stopped sees their asterisks rather than a style running to the
      // end of the post.
      if (close <= i + w.marker.length || close >= lineEnd(i)) continue;
      push(w.render(inner(text.slice(i + w.marker.length, close)), key++));
      i = close + w.marker.length;
      wrapped = true;
      break;
    }
    if (wrapped) continue;

    plain += ch;
    i++;
  }

  flush();
  return out;
}

/** `# `, `## `, `### `, or 0 for anything else. */
function headingLevel(line: string): 0 | 1 | 2 | 3 {
  if (line.startsWith('### ')) return 3;
  if (line.startsWith('## ')) return 2;
  if (line.startsWith('# ')) return 1;
  return 0;
}

/** The first line at or after `from` that closes a fence. */
function fenceEnd(lines: string[], from: number): number {
  for (let i = from; i < lines.length; i++) {
    if (lines[i]!.trim() === '```') return i;
  }
  return -1;
}

/**
 * The block pass: line-oriented, linear, and fences first.
 *
 * AN UNTERMINATED FENCE IS ORDINARY LINES, for the same reason the console's
 * preview takes that route: it is the only option that cannot invent structure
 * out of a body somebody typed by hand, where the alternative is three
 * backticks silently swallowing every line below them.
 */
function renderBlocks(text: string): ReactNode[] {
  const lines = text.split('\n');
  const blocks: ReactNode[] = [];

  // BLANK LINES STAY IN THE TEXT RUN and the run keeps `pre-wrap`, because a
  // single newline inside a paragraph is meaningful: the exec laid the post out
  // by hand. LegalMarkdown joins wrapped lines with a space, which is right for
  // a legal document typed in prose and wrong for this.
  let para: string[] = [];
  let bullets: string[] = [];
  let quote: string[] = [];

  const flushPara = () => {
    const joined = para.join('\n');
    para = [];
    if (!joined) return;
    blocks.push(
      <div key={blocks.length} style={PARA_STYLE}>
        {renderInline(joined, 0)}
      </div>,
    );
  };

  const flushBullets = () => {
    if (bullets.length === 0) return;
    const items = bullets;
    bullets = [];
    blocks.push(
      <ul key={blocks.length} style={LIST_STYLE}>
        {items.map((item, i) => (
          <li key={i}>{renderInline(item, 0)}</li>
        ))}
      </ul>,
    );
  };

  const flushQuote = () => {
    if (quote.length === 0) return;
    const joined = quote.join('\n');
    quote = [];
    blocks.push(
      <div key={blocks.length} style={QUOTE_STYLE}>
        {renderInline(joined, 0)}
      </div>,
    );
  };

  const flushAll = () => {
    flushPara();
    flushBullets();
    flushQuote();
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (line.trimStart().startsWith('```')) {
      const end = fenceEnd(lines, i + 1);
      if (end !== -1) {
        flushAll();
        blocks.push(
          <pre key={blocks.length} style={PRE_STYLE}>
            {lines.slice(i + 1, end).join('\n')}
          </pre>,
        );
        i = end;
        continue;
      }
    }

    const heading = headingLevel(line);
    if (heading !== 0) {
      flushAll();
      const { tag: Tag, style } = HEADINGS[heading];
      // `heading + 1` IS the marker length, counting the required space: '# ' is
      // 2, '## ' is 3, '### ' is 4. A fourth level would break that identity.
      blocks.push(
        <Tag key={blocks.length} style={style}>
          {renderInline(line.slice(heading + 1), 0)}
        </Tag>,
      );
      continue;
    }

    if (line.startsWith('- ') || line.startsWith('* ')) {
      flushPara();
      flushQuote();
      bullets.push(line.slice(2));
      continue;
    }

    if (line.startsWith('> ')) {
      flushPara();
      flushBullets();
      quote.push(line.slice(2));
      continue;
    }

    flushBullets();
    flushQuote();
    para.push(line);
  }

  flushAll();
  return blocks;
}

/**
 * An announcement body, drawn.
 *
 * NO `'use client'`, exactly like LegalMarkdown and the console's
 * discord-markdown: the feed page is a SERVER component and must be able to
 * import this, and announcement-item.tsx is a client component that can import
 * a non-client module freely. This file imports nothing but React types, which
 * is what keeps that true.
 *
 * ONE WRAPPING `<div>`, supplied here. A caller passes `className` or `style`
 * and nothing else: writing `<div className="news-body"><AnnouncementMarkdown
 * /></div>` would nest two divs and put the class's margin on the outer one
 * while `pre-wrap` sat on the blocks inside.
 *
 * A `<div>` AND NOT A `<p>`, and that is not cosmetic: a `<ul>`, an `<h3>` or a
 * `<pre>` inside a `<p>` makes the browser auto-close the paragraph, which is a
 * hydration mismatch the moment anybody uses a heading or a bullet.
 */
export function AnnouncementMarkdown({
  text,
  className,
  style,
}: {
  text: string;
  className?: string;
  style?: CSSProperties;
}) {
  return (
    <div className={className} style={style}>
      {renderBlocks(text)}
    </div>
  );
}
