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

export function trackEvent(
  event: string,
  playerProps: PlayerProperties,
  extra?: Record<string, unknown>
) {
  const ph = getPostHogClient();
  if (!ph) return;

  ph.capture(event, {
    ...playerProps,
    ...extra,
  });
}
