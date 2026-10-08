'use client';

import { useEffect } from 'react';
import { getPostHogClient } from '@/lib/posthog';

type Props = {
  playerId: string | null;
  playerStatus: string | null;
  singlesElo: number | null;
  doublesElo: number | null;
};

export function PostHogIdentify({ playerId, playerStatus, singlesElo, doublesElo }: Props) {
  useEffect(() => {
    const ph = getPostHogClient();
    if (!ph || !playerId) return;

    ph.identify(playerId, {
      player_status: playerStatus,
      singles_elo: singlesElo,
      doubles_elo: doublesElo,
    });
  }, [playerId, playerStatus, singlesElo, doublesElo]);

  return null;
}
