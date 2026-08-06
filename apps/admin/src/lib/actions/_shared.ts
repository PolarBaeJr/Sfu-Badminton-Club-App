// Internal helpers for admin server actions. NOT a 'use server' module —
// these aren't async actions exposed to the client, just utilities
// imported by the per-domain action files.
import {
  getAuthenticatedAdmin,
  getAuthenticatedExecOrAdmin,
  getAuthenticatedConsoleUser,
} from '../supabase-server';

export async function getAdminPlayer() {
  return getAuthenticatedAdmin();
}

export async function getExecOrAdmin() {
  return getAuthenticatedExecOrAdmin();
}

// Admin, exec OR varsity trainer. Only for the handful of actions a trainer is
// meant to perform — varsity notes. Everything else under /players stays on
// getExecOrAdmin(), which rejects a trainer outright rather than leaving the
// field guard to notice an empty payload.
export async function getConsoleUser() {
  return getAuthenticatedConsoleUser();
}
