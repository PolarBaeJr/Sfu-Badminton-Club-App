// Internal helpers for admin server actions. NOT a 'use server' module —
// these aren't async actions exposed to the client, just utilities
// imported by the per-domain action files.
import { getAuthenticatedAdmin, getAuthenticatedExecOrAdmin } from '../supabase-server';

export async function getAdminPlayer() {
  return getAuthenticatedAdmin();
}

export async function getExecOrAdmin() {
  return getAuthenticatedExecOrAdmin();
}
