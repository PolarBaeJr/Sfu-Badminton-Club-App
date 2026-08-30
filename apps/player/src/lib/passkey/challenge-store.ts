// Server-side single-use record for a WebAuthn challenge (00181).
//
// The signed challenge cookie still carries the challenge to the verify route
// and still binds it to a user. What it cannot do is make the challenge
// single-use: clearing a cookie is a response header, not a lock, so two
// requests presenting the same cookie and the same assertion before either
// response lands both find a valid challenge and both verify. The signature
// counter cannot cover for that either, because synced passkeys — which is
// most of them — always report 0.
//
// consumeChallenge() is one atomic UPDATE. Exactly one caller can make it
// affect a row; everyone else gets false.
import { createHash } from 'node:crypto';

export type ChallengePurpose =
  | 'player_login'
  | 'player_register'
  | 'admin_login'
  | 'admin_register'
  | 'admin_stepup';

// Only a hash is stored. The challenge is a bearer value for the length of the
// ceremony and the only operation ever performed on it is equality, so keeping
// the plaintext would add somewhere to steal it from and buy nothing.
function hash(challenge: string): string {
  return createHash('sha256').update(challenge).digest('hex');
}

type RpcClient = { rpc: (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }> };

export async function recordChallenge(
  client: RpcClient,
  challenge: string,
  purpose: ChallengePurpose,
  userId: string | null,
  ttlSeconds: number,
): Promise<void> {
  const { error } = await client.rpc('issue_passkey_challenge', {
    p_challenge_hash: hash(challenge),
    p_purpose: purpose,
    p_user_id: userId,
    p_ttl_seconds: ttlSeconds,
  });
  // Fail the ceremony rather than issuing a challenge nothing can later claim:
  // a challenge with no server-side record would be refused at verify time
  // anyway, and failing here says so while the user can still retry.
  if (error) {
    throw new Error(`Could not record the passkey challenge: ${(error as { message?: string }).message ?? 'unknown'}`);
  }
}

export async function consumeChallenge(
  client: RpcClient,
  challenge: string,
  purpose: ChallengePurpose,
): Promise<boolean> {
  const { data, error } = await client.rpc('consume_passkey_challenge', {
    p_challenge_hash: hash(challenge),
    p_purpose: purpose,
  });
  // An error is not a pass. Anything other than an explicit true is refused.
  if (error) return false;
  return data === true;
}
