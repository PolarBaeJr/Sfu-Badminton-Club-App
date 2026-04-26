export const QR_EXPIRES_IN_DAYS = 14;

export type GeneratedQr = {
  url: string;
  token: string;
  expiresAt: string;
  players: { full_name: string; team_side: 'a' | 'b' }[];
  format: string;
  matchType: string;
};
