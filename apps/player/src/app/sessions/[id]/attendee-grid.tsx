'use client';

import { useState } from 'react';
import { Avatar } from '@/components/v2/atoms-display';
import { ChallengeSheet } from '../../challenges/challenge-sheet';

type Attendee = {
  id: string;
  full_name: string;
  avatar_url: string | null;
  singles_elo: number | null;
};

interface Props {
  attendees: Attendee[];
  /** Current player's id — used to mark the "You" tile and skip the
   *  "challenge yourself" interaction. */
  meId: string;
  /** Past sessions disable the tap-to-challenge interaction (no point
   *  challenging someone for a session that already happened). */
  allowChallenge: boolean;
}

export function SessionAttendeeGrid({ attendees, meId, allowChallenge }: Props) {
  const [presetOpponentId, setPresetOpponentId] = useState<string | null>(null);
  const sheetOpen = presetOpponentId !== null;

  return (
    <>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
          gap: 12,
        }}
      >
        {attendees.map((a) => {
          const isMe = a.id === meId;
          const interactive = allowChallenge && !isMe;
          return (
            <button
              key={a.id}
              type="button"
              disabled={!interactive}
              onClick={() => {
                if (interactive) setPresetOpponentId(a.id);
              }}
              aria-label={interactive ? `Challenge ${a.full_name}` : a.full_name}
              style={{
                background: 'var(--surface1)',
                border: isMe ? '1px solid var(--red)' : '1px solid var(--hairline)',
                padding: '16px 12px',
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'center',
                gap: 8,
                cursor: interactive ? 'pointer' : 'default',
                fontFamily: 'inherit',
                color: 'inherit',
                textAlign: 'center',
                transition: 'border-color 120ms ease',
              }}
            >
              <Avatar name={a.full_name} src={a.avatar_url} size={44} ring={isMe} />
              <div style={{ minWidth: 0, width: '100%' }}>
                <div
                  style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: 'var(--ink)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {a.full_name.split(' ')[0]}
                  {isMe && (
                    <span
                      style={{
                        marginLeft: 6,
                        color: 'var(--red)',
                        fontSize: 10,
                        letterSpacing: '0.1em',
                      }}
                    >
                      YOU
                    </span>
                  )}
                </div>
                <div
                  style={{
                    fontSize: 10,
                    color: 'var(--dim)',
                    fontFamily: 'JetBrains Mono, monospace',
                    fontWeight: 600,
                    marginTop: 2,
                    letterSpacing: '0.04em',
                  }}
                >
                  ELO {a.singles_elo ?? '—'}
                </div>
              </div>
              {interactive && (
                <span
                  style={{
                    fontSize: 9,
                    color: 'var(--red)',
                    fontWeight: 700,
                    letterSpacing: '0.16em',
                    textTransform: 'uppercase',
                    marginTop: 2,
                  }}
                >
                  Challenge →
                </span>
              )}
            </button>
          );
        })}
      </div>

      <ChallengeSheet
        open={sheetOpen}
        onClose={() => setPresetOpponentId(null)}
        presetOpponentId={presetOpponentId}
      />
    </>
  );
}
