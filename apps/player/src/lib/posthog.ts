import posthog from 'posthog-js';

let initialized = false;

export function getPostHogClient() {
  if (typeof window === 'undefined') return null;

  if (!initialized && process.env.NEXT_PUBLIC_POSTHOG_KEY) {
    posthog.init(process.env.NEXT_PUBLIC_POSTHOG_KEY, {
      api_host: process.env.NEXT_PUBLIC_POSTHOG_HOST || 'https://us.i.posthog.com',
      person_profiles: 'identified_only',
      capture_pageview: true,
      capture_pageleave: true,
      // Cookieless persistence: keep analytics state in localStorage only, not a
      // cookie. Every cookie is sent on the same-origin Realtime websocket
      // handshake, and the Realtime service (Cowboy) rejects requests whose
      // Cookie header exceeds ~4KB with a 431, causing a reconnect loop. Dropping
      // PostHog's cookie shrinks that header (and is better for privacy).
      persistence: 'localStorage',
    });
    initialized = true;
  }

  return posthog;
}

type PlayerProperties = {
  player_id: string;
  player_status: string;
  singles_elo: number;
  doubles_elo: number;
};

