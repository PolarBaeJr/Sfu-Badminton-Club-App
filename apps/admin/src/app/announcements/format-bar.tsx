'use client';

// 'use client' because this module calls `document.execCommand` and
// `requestAnimationFrame` and attaches handlers. Both importers
// (discord-send.tsx and actions.tsx) are already client components.

// DISCORD'S MARKDOWN, PUT ON BUTTONS so nobody has to remember it.
//
// This is Discord's set specifically and not a general markdown one. Underline
// is `__text__` rather than any HTML, a spoiler is `||text||`, and a masked
// link `[text](url)` renders inside an EMBED but not in a plain message, where
// Discord shows the raw brackets instead. That is why the link button is
// offered on the embed body alone.
export type Format =
  | { kind: 'wrap'; before: string; after: string }
  | { kind: 'prefix'; prefix: string };

/**
 * Which box a button is offered on.
 *
 * 'message' and 'embed' are the two Discord shapes; 'website' is the club's own
 * announcement body, which the player app renders itself
 * (apps/player/src/lib/announcement-markdown.tsx).
 */
export type FormatSurface = 'message' | 'embed' | 'website';

export interface FormatButton {
  label: string;
  title: string;
  /** What lands when nothing is selected, so a click is never a no-op. */
  sample: string;
  format: Format;
  /** Styles the button to look like what it does. */
  labelClass?: string;
  /**
   * The boxes this button appears on.
   *
   * Masked links render in an embed and nowhere else, which is why the link
   * button carries 'embed' alone.
   *
   * The website omits both the spoiler and the link. A spoiler is meaningless
   * on a page: there is no click-to-reveal in the club's own renderer and
   * nothing to hide from. And an anchor cannot be emitted at all, because the
   * feed's CLUB NOTICE body sits inside a `<Link>` (feed/page.tsx) and an `<a>`
   * inside an `<a>` is invalid markup, so the renderer emits no anchors and a
   * button producing link syntax would write markup that stays literal.
   */
  surfaces: FormatSurface[];
}

const ALL_SURFACES: FormatSurface[] = ['message', 'embed', 'website'];

export const FORMAT_BUTTONS: FormatButton[] = [
  { label: 'B', title: 'Bold', sample: 'bold text', labelClass: 'font-bold', surfaces: ALL_SURFACES,
    format: { kind: 'wrap', before: '**', after: '**' } },
  { label: 'I', title: 'Italic', sample: 'italic text', labelClass: 'italic', surfaces: ALL_SURFACES,
    format: { kind: 'wrap', before: '*', after: '*' } },
  { label: 'U', title: 'Underline', sample: 'underlined', labelClass: 'underline', surfaces: ALL_SURFACES,
    format: { kind: 'wrap', before: '__', after: '__' } },
  { label: 'S', title: 'Strikethrough', sample: 'struck out', labelClass: 'line-through', surfaces: ALL_SURFACES,
    format: { kind: 'wrap', before: '~~', after: '~~' } },
  { label: '</>', title: 'Inline code', sample: 'code', surfaces: ALL_SURFACES,
    format: { kind: 'wrap', before: '`', after: '`' } },
  { label: '||', title: 'Spoiler, hidden until clicked', sample: 'spoiler', surfaces: ['message', 'embed'],
    format: { kind: 'wrap', before: '||', after: '||' } },
  { label: 'H', title: 'Heading', sample: 'Heading', surfaces: ALL_SURFACES,
    format: { kind: 'prefix', prefix: '## ' } },
  { label: '>', title: 'Quote', sample: 'quoted line', surfaces: ALL_SURFACES,
    format: { kind: 'prefix', prefix: '> ' } },
  { label: '•', title: 'Bullet list', sample: 'list item', surfaces: ALL_SURFACES,
    format: { kind: 'prefix', prefix: '- ' } },
  { label: '[]', title: 'Link, renders in an embed only', sample: 'label', surfaces: ['embed'],
    format: { kind: 'wrap', before: '[', after: '](https://)' } },
];

/**
 * Rewrite the selection in place and leave the caret somewhere useful.
 *
 * `execCommand` IS TRIED FIRST, and not for the sake of old browsers: it is the
 * only way to change a textarea that keeps the browser's own undo stack, so
 * Ctrl+Z walks back through a formatting click exactly as it walks back through
 * typing. Setting React state instead throws that history away. It is
 * deprecated but implemented everywhere this console runs, and the state write
 * below is the fallback for the day it is not.
 */
function applyFormat(
  el: HTMLTextAreaElement,
  button: FormatButton,
  commit: (next: string) => void,
) {
  const { selectionStart, selectionEnd, value } = el;
  let from = selectionStart;
  let to = selectionEnd;
  let replacement: string;
  let caretFrom: number;
  let caretTo: number;

  if (button.format.kind === 'prefix') {
    // A prefix marks whole lines, so the edit covers every line the selection
    // touches however little of the first and last one the pointer caught.
    const { prefix } = button.format;
    from = value.lastIndexOf('\n', selectionStart - 1) + 1;
    const lineEnd = value.indexOf('\n', selectionEnd);
    to = lineEnd === -1 ? value.length : lineEnd;
    const lines = (value.slice(from, to) || button.sample).split('\n');
    // A second click on an already-marked block takes the marker off again,
    // which is what every editor does and what stops '> > > ' accumulating.
    const marked = lines.every((line) => line.startsWith(prefix));
    replacement = lines
      .map((line) => (marked ? line.slice(prefix.length) : prefix + line))
      .join('\n');
    caretFrom = from;
    caretTo = from + replacement.length;
  } else {
    const { before, after } = button.format;
    const body = value.slice(from, to) || button.sample;
    replacement = before + body + after;
    // With nothing selected the sample lands already selected, so the next
    // keystroke replaces it rather than appending to it.
    caretFrom = from + before.length;
    caretTo = caretFrom + body.length;
  }

  el.focus();
  el.setSelectionRange(from, to);
  if (!document.execCommand('insertText', false, replacement)) {
    commit(value.slice(0, from) + replacement + value.slice(to));
  }

  // Either path leaves the caret collapsed at the end of the insert. Put it
  // back around the words, after the re-render, so the next click or keystroke
  // carries on from where the writer is looking.
  requestAnimationFrame(() => {
    el.focus();
    el.setSelectionRange(caretFrom, caretTo);
  });
}

export function FormatBar({
  target,
  onChange,
  surface,
}: {
  target: React.RefObject<HTMLTextAreaElement | null>;
  onChange: (next: string) => void;
  surface: FormatSurface;
}) {
  return (
    <div className="flex flex-wrap items-center gap-1 pb-1.5">
      {FORMAT_BUTTONS.filter((b) => b.surfaces.includes(surface)).map((b) => (
        <button
          key={b.title}
          type="button"
          title={b.title}
          aria-label={b.title}
          // onMouseDown WITH preventDefault, never onClick. A click moves focus
          // out of the textarea before it fires, and the selection this button
          // exists to act on is gone by then.
          onMouseDown={(e) => {
            e.preventDefault();
            const el = target.current;
            if (el) applyFormat(el, b, onChange);
          }}
          className={`min-h-[28px] min-w-[30px] px-2 border border-[var(--border)] bg-[var(--bg-surface)] font-mono text-[11px] leading-none text-[var(--text-secondary)] transition-colors hover:border-[var(--text-muted)] hover:text-[var(--text-primary)] ${b.labelClass ?? ''}`}
        >
          {b.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Ctrl+B and Ctrl+I, because those are what a writer's hands do without being
 * asked. Everything else stays on the buttons rather than competing with the
 * browser's own shortcuts.
 */
export function formatShortcut(
  e: React.KeyboardEvent<HTMLTextAreaElement>,
  onChange: (next: string) => void,
) {
  if (!e.metaKey && !e.ctrlKey) return;
  const key = e.key.toLowerCase();
  const button = FORMAT_BUTTONS.find(
    (b) => (key === 'b' && b.title === 'Bold') || (key === 'i' && b.title === 'Italic'),
  );
  if (!button) return;
  e.preventDefault();
  applyFormat(e.currentTarget, button, onChange);
}
