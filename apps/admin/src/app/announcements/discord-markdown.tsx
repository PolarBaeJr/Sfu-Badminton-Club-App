import type { ReactNode } from 'react';
import type { DiscordRoleOption } from './announcement-shape';

// Drawing an embed description the way Discord draws it.
//
// WHY THIS EXISTS. The preview's entire claim is that it shows what the channel
// will show, and it used to render the description as one run of plain text: a
// role mention appeared as `<@&1541707430910627880>`, a link as grey characters,
// and every `**`, `##` and `- ` as itself. An exec checking their post was
// reading something that will never exist anywhere. The toolbar over the box
// makes that worse rather than better, because it puts a BUTTON on markup the
// picture beneath it then refuses to draw.
//
// HAND-ROLLED, TO REACT NODES, NO MARKDOWN DEPENDENCY, exactly the posture of
// `packages/ui/src/components/LegalMarkdown.tsx`. `dangerouslySetInnerHTML`
// appears nowhere in this file and must not: React escapes every text child, so
// an exec-typed `<script>alert(1)</script>` lands in the DOM as those
// characters. THE ONE HOLE REACT DOES NOT CLOSE IS AN `href`, whose handling of
// `javascript:` is version-dependent, so the defence there is the scheme
// allowlist below and not React.
//
// ONE LEFT-TO-RIGHT SCAN on `startsWith`/`indexOf`, and no nested-quantifier
// regexes. This runs on every keystroke of a body that may be 4096 characters,
// in an app whose measured ceiling is render CPU, and a backtracking regex over
// that is how a composer starts losing keystrokes as it is typed.

/**
 * Discord's own dark surface, hard-coded rather than themed.
 *
 * This is the one panel in the console that must NOT follow the club's palette:
 * it is a picture of somebody else's app, and rendering it in our colours would
 * make it a worse answer to the only question it exists to answer: what does
 * this look like over there.
 */
export const DISCORD_BG = '#313338';
export const DISCORD_EMBED_BG = '#2b2d31';
export const DISCORD_TEXT = '#dbdee1';
export const DISCORD_LINK = '#00a8fc';
export const DISCORD_MUTED = '#949ba4';

/**
 * The chip, the code block and the spoiler, in the same spirit.
 *
 * The mention colours are Discord's blurple at 30% flattened against
 * DISCORD_EMBED_BG rather than left translucent, because the preview stacks the
 * chip on one known surface and a flat hex is the value a test can pin.
 */
export const DISCORD_MENTION_BG = '#3c4270';
export const DISCORD_MENTION_TEXT = '#dee0fc';
export const DISCORD_CODE_BG = '#1e1f22';
export const DISCORD_SPOILER_BG = '#232428';

/**
 * WHAT AN EMBED DESCRIPTION ACTUALLY RENDERS, one flag per construct, each with
 * the evidence it rests on.
 *
 * Discord documents mention syntax, and documents its markdown subset for
 * "message content". It says nothing about the embed case, so a citation is not
 * available for most of this and pretending otherwise would be the dishonest
 * option. Instead every flag carries a tag:
 *
 *   VERIFIED: proven against a real Discord client, or written by our own send
 *             path (`lib/actions/discord-message.ts`).
 *   TOOLBAR:  the composer puts a BUTTON on it (`FORMAT_BUTTONS` in
 *             `discord-send.tsx`), so the author already reasoned that it
 *             renders here and the preview owes the reader an answer either way.
 *   OBSERVED: widely seen, on no button in this console, and the weakest claim
 *             in the table. Only `codeBlock` and `autoLink` carry it, NEITHER
 *             has been checked against a live embed yet, and a reader must not
 *             treat them as settled: they are the two rows to test first, and
 *             the two to suspect if the preview and the channel disagree.
 *
 * A FALSE FLAG IS NEVER WORSE THAN THE STATUS QUO. Turning one off renders that
 * construct's markers as the literal characters, which is precisely what this
 * panel did before any of this existed. So one flag flip is the whole fix if
 * Discord turns out to disagree about any single row, with no other edit and no
 * risk to the rest.
 */
const RENDERS_IN_EMBED = {
  /** VERIFIED: a live test in the club's own server, and the send path writes them. */
  roleChip: true,
  /** TOOLBAR: `[label](url)`, the one button already marked `embedOnly`. */
  maskedLink: true,
  /** TOOLBAR: `**bold**`. */
  bold: true,
  /** TOOLBAR: `*italic*`, and `_italic_` for the same reason. */
  italic: true,
  /** TOOLBAR: `__underline__`, which is Discord's spelling and not any HTML. */
  underline: true,
  /** TOOLBAR: `~~struck out~~`. */
  strike: true,
  /** TOOLBAR: `` `code` ``. */
  inlineCode: true,
  /** TOOLBAR: `||spoiler||`. */
  spoiler: true,
  /**
   * TOOLBAR for `## `, which is the only level the button emits. Three levels
   * are enabled because the cost of the other two is a `startsWith` each and
   * an exec who knows Discord will type `# `.
   */
  headings: true,
  /** TOOLBAR: `> ` per line. */
  quote: true,
  /** TOOLBAR: `- `, and `* ` because Discord takes both. One level only. */
  bullets: true,
  /** OBSERVED: a triple-backtick fence. On no button here. */
  codeBlock: true,
  /** OBSERVED: a bare `https://` run turning blue. On no button here. */
  autoLink: true,
} as const;

// WHAT IS DELIBERATELY LEFT AS THE CHARACTERS TYPED, so the gap is a decision
// somebody can read rather than an omission somebody has to discover:
//
//  - `@everyone` and `@here`. `resolveRoleMentions` deliberately never rewrites
//    them (discord-mentions.ts), and neither can ever notify from inside an
//    embed, so drawing them as anything other than text would promise a ping
//    this shape cannot give.
//  - `<@userid>`, `<#channelid>` and `<t:...>`. All three are real Discord
//    syntax and none is reachable from this console's toolbar or from anything
//    the send path writes, so there is no id-to-name map here to draw them with.
//  - `-# subtext`, `>>> ` block quotes, and nested or ordered lists. Same
//    reasoning: no button offers them, and half-rendering a construct is worse
//    than showing what was typed.

/** How deep a wrapper may nest before the parse stops recursing. */
const MAX_DEPTH = 6;

/**
 * THE SCHEME ALLOWLIST. This is the security boundary of the whole file.
 *
 * React does not reliably refuse a `javascript:` href across versions, so an
 * `<a>` is emitted only for a target that matches this. Anything else renders
 * as the characters typed. The same rule is the bare-URL detector below, so
 * there is exactly one answer in this file to "is that a link".
 */
const LINK_SCHEME = /^https?:\/\//i;

/** Anchored at an index rather than slicing, so a 4096-char body is scanned once. */
const CHIP_AT = /<@&(\d+)>/y;
const BARE_URL_AT = /https?:\/\/[^\s<>]+/y;

/** Sentence punctuation a reader means as their own, not as part of the address. */
const URL_TRAILING = /[.,!?;:'")\]]+$/;

function linkTarget(raw: string): string | null {
  return LINK_SCHEME.test(raw) ? raw : null;
}

function anchor(href: string, children: ReactNode, key: number) {
  return (
    <a
      key={key}
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      style={{ color: DISCORD_LINK }}
      className="underline-offset-2 hover:underline"
    >
      {children}
    </a>
  );
}

/**
 * A CHIP EVEN WHEN THIS CONSOLE CANNOT NAME THE ROLE.
 *
 * Discord draws a chip from the id alone, so a chip is shape-honest and the raw
 * snowflake never is: the reader learns the right thing about the layout either
 * way. The realistic unknown is not a deleted role but a live self-assign role
 * from `discord_self_roles` (00168), which is why the fallback reads `@role`
 * rather than anything claiming the role is gone.
 */
function roleChip(id: string, roles: DiscordRoleOption[], key: number) {
  const name = roles.find((r) => r.id === id)?.name;
  return (
    <span
      key={key}
      className="font-medium"
      style={{
        background: DISCORD_MENTION_BG,
        color: DISCORD_MENTION_TEXT,
        borderRadius: 3,
        padding: '0 2px',
      }}
    >
      {`@${name ?? 'role'}`}
    </span>
  );
}

/**
 * The paired-delimiter constructs, IN PRECEDENCE ORDER.
 *
 * `**` sits before `*` and `__` before `_` because the scan takes the first
 * entry that matches at the cursor, so this array IS the precedence rule and
 * reordering it is a behaviour change.
 */
const WRAPPERS: {
  marker: string;
  enabled: boolean;
  render: (children: ReactNode, key: number) => ReactNode;
}[] = [
  {
    marker: '||',
    enabled: RENDERS_IN_EMBED.spoiler,
    // Hidden, and revealed on hover so the writer can check what they hid.
    //
    // The colour is a class and not an inline style, and the hex is repeated
    // from DISCORD_TEXT on purpose: Tailwind extracts arbitrary values from the
    // literal source, and an inline `color` would outrank the hover rule and
    // leave the text permanently invisible.
    render: (children, key) => (
      <span
        key={key}
        className="text-transparent transition-colors hover:text-[#dbdee1]"
        style={{ background: DISCORD_SPOILER_BG, borderRadius: 3, padding: '0 2px' }}
      >
        {children}
      </span>
    ),
  },
  {
    marker: '**',
    enabled: RENDERS_IN_EMBED.bold,
    render: (children, key) => <strong key={key}>{children}</strong>,
  },
  {
    marker: '__',
    enabled: RENDERS_IN_EMBED.underline,
    render: (children, key) => <u key={key}>{children}</u>,
  },
  {
    marker: '~~',
    enabled: RENDERS_IN_EMBED.strike,
    render: (children, key) => <s key={key}>{children}</s>,
  },
  {
    marker: '*',
    enabled: RENDERS_IN_EMBED.italic,
    render: (children, key) => <em key={key}>{children}</em>,
  },
  {
    marker: '_',
    enabled: RENDERS_IN_EMBED.italic,
    render: (children, key) => <em key={key}>{children}</em>,
  },
];

/**
 * One line of text, to nodes. Ordered so the protected forms win.
 */
function renderInline(text: string, roles: DiscordRoleOption[], depth: number): ReactNode[] {
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
  const inner = (raw: string): ReactNode =>
    depth < MAX_DEPTH ? renderInline(raw, roles, depth + 1) : raw;

  while (i < text.length) {
    const ch = text[i]!;

    // A ROLE CHIP, and the closing `>` is required. That requirement is what
    // makes a mention cut in half by `announcementEmbed`'s slice render as the
    // characters it now is, rather than as a chip built from half an id.
    if (RENDERS_IN_EMBED.roleChip && ch === '<') {
      CHIP_AT.lastIndex = i;
      const chip = CHIP_AT.exec(text);
      if (chip) {
        push(roleChip(chip[1]!, roles, key++));
        i += chip[0].length;
        continue;
      }
    }

    // INLINE CODE WINS OVER EVERYTHING AND DOES NOT RECURSE, which is Discord's
    // own rule: `**stars**` between backticks keeps its stars, and an `<@&id>`
    // between them stays the id. Checked before the wrappers because protecting
    // them is the whole point of it.
    if (RENDERS_IN_EMBED.inlineCode && ch === '`') {
      const close = text.indexOf('`', i + 1);
      if (close > i + 1) {
        push(
          <code
            key={key++}
            className="font-mono text-[13px]"
            style={{ background: DISCORD_CODE_BG, borderRadius: 3, padding: '1px 3px' }}
          >
            {text.slice(i + 1, close)}
          </code>,
        );
        i = close + 1;
        continue;
      }
    }

    let wrapped = false;
    for (const w of WRAPPERS) {
      if (!w.enabled || !text.startsWith(w.marker, i)) continue;
      const close = text.indexOf(w.marker, i + w.marker.length);
      // An absent closer (-1) and an empty pair both fail this, and both then
      // render as the markers typed: somebody mid-way through typing `**` sees
      // their asterisks rather than watching the rest of the body change style.
      if (close <= i + w.marker.length) continue;
      push(w.render(inner(text.slice(i + w.marker.length, close)), key++));
      i = close + w.marker.length;
      wrapped = true;
      break;
    }
    if (wrapped) continue;

    // A MASKED LINK, non-greedy to the first `)`. The label takes inline
    // formatting; the URL never does, because formatting characters inside an
    // href are part of the address.
    if (RENDERS_IN_EMBED.maskedLink && ch === '[') {
      const label = text.indexOf(']', i + 1);
      if (label > i && text[label + 1] === '(') {
        const end = text.indexOf(')', label + 2);
        if (end > label + 1) {
          const href = linkTarget(text.slice(label + 2, end));
          if (href) {
            push(anchor(href, inner(text.slice(i + 1, label)), key++));
            i = end + 1;
            continue;
          }
          // A target the allowlist refuses falls through to plain text, so the
          // reader sees exactly the characters that will reach Discord.
        }
      }
    }

    if (RENDERS_IN_EMBED.autoLink && ch === 'h') {
      BARE_URL_AT.lastIndex = i;
      const run = BARE_URL_AT.exec(text);
      if (run) {
        const href = linkTarget(run[0].replace(URL_TRAILING, ''));
        if (href) {
          push(anchor(href, href, key++));
          i += href.length;
          continue;
        }
      }
    }

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

const HEADING_CLASS: Record<1 | 2 | 3, string> = {
  1: 'text-[20px] font-bold leading-tight',
  2: 'text-[17px] font-bold leading-tight',
  3: 'text-[15px] font-semibold leading-tight',
};

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
 * AN UNTERMINATED FENCE IS ORDINARY LINES. That is the only option that cannot
 * invent structure out of a half-typed body: the alternative is that opening a
 * code block silently swallows everything below it, including the paragraph the
 * writer has not finished, and the preview stops showing the post.
 */
function renderBlocks(text: string, roles: DiscordRoleOption[]): ReactNode[] {
  const lines = text.split('\n');
  const blocks: ReactNode[] = [];

  // BLANK LINES STAY IN THE TEXT RUN and the run keeps `whitespace-pre-wrap`,
  // because Discord honours a single newline inside a paragraph. LegalMarkdown
  // joins wrapped lines with a space, which is right for a legal document typed
  // in prose and wrong for a message somebody laid out by hand.
  let para: string[] = [];
  let bullets: string[] = [];
  let quote: string[] = [];

  const flushPara = () => {
    const joined = para.join('\n');
    para = [];
    if (!joined) return;
    blocks.push(
      <div key={blocks.length} className="whitespace-pre-wrap">
        {renderInline(joined, roles, 0)}
      </div>,
    );
  };

  const flushBullets = () => {
    if (bullets.length === 0) return;
    const items = bullets;
    bullets = [];
    blocks.push(
      <ul key={blocks.length} className="list-disc pl-5">
        {items.map((item, i) => (
          <li key={i}>{renderInline(item, roles, 0)}</li>
        ))}
      </ul>,
    );
  };

  const flushQuote = () => {
    if (quote.length === 0) return;
    const joined = quote.join('\n');
    quote = [];
    blocks.push(
      <div
        key={blocks.length}
        className="whitespace-pre-wrap pl-2"
        style={{ borderLeft: `4px solid ${DISCORD_MUTED}` }}
      >
        {renderInline(joined, roles, 0)}
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

    if (RENDERS_IN_EMBED.codeBlock && line.trimStart().startsWith('```')) {
      const end = fenceEnd(lines, i + 1);
      if (end !== -1) {
        flushAll();
        blocks.push(
          <pre
            key={blocks.length}
            className="whitespace-pre-wrap break-words font-mono text-[13px] p-2"
            style={{ background: DISCORD_CODE_BG, borderRadius: 4 }}
          >
            {lines.slice(i + 1, end).join('\n')}
          </pre>,
        );
        i = end;
        continue;
      }
    }

    const heading = RENDERS_IN_EMBED.headings ? headingLevel(line) : 0;
    if (heading !== 0) {
      flushAll();
      const Tag = `h${heading}` as 'h1' | 'h2' | 'h3';
      blocks.push(
        <Tag key={blocks.length} className={HEADING_CLASS[heading]}>
          {renderInline(line.slice(heading + 1), roles, 0)}
        </Tag>,
      );
      continue;
    }

    if (RENDERS_IN_EMBED.bullets && (line.startsWith('- ') || line.startsWith('* '))) {
      flushPara();
      flushQuote();
      bullets.push(line.slice(2));
      continue;
    }

    if (RENDERS_IN_EMBED.quote && line.startsWith('> ')) {
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
 * An embed description, drawn.
 *
 * NO `'use client'`, exactly like LegalMarkdown: the only importer is already a
 * client component, and this module imports nothing but React types and a shape.
 */
export function DiscordMarkdown({
  text,
  roles,
}: {
  text: string;
  roles: DiscordRoleOption[];
}) {
  return <>{renderBlocks(text, roles)}</>;
}
