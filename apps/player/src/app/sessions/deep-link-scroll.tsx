'use client';
import { useEffect } from 'react';

// Calendar entries and pushes link to /feed?s=<id>, and an old /sessions?s=<id>
// is redirected there with the id kept. On arrival, scroll that session's card
// (id="session-<id>") into view and flash a brief highlight. That id must not
// change shape. Closed sessions have no card, so the lookup simply no-ops.
export function DeepLinkScroll() {
  useEffect(() => {
    const id = new URLSearchParams(window.location.search).get('s');
    if (!id) return;
    const el = document.getElementById(`session-${id}`);
    if (!el) return;
    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    el.classList.add('session-deeplink-flash');
    const timer = setTimeout(() => el.classList.remove('session-deeplink-flash'), 1500);
    return () => clearTimeout(timer);
  }, []);

  return null;
}
