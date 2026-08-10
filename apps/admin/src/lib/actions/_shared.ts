// Internal helpers for admin server actions. NOT a 'use server' module —
// these aren't async actions exposed to the client, just utilities
// imported by the per-domain action files.
import {
  getAuthenticatedAdmin,
  getAuthenticatedExecOrAdmin,
  getAuthenticatedConsoleUser,
} from '../supabase-server';
import type { Portfolio } from '../permissions';

export async function getAdminPlayer() {
  return getAuthenticatedAdmin();
}

// Every caller names the exec portfolio its work belongs to, and the argument is
// required — see getAuthenticatedExecOrAdmin() for why an optional one would
// fail open at every call site that forgot it.
export async function getExecOrAdmin(portfolio: Portfolio) {
  return getAuthenticatedExecOrAdmin(portfolio);
}

// Admin, exec OR varsity trainer. Only for the handful of actions a trainer is
// meant to perform — varsity notes. Everything else under /players stays on
// getExecOrAdmin(), which rejects a trainer outright rather than leaving the
// field guard to notice an empty payload.
export async function getConsoleUser() {
  return getAuthenticatedConsoleUser();
}
