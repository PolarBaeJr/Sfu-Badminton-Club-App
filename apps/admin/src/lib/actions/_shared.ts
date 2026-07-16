// Internal helpers for admin server actions. NOT a 'use server' module —
// these aren't async actions exposed to the client, just utilities
// imported by the per-domain action files.
import { getAuthenticatedAdmin } from '../supabase-server';

export async function getAdminPlayer() {
  return getAuthenticatedAdmin();
}
