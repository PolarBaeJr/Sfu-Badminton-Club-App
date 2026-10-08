// Internal helpers for admin server actions. NOT a 'use server' module —
// these aren't async actions exposed to the client, just utilities
// imported by the per-domain action files.
import { requireCapability as requireCapabilityGate } from '../supabase-server';
import type { Capability } from '../permissions';

// Every action names the ONE capability its work requires. There is no second
// question about level: the baselines say which levels hold which capability,
// and permits() is the whole check.
//
// Re-exported through this module rather than imported from ../supabase-server
// at each call site because this is the seam the action tests mock. A call site
// that reached past it would silently stop being gated in the suite.
export async function requireCapability(capability: Capability) {
  return requireCapabilityGate(capability);
}
