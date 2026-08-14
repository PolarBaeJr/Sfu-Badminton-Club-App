'use client';

import React from 'react';
import { RefreshCw } from 'lucide-react';
import {
  getStaleBuildServerSnapshot,
  installStaleBuildDetector,
  isStaleBuild,
  subscribeToStaleBuild,
} from '@badminton/shared/src/utils/stale-build-client';

// Deep imports rather than the '@badminton/shared' barrel on purpose: the
// barrel re-exports ./email/sender, which pulls `resend` in. This module is
// 'use client', so everything it touches is a candidate for the browser bundle.
// The admin middleware imports from the same depth for the same kind of reason.
export { isStaleBuild, installStaleBuildDetector, markStaleBuild, subscribeToStaleBuild } from '@badminton/shared/src/utils/stale-build-client';
export { isUnrecognizedActionError as isStaleBuildError } from '@badminton/shared/src/utils/stale-build';

/**
 * Above TOAST_Z_INDEX (200), and so above every layer in the ladder documented
 * in Toast.tsx. Deliberate: this banner is the only exit from a tab whose build
 * has moved, and an open Dialog (50) or Dropdown (100) is exactly the situation
 * in which it appears. Nothing may cover it.
 */
export const STALE_BUILD_Z_INDEX = 210;

/**
 * Mount once, from the root layout of each app.
 *
 * Deliberately NOT an auto-reload. An exec on the door has a check-in list
 * open; a member may be halfway through typing a score, or holding a dialog.
 * Reloading under them throws that away to fix a problem they did not cause.
 * So: say what happened, say what fixes it, and let them press it.
 *
 * Deliberately not dismissible either. Every write from this tab fails until it
 * reloads, so a dismiss control would only hide the one way out. It is a
 * ~48px bar rather than a modal precisely so it can be ignored without being
 * closed — the page underneath stays readable and usable for anything that
 * does not write.
 */
export function StaleBuildBanner() {
  const stale = React.useSyncExternalStore(
    subscribeToStaleBuild,
    isStaleBuild,
    getStaleBuildServerSnapshot,
  );
  const [reloading, setReloading] = React.useState(false);

  // Installed from an effect, which runs on hydration — long before any button
  // in the tree has a handler that could fire a server action.
  React.useEffect(() => {
    installStaleBuildDetector();
  }, []);

  if (!stale) return null;

  return (
    <div
      role="alert"
      aria-live="assertive"
      // No radius: full-bleed bar, and the apps' Tailwind config zeroes the
      // whole radius scale anyway (see apps/*/tailwind.config.ts).
      className="fixed top-0 left-0 right-0 bg-[var(--bg-elevated)] text-[var(--text-primary)] shadow-lg"
      style={{
        zIndex: STALE_BUILD_Z_INDEX,
        borderBottom: '2px solid var(--color-accent)',
        // env() inline rather than the player app's .safe-top class, which the
        // console's stylesheet does not define.
        paddingTop: 'env(safe-area-inset-top, 0px)',
      }}
    >
      <div className="flex items-center justify-between gap-3 px-4 py-2 max-w-[1360px] mx-auto">
        <div className="flex items-start gap-3 min-w-0">
          <RefreshCw
            className="w-4 h-4 shrink-0 mt-[3px]"
            style={{ color: 'var(--color-accent)' }}
            aria-hidden="true"
          />
          {/* "was not saved" is a claim, so it had better be true: the server
              rejects an unknown action id before the handler runs, so the write
              never reached the database. Anything the member completed earlier
              in this tab did save, which is why this says "your last change"
              and not "your work". */}
          <p className="min-w-0 text-sm leading-snug">
            <span className="font-semibold">The app was updated.</span>{' '}
            <span className="text-[var(--text-secondary)]">
              Your last change was not saved. Reload to continue.
            </span>
          </p>
        </div>
        <button
          type="button"
          onClick={() => {
            setReloading(true);
            window.location.reload();
          }}
          disabled={reloading}
          // 44px floor: an exec taps this at the door, on a phone, in a hurry.
          className="shrink-0 min-h-[44px] px-4 inline-flex items-center justify-center border border-transparent bg-[var(--color-accent)] text-white text-[11px] font-bold uppercase tracking-[0.16em] hover:bg-[var(--color-accent-hover)] disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-[var(--color-accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[var(--bg-elevated)]"
        >
          {reloading ? 'Reloading…' : 'Reload'}
        </button>
      </div>
    </div>
  );
}
