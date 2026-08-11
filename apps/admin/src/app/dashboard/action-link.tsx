import Link from 'next/link';

/**
 * A LINK THAT LOOKS LIKE A BUTTON.
 *
 * `@badminton/ui`'s `Button` renders a `<button>`, and a `<button>` inside an
 * `<a>` is invalid HTML: it is unreachable by keyboard and a screen reader
 * announces the pair as one control. The dashboard's header action and the
 * alert band's Review both NAVIGATE — every control on this page is a signpost
 * into the section that owns the work — so they have to be anchors, and this is
 * the anchor with the console's button skin on it.
 *
 * The class strings are transcribed from Button rather than shared, because
 * packages/ui does not export them and this screen may not edit that package.
 * They must stay in step with it; there is no colour or size here that is not
 * already in that component.
 *
 * `min-h-[44px]` on every size, not just the large one: the guidelines put a
 * 44px floor under anything an officer taps while holding a phone, and both
 * uses of this component are tap targets at the top of the page.
 */
export function ActionLink({
  href,
  variant = 'primary',
  children,
}: {
  href: string;
  variant?: 'primary' | 'ghost';
  children: React.ReactNode;
}) {
  const base =
    'inline-flex items-center justify-center gap-2 whitespace-nowrap border px-4 min-h-[44px] text-[11px] font-bold uppercase tracking-[0.16em] rounded-none transition-all duration-150 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--red)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg)]';
  const variants = {
    primary: 'bg-[var(--red)] text-white border-transparent hover:bg-[var(--red-ink)]',
    ghost:
      'bg-transparent text-[var(--ink-2)] border-[var(--line)] hover:bg-[var(--surface-2)] hover:text-[var(--ink)]',
  };
  return (
    <Link href={href} className={`${base} ${variants[variant]}`}>
      {children}
    </Link>
  );
}
