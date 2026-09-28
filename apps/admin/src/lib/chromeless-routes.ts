// Pages the console renders with no sidebar, no page frame and no tour: the
// ways in, the refusals, and /passkey-required, which stands between someone
// and the console until they add a console passkey (00262). One list, used by
// the sidebar, the main frame, the tour host and the passkey banner.
export function isChromelessRoute(pathname: string): boolean {
  return (
    pathname === '/login' ||
    pathname.startsWith('/auth') ||
    pathname === '/unauthorized' ||
    pathname === '/unavailable' ||
    pathname === '/passkey-required'
  );
}
