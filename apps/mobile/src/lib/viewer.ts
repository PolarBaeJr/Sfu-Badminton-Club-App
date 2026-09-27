import type { MobileClient } from './supabase/client';

/** The signed-in member, as the screens need them. */
export interface Viewer {
  id: string;
  full_name: string | null;
  status: string | null;
  is_exec: boolean | null;
  fee_exempt: boolean | null;
  avatar_url: string | null;
  created_at: string | null;
  handle: string | null;
  member_code: string | null;
}

/**
 * Two reads, because neither source has everything. players_self is the
 * caller's own full row (a definer view filtered to auth.uid()), but handle and
 * member_code came later and are read from players under their own column
 * grant. players has only column grants for `authenticated`, so a select('*')
 * there is refused outright: name the columns.
 *
 * Null with no error means no player row: an account that never finished
 * signing up on the website.
 */
export async function loadViewer(supabase: MobileClient, userId: string): Promise<Viewer | null> {
  const self = await supabase
    .from('players_self')
    .select('id, full_name, status, is_exec, fee_exempt, avatar_url, created_at')
    .maybeSingle();
  if (self.error) throw new Error(`Could not read your profile: ${self.error.message}`);
  if (!self.data || !self.data.id) return null;

  const extra = await supabase
    .from('players')
    .select('handle, member_code')
    .eq('user_id', userId)
    .maybeSingle();
  if (extra.error) throw new Error(`Could not read your member number: ${extra.error.message}`);

  return {
    id: self.data.id,
    full_name: self.data.full_name,
    status: self.data.status,
    is_exec: self.data.is_exec,
    fee_exempt: self.data.fee_exempt,
    avatar_url: self.data.avatar_url,
    created_at: self.data.created_at,
    handle: extra.data?.handle ?? null,
    member_code: extra.data?.member_code ?? null,
  };
}

/** Approved: neither waiting for an exec nor suspended. The web's test. */
export function isApproved(viewer: Pick<Viewer, 'status'>): boolean {
  return viewer.status !== 'pending_approval' && viewer.status !== 'suspended';
}
