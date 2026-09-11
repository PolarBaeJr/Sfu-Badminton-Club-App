import { describe, it, expect, vi, beforeEach } from 'vitest';

// The guide message: one public post whose buttons open the three flows a new
// member needs, for people who do not know there are commands at all. What is
// pinned here:
//
//   1. THE BUTTONS ARE CLICKABLE. Style 1 and style 2 with a custom_id, never
//      style 5. A style 5 button renders happily and emits no interaction, so
//      the whole message would be inert and nothing would say so.
//   2. THE MESSAGE IS PUBLIC. A guide only the exec who posted it can see is
//      not a guide.
//   3. THE BUTTON PATH NEEDS NO COMMAND OPTIONS. A button carries none, and the
//      handlers behind it were written for a slash command that does.
//   4. THE COMPONENT PATH OWNS ITS OWN ERRORS. dispatch's catch covers slash
//      commands only, so a failed mint must resolve here rather than reject.
//
// LIMITATION, stated rather than worked around: index.ts creates and listens on
// its server at module scope and no test imports it, so the type 6 fallback for
// an unrecognised component cannot be asserted directly. Group C covers it the
// way the rest of the suite does: if each predicate claims only its own ids,
// every other custom_id reaches that fallback by construction.

const mintLinkToken = vi.fn();
const submitFeedback = vi.fn();

vi.mock('../api.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../api.js')>()),
  mintLinkToken,
  submitFeedback,
}));

const CTX = { discordUserId: '42', guildId: 'g1' };

type Button = { type: number; style: number; label: string; custom_id?: string; url?: string };
type Row = { type: number; components: Button[] };
type Reply = {
  type: number;
  data: {
    content?: string;
    flags?: number;
    embeds?: unknown[];
    components?: Row[];
    custom_id?: string;
  };
};

async function post(context: Record<string, unknown> = CTX) {
  const { dispatch } = await import('../commands.js');
  return (await dispatch('guidepost', [], context as never)) as unknown as Reply;
}

async function click(customId: string, context: Record<string, unknown> = CTX) {
  const { handleGuideButton } = await import('../commands.js');
  return (await handleGuideButton(customId, context as never)) as unknown as Reply;
}

/** The typed-in values, in the nested shape Discord actually sends. */
function filled(title: string, details: string) {
  return [
    { type: 1, components: [{ type: 4, custom_id: 'title', value: title }] },
    { type: 1, components: [{ type: 4, custom_id: 'details', value: details }] },
  ];
}

beforeEach(async () => {
  vi.resetAllMocks();
  submitFeedback.mockResolvedValue({ ok: true, linked: true });
  const { __clearPendingImages } = await import('../commands.js');
  __clearPendingImages();
});

describe('/guidepost', () => {
  it('renders the three buttons, with their labels and their ids', async () => {
    const buttons = (await post()).data.components!.flatMap((row) => row.components);

    expect(buttons.map((b) => b.custom_id)).toEqual([
      'guide:link',
      'guide:bug',
      'guide:feedback',
    ]);
    expect(buttons.map((b) => b.label)).toEqual([
      'Connect my account',
      'Report a bug',
      'Send feedback',
    ]);
  });

  it('is PUBLIC, because a guide nobody else can read is useless', async () => {
    // Omitted entirely rather than set to 0, like /rolepicker post.
    expect((await post()).data.flags).toBeUndefined();
  });

  it('gives every button a custom_id and never style 5', async () => {
    // THE TRAP. Style 5 is the LINK style: it requires a url, cannot carry a
    // custom_id, and produces no interaction when clicked. The nearest button
    // in the file is one, so copying is how this breaks.
    const buttons = (await post()).data.components!.flatMap((row) => row.components);

    for (const button of buttons) {
      expect(button.style).not.toBe(5);
      expect([1, 2]).toContain(button.style);
      expect(typeof button.custom_id).toBe('string');
      expect(button.url).toBeUndefined();
    }
  });

  it('fits in one action row, inside Discord own five-per-row limit', async () => {
    const rows = (await post()).data.components!;

    expect(rows).toHaveLength(1);
    expect(rows[0]?.components).toHaveLength(3);
    expect(rows[0]?.components.length).toBeLessThanOrEqual(5);
  });

  it('makes no app call, so there is nothing to defer', async () => {
    // It must never join DEFERRED_COMMANDS: a deferred acknowledgement fixes
    // the reply as ephemeral, which would hide the guide from the channel.
    await post();

    expect(mintLinkToken).not.toHaveBeenCalled();
    expect(submitFeedback).not.toHaveBeenCalled();
  });

  it('refuses in a DM, where a public channel message means nothing', async () => {
    const res = await post({ discordUserId: '42', guildId: null });

    expect(res.data.flags).toBe(64);
    expect(res.data.components).toBeUndefined();
  });
});

describe('the command definition', () => {
  it('is hidden from the picker until a server admin grants it', async () => {
    const { COMMAND_DEFINITIONS } = await import('../commands.js');
    const guide = COMMAND_DEFINITIONS.find((c) => c.name === 'guidepost') as {
      default_member_permissions?: string;
      dm_permission?: boolean;
      options: unknown[];
    };

    // '0' is Discord's "no default access", which fails closed: the command is
    // invisible to everyone who is not an administrator until @Executives is
    // allowed in Integrations.
    expect(guide.default_member_permissions).toBe('0');
    expect(guide.dm_permission).toBe(false);
  });
});

describe('the guide buttons', () => {
  it('mints against the clicker and replies ephemerally with a link button', async () => {
    mintLinkToken.mockResolvedValue({
      url: 'https://sfubadminton.com/link/' + 'a'.repeat(64),
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
    });

    const res = await click('guide:link');

    // The caller comes from the signed interaction envelope, never from the
    // custom_id, so a member cannot mint a token bound to somebody else.
    expect(mintLinkToken).toHaveBeenCalledWith('42', 'g1');
    expect(res.data.flags).toBe(64);
    // The credential rides in a BUTTON, not in body text Discord would unfurl.
    expect(res.data.components?.[0]?.components?.[0]?.url).toContain('/link/');
    expect(JSON.stringify(res.data.embeds)).not.toContain('/link/');
  });

  it('says so plainly when the clicker is already connected', async () => {
    // The public button makes this the common case, and it is not an error.
    const { AlreadyLinkedError } = await import('../api.js');
    mintLinkToken.mockRejectedValue(new AlreadyLinkedError('already linked'));

    const res = await click('guide:link');

    expect(res.data.content).toMatch(/already connected/i);
    expect(res.data.flags).toBe(64);
    // A button here would hand out a link that cannot be redeemed.
    expect(res.data.components).toBeUndefined();
  });

  it('resolves rather than rejects when the mint really fails', async () => {
    // THE ONE PLACE THIS DELIBERATELY DIFFERS FROM handleLink, which rethrows.
    // There is no dispatch catch on the component path, so the handler owns it.
    const { AppApiError } = await import('../api.js');
    mintLinkToken.mockRejectedValue(new AppApiError('POST /api/discord/link-tokens -> 503'));

    const res = await click('guide:link');

    expect(res.type).toBe(4);
    expect(res.data.flags).toBe(64);
    expect(res.data.content).toMatch(/club app/i);
  });

  it('opens the bug modal, with a title box and a body box', async () => {
    const res = await click('guide:bug');

    // 9 is MODAL, which Discord accepts in answer to a button click.
    expect(res.type).toBe(9);
    expect(res.data.custom_id).toMatch(/^report:bug:/);
    const rows = res.data.components as unknown as Row[];
    expect(rows[0]?.components[0]?.custom_id).toBe('title');
    expect(rows[0]?.components[0]?.style).toBe(1);
    expect(rows[1]?.components[0]?.custom_id).toBe('details');
    expect(rows[1]?.components[0]?.style).toBe(2);
  });

  it('opens the feedback modal under the feedback kind', async () => {
    const res = await click('guide:feedback');

    expect(res.type).toBe(9);
    expect(res.data.custom_id).toMatch(/^report:feedback:/);
  });

  it('files a report end to end with no command options at all', async () => {
    // THE PROPERTY THAT MAKES THE BUTTON PATH WORK. A button carries no
    // options, so openReportModal is called with `undefined` where a slash
    // command passes a list: option() returns undefined, the attachment branch
    // is skipped, nothing is stashed, and the submit finds nothing to claim.
    const { handleReportModal } = await import('../commands.js');
    const modal = await click('guide:bug');

    const res = (await handleReportModal(
      modal.data.custom_id as string,
      filled('Ladder spins forever', 'It never loads'),
      CTX as never
    )) as unknown as Reply;

    expect(submitFeedback).toHaveBeenCalledWith({
      kind: 'bug',
      title: 'Ladder spins forever',
      body: 'It never loads',
      imageUrl: null,
      discordUserId: '42',
      guildId: 'g1',
    });
    // No picture was offered, so nothing was lost and nothing is apologised for.
    expect(res.data.content).not.toMatch(/screenshot/i);
  });

  it('gives every click its own nonce', async () => {
    // Shared nonces would let one report claim another's screenshot.
    const a = (await click('guide:bug')).data.custom_id;
    const b = (await click('guide:bug')).data.custom_id;

    expect(a).not.toBe(b);
  });

  it('tells the clicker when the button is from an older message', async () => {
    const res = await click('guide:nope');

    expect(res.data.flags).toBe(64);
    expect(res.data.content).toMatch(/older version/i);
    expect(mintLinkToken).not.toHaveBeenCalled();
  });
});

describe('isGuideButton', () => {
  it('claims only its own custom_ids', async () => {
    const { isGuideButton } = await import('../commands.js');

    expect(isGuideButton('guide:link')).toBe(true);
    expect(isGuideButton('selfrole:900')).toBe(false);
    expect(isGuideButton('something-else')).toBe(false);
    expect(isGuideButton(undefined)).toBe(false);
    expect(isGuideButton(null)).toBe(false);
  });

  it('does not overlap the picker predicate in either direction', async () => {
    // The two prefixes being disjoint is what makes the branch order in
    // index.ts a readability choice rather than a correctness one, and it is
    // what leaves every unknown id to the type 6 fallback.
    const { isGuideButton, isSelfRoleButton } = await import('../commands.js');

    expect(isSelfRoleButton('guide:link')).toBe(false);
    expect(isGuideButton('selfrole:900')).toBe(false);
  });
});

describe('componentsForButtonSet', () => {
  it('gives a console-queued message the SAME buttons /guidepost posts', async () => {
    // One definition, two callers. A second copy of the buttons for the outbox
    // is how a click on a console-posted message stops being answered.
    const { componentsForButtonSet, guideComponents } = await import('../commands.js');

    expect(componentsForButtonSet('guide')).toEqual(guideComponents());
  });

  it('answers an unknown or absent name with null rather than throwing', async () => {
    // THE COMPATIBILITY PROPERTY. A row written by a newer console and drained
    // by an older bot image loses its buttons and still posts its words; a throw
    // here would cost the club the whole message, three attempts over.
    // `undefined` is the skew the other way: a new image, an older relay route
    // that sends no buttonSet field at all.
    const { componentsForButtonSet } = await import('../commands.js');

    expect(componentsForButtonSet('rolepicker')).toBeNull();
    expect(componentsForButtonSet('')).toBeNull();
    expect(componentsForButtonSet(null)).toBeNull();
    expect(componentsForButtonSet(undefined)).toBeNull();
  });

  it('says what the console promises it says', async () => {
    // THE BOT'S HALF OF A TRIPWIRE WITH TWO HALVES. apps/bot has zero
    // production dependencies, so it cannot import
    // packages/shared/src/utils/discord-buttons.ts and the console keeps a
    // second copy of these labels for its preview. A tripwire on only one side
    // catches a change to that side and misses the other, which is how the two
    // Elo weight tables ended up disagreeing with nothing failing.
    const { componentsForButtonSet } = await import('../commands.js');
    const buttons = componentsForButtonSet('guide')!.flatMap((row) => row.components);

    expect(
      buttons.map((b) => b.label),
      'these labels are also DISCORD_BUTTON_SETS.guide.buttons in ' +
        'packages/shared/src/utils/discord-buttons.ts: change both or neither',
    ).toEqual(['Connect my account', 'Report a bug', 'Send feedback']);
  });
});
