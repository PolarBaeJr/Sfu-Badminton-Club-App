import { describe, it, expect, vi, beforeEach } from 'vitest';

// /signup. The command answers with a modal at once (type 9, never deferred),
// every later screen is the same ephemeral message edited in place, and the
// app decides what is asked: this file only draws it. The caller is read off
// the interaction, and nothing is posted where a channel would see it.

const { signupStep } = vi.hoisted(() => ({ signupStep: vi.fn() }));

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  signupStep,
}));

import {
  COMMAND_DEFINITIONS,
  DEFERRED_COMMANDS,
  dispatch,
  handleSignupInteraction,
  isSignupInteraction,
  renderSignupScreen,
  type BotResponse,
} from '../commands.js';
import type { SignupScreen } from '../api.js';

const CALLER = '111111111111111111';
const CONTEXT = { discordUserId: CALLER, guildId: 'g1' };

type Button = { type: number; style: number; label: string; custom_id: string };
type Message = {
  content: string;
  flags: number;
  embeds: { title: string; description: string; footer: { text: string } }[];
  components: { type: number; components: Button[] }[];
  allowed_mentions: unknown;
};

function buttons(message: Record<string, unknown>): Button[] {
  return (message as unknown as Message).components.flatMap((row) => row.components);
}

const fetchSpy = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal('fetch', fetchSpy);
});

async function finish(response: BotResponse): Promise<Message> {
  expect(response.finish).toBeTypeOf('function');
  return (await response.finish!()).data as unknown as Message;
}

describe('the command', () => {
  it('is defined with no options and is not deferred', () => {
    const definition = COMMAND_DEFINITIONS.find((command) => command.name === 'signup');
    expect(definition).toMatchObject({ name: 'signup', options: [] });
    expect(DEFERRED_COMMANDS.has('signup')).toBe(false);
  });

  it('answers with the details modal straight away, calling nothing', async () => {
    const response = (await dispatch('signup', undefined, CONTEXT)) as BotResponse;
    expect(response.type).toBe(9);
    const data = response.data as { custom_id: string; components: { components: { custom_id: string; required: boolean }[] }[] };
    expect(data.custom_id).toBe('signup:details');
    const inputs = data.components.map((row) => row.components[0]!);
    expect(inputs.map((input) => [input.custom_id, input.required])).toEqual([
      ['email', true],
      ['first_name', true],
      ['last_name', true],
      ['display_name', false],
      ['phone', false],
    ]);
    expect(signupStep).not.toHaveBeenCalled();
  });
});

describe('the steps', () => {
  it('the details submit is deferred ephemeral and sends what was typed as the caller', async () => {
    signupStep.mockResolvedValue({
      ok: true,
      screen: { kind: 'choice', step: 'events', prompt: 'Which events do you play in tournaments?', choices: [] },
    });
    const field = (custom_id: string, value: string) => ({ type: 1, components: [{ type: 4, custom_id, value }] });
    const response = handleSignupInteraction(
      'signup:details',
      [field('email', 'ada@example.test'), field('first_name', 'Ada'), field('last_name', 'Lovelace'), field('display_name', ''), field('phone', '')],
      CONTEXT
    );
    expect(response).toMatchObject({ type: 5, data: { flags: 64 } });
    await finish(response);
    expect(signupStep).toHaveBeenCalledWith({
      discordUserId: CALLER,
      action: 'details',
      email: 'ada@example.test',
      firstName: 'Ada',
      lastName: 'Lovelace',
      displayName: '',
      phone: '',
    });
  });

  it('a button is a deferred update of the same message', async () => {
    signupStep.mockResolvedValue({ ok: true, screen: { kind: 'code_sent' } });
    const response = handleSignupInteraction('signup:events:open', undefined, CONTEXT);
    expect(response.type).toBe(6);
    const message = await finish(response);
    expect(signupStep).toHaveBeenCalledWith({ discordUserId: CALLER, action: 'events', answer: 'open' });
    expect(message.flags).toBe(64);
  });

  it('Enter code opens the code modal at once', () => {
    const response = handleSignupInteraction('signup:code', undefined, CONTEXT);
    expect(response).toMatchObject({ type: 9, data: { custom_id: 'signup:verify' } });
    expect(response.finish).toBeUndefined();
  });

  it('the code modal is a deferred update that verifies', async () => {
    signupStep.mockResolvedValue({ ok: true, screen: { kind: 'done', approved: false, linked: true } });
    const response = handleSignupInteraction('signup:verify', [{ type: 1, components: [{ type: 4, custom_id: 'code', value: '123456' }] }], CONTEXT);
    expect(response.type).toBe(6);
    const message = await finish(response);
    expect(signupStep).toHaveBeenCalledWith({ discordUserId: CALLER, action: 'verify', code: '123456' });
    expect(message.content).toContain('Account created');
    expect(message.components).toEqual([]);
  });

  it('parses every button into its step', async () => {
    signupStep.mockResolvedValue({ ok: true, screen: { kind: 'code_sent' } });
    const cases: [string, Record<string, unknown>][] = [
      ['signup:tier:beginner', { action: 'tier', tier: 'beginner' }],
      ['signup:page:waiver:2', { action: 'page', document: 'waiver', page: 2 }],
      ['signup:accept:waiver:0123456789abcdef', { action: 'accept', document: 'waiver', versionTag: '0123456789abcdef' }],
      ['signup:age:yes', { action: 'age' }],
      ['signup:consent:yes', { action: 'consent', consent: true }],
      ['signup:consent:no', { action: 'consent', consent: false }],
      ['signup:cancel', { action: 'cancel' }],
      ['signup:resend', { action: 'resend' }],
      ['signup:resume', { action: 'resume' }],
    ];
    for (const [customId, expected] of cases) {
      signupStep.mockClear();
      await finish(handleSignupInteraction(customId, undefined, CONTEXT));
      expect(signupStep).toHaveBeenCalledWith({ discordUserId: CALLER, ...expected });
    }
  });

  it('a failure offers Try again and never logs what was typed', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    signupStep.mockRejectedValue(new Error('POST /api/discord/signup -> 503'));
    const field = (custom_id: string, value: string) => ({ type: 1, components: [{ type: 4, custom_id, value }] });
    const message = await finish(
      handleSignupInteraction('signup:details', [field('email', 'secret@example.com'), field('phone', '6045550100')], CONTEXT)
    );
    expect(buttons(message as unknown as Record<string, unknown>).map((button) => button.custom_id)).toContain('signup:resume');
    const logged = JSON.stringify(errorSpy.mock.calls);
    expect(logged).not.toContain('secret@example.com');
    expect(logged).not.toContain('6045550100');
    errorSpy.mockRestore();
  });

  it('never calls Discord directly', async () => {
    signupStep.mockResolvedValue({ ok: true, screen: { kind: 'code_sent' } });
    await finish(handleSignupInteraction('signup:resend', undefined, CONTEXT));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('owns every signup: custom_id and nothing else', () => {
    expect(isSignupInteraction('signup:cancel')).toBe(true);
    expect(isSignupInteraction('selfrole:1')).toBe(false);
  });
});

describe('drawing a screen', () => {
  it('the events question has Men\'s, Women\'s, Open events only and Cancel sign-up', () => {
    const message = renderSignupScreen({
      kind: 'choice',
      step: 'events',
      prompt: 'Which events do you play in tournaments?',
      choices: [
        { value: 'mens', label: "Men's" },
        { value: 'womens', label: "Women's" },
        { value: 'open', label: 'Open events only' },
      ],
    });
    expect(buttons(message).map((button) => [button.label, button.custom_id])).toEqual([
      ["Men's", 'signup:events:mens'],
      ["Women's", 'signup:events:womens'],
      ['Open events only', 'signup:events:open'],
      ['Cancel sign-up', 'signup:cancel'],
    ]);
    expect(message.flags).toBe(64);
  });

  const page = (pageNumber: number, pageCount: number): SignupScreen => ({
    kind: 'document',
    document: 'code_of_conduct',
    title: 'Code of Conduct',
    version: '2026-09',
    versionTag: '0123456789abcdef',
    page: pageNumber,
    pageCount,
    text: 'x'.repeat(4000),
  });

  it('I accept appears only on the last page', () => {
    const labels = (screen: SignupScreen) => buttons(renderSignupScreen(screen)).map((button) => button.label);
    expect(labels(page(0, 3))).toEqual(['Next', 'Cancel sign-up']);
    expect(labels(page(1, 3))).toEqual(['Previous', 'Next', 'Cancel sign-up']);
    expect(labels(page(2, 3))).toEqual(['Previous', 'I accept', 'Cancel sign-up']);
    expect(labels(page(0, 1))).toEqual(['I accept', 'Cancel sign-up']);
  });

  it('stays inside Discord\'s limits', () => {
    const message = renderSignupScreen(page(2, 3)) as unknown as Message;
    expect(message.embeds).toHaveLength(1);
    const embed = message.embeds[0]!;
    expect(embed.description.length).toBeLessThanOrEqual(4096);
    expect(embed.title.length + embed.description.length + embed.footer.text.length).toBeLessThan(6000);
    for (const button of buttons(message as unknown as Record<string, unknown>)) {
      expect(button.custom_id.length).toBeLessThanOrEqual(100);
      expect(button.label.length).toBeLessThanOrEqual(80);
    }
    expect(buttons(message as unknown as Record<string, unknown>)).toContainEqual(
      expect.objectContaining({ label: 'I accept', custom_id: 'signup:accept:code_of_conduct:0123456789abcdef' })
    );
  });

  it('every screen is ephemeral and mentions nobody', () => {
    const screens: SignupScreen[] = [
      { kind: 'choice', step: 'age', prompt: 'Age', choices: [{ value: 'yes', label: 'I confirm' }] },
      page(0, 1),
      { kind: 'code_sent' },
      { kind: 'done', approved: true, linked: true },
      { kind: 'cancelled', codeSent: false },
    ];
    for (const screen of screens) {
      expect(renderSignupScreen(screen)).toMatchObject({ flags: 64, allowed_mentions: { parse: [] } });
    }
  });

  it('cancel does not claim nothing was saved once a code went out', () => {
    expect(renderSignupScreen({ kind: 'cancelled', codeSent: false }).content).toBe('Sign-up cancelled, nothing was saved.');
    expect(renderSignupScreen({ kind: 'cancelled', codeSent: true }).content).not.toContain('nothing was saved');
  });

  it('a timed-out draft says to run /signup again', async () => {
    signupStep.mockResolvedValue({ ok: false, refusal: 'timed_out' });
    const message = await finish(handleSignupInteraction('signup:age:yes', undefined, CONTEXT));
    expect(message.content).toBe('Sign-up timed out, run /signup again.');
    expect(message.flags).toBe(64);
  });
});
