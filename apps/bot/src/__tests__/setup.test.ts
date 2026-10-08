import { describe, expect, it } from 'vitest';
import { normalize, planSetup, DISPLAY_NAMES, type DiscordRole } from '../setup.js';
import { MANAGED_ROLES } from '../roles.js';

const BOT_POSITION = 50;

function role(name: string, over: Partial<DiscordRole> = {}): DiscordRole {
  return { id: `id-${name}`, name, position: 10, ...over };
}

describe('normalize', () => {
  it('collapses the ways a human writes the same role name', () => {
    const forms = ['Session Staff', 'session-staff', 'session_staff', 'SessionStaff', 'SESSION  STAFF'];
    expect(new Set(forms.map(normalize)).size).toBe(1);
  });

  it('keeps genuinely different names apart', () => {
    expect(normalize('Internal')).not.toBe(normalize('External'));
  });
});

describe('planSetup', () => {
  it('creates everything in an empty server', () => {
    const plan = planSetup([], BOT_POSITION);
    expect(plan.toCreate).toEqual([...MANAGED_ROLES]);
    expect(plan.matched).toEqual([]);
  });

  it('adopts an existing role instead of making a duplicate', () => {
    const plan = planSetup([role('Linked')], BOT_POSITION);
    expect(plan.matched).toEqual([{ role: 'linked', id: 'id-Linked', name: 'Linked' }]);
    expect(plan.toCreate).not.toContain('linked');
  });

  // The point of normalising: a club that named it their own way keeps their
  // name, rather than ending up with two roles that look identical.
  it('adopts a differently-punctuated name and keeps the guild spelling', () => {
    const plan = planSetup([role('session-staff')], BOT_POSITION);
    expect(plan.matched).toEqual([
      { role: 'session_staff', id: 'id-session-staff', name: 'session-staff' },
    ]);
  });

  it('is idempotent — a fully configured server creates nothing', () => {
    const existing = MANAGED_ROLES.map((r) => role(DISPLAY_NAMES[r]));
    const plan = planSetup(existing, BOT_POSITION);
    expect(plan.toCreate).toEqual([]);
    expect(plan.matched).toHaveLength(MANAGED_ROLES.length);
  });

  // Guessing here would decide which Discord role every exec receives.
  it('refuses to guess when two roles share a name', () => {
    const plan = planSetup([role('Linked', { id: 'a' }), role('linked', { id: 'b' })], BOT_POSITION);
    expect(plan.ambiguous).toEqual([{ role: 'linked', names: ['Linked', 'linked'] }]);
    expect(plan.matched).toEqual([]);
    // Crucially NOT queued for creation either — that would add a third.
    expect(plan.toCreate).not.toContain('linked');
  });

  // The silent-failure case: wired up, looks configured, 403s on every sweep.
  it('reports a role above the bot as unusable rather than matching it', () => {
    const plan = planSetup([role('Linked', { position: BOT_POSITION + 1 })], BOT_POSITION);
    expect(plan.unusable).toEqual([{ role: 'linked', name: 'Linked', reason: 'above_bot' }]);
    expect(plan.matched).toEqual([]);
  });

  it('treats a role at exactly the bot position as unusable', () => {
    const plan = planSetup([role('Linked', { position: BOT_POSITION })], BOT_POSITION);
    expect(plan.unusable[0]?.reason).toBe('above_bot');
  });

  it('will not adopt a Discord-managed role', () => {
    const plan = planSetup([role('Linked', { managed: true })], BOT_POSITION);
    expect(plan.unusable).toEqual([{ role: 'linked', name: 'Linked', reason: 'discord_managed' }]);
  });

  it('ignores @everyone', () => {
    const plan = planSetup([role('@everyone', { position: 0 })], BOT_POSITION);
    expect(plan.matched).toEqual([]);
    expect(plan.ambiguous).toEqual([]);
    expect(plan.toCreate).toEqual([...MANAGED_ROLES]);
  });

  it('ignores unrelated server roles', () => {
    const plan = planSetup([role('Moderator'), role('Bots'), role('Linked')], BOT_POSITION);
    expect(plan.matched.map((m) => m.role)).toEqual(['linked']);
  });

  it('handles a partly-configured server', () => {
    const plan = planSetup([role('Linked'), role('Executives')], BOT_POSITION);
    expect(plan.matched.map((m) => m.role).sort()).toEqual(['executives', 'linked']);
    expect(plan.toCreate).toHaveLength(MANAGED_ROLES.length - 2);
  });

  // Every managed role must be accounted for in exactly one bucket, always --
  // one silently dropped is a role that never syncs and never explains why.
  it('accounts for every managed role exactly once', () => {
    const plan = planSetup(
      [role('Linked'), role('VP', { position: BOT_POSITION + 5 }), role('Alumni', { managed: true })],
      BOT_POSITION
    );
    const seen = [
      ...plan.matched.map((m) => m.role),
      ...plan.toCreate,
      ...plan.ambiguous.map((a) => a.role),
      ...plan.unusable.map((u) => u.role),
    ];
    expect(seen.sort()).toEqual([...MANAGED_ROLES].sort());
  });

  it('names every managed role in DISPLAY_NAMES', () => {
    for (const r of MANAGED_ROLES) expect(DISPLAY_NAMES[r]).toBeTruthy();
  });
});
