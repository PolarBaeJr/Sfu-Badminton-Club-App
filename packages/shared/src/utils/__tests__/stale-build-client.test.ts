import { describe, it, expect, beforeEach, vi } from 'vitest';

// Each test gets a module with a fresh one-way flag. The flag is deliberately
// un-resettable in production code — once the build has moved it has moved —
// so resetting the module registry is the honest way to test it.
async function freshModule() {
  vi.resetModules();
  return import('../stale-build-client');
}

// The exact request the App Router builds for a server action. Copied from
// next/dist/client/components/router-reducer/reducers/server-action-reducer.js:
// a PLAIN OBJECT with 'Next-Action' in mixed case, not a Headers instance.
const ACTION_INIT = {
  method: 'POST',
  headers: {
    Accept: 'text/x-component',
    'Next-Action': '7f9a2c1e4b',
    'Next-Router-State-Tree': '%5B%22%22%2C%7B%7D%5D',
  },
  body: '[]',
};

function fakeResponse(status: number, headers: Record<string, string> = {}) {
  return { status, headers: new Headers(headers), marker: Symbol('response') };
}

/** A host object standing in for `window`/`globalThis`. */
function hostReturning(response: unknown) {
  const fetch = vi.fn(async () => response);
  return { host: { fetch } as any, fetch };
}

describe('installStaleBuildDetector — installation', () => {
  it('wraps fetch exactly once, however many times it is called', async () => {
    const mod = await freshModule();
    const { host, fetch } = hostReturning(fakeResponse(200));
    const pristine = host.fetch;

    mod.installStaleBuildDetector(host);
    const wrapped = host.fetch;
    expect(wrapped).not.toBe(pristine);

    mod.installStaleBuildDetector(host);
    mod.installStaleBuildDetector(host);
    expect(host.fetch).toBe(wrapped);

    await host.fetch('/x');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('is a no-op on a host with no fetch, and does not throw', async () => {
    const mod = await freshModule();
    const host = {} as any;
    expect(() => mod.installStaleBuildDetector(host)).not.toThrow();
    expect(host.fetch).toBeUndefined();
  });

  it('leaves ordinary traffic completely alone', async () => {
    const mod = await freshModule();
    const response = fakeResponse(404);
    const { host, fetch } = hostReturning(response);
    const original = host.fetch;
    mod.installStaleBuildDetector(host);

    // A 404 that was NOT a server action call — a missing avatar, say.
    const returned = host.fetch('/avatars/nobody.png');
    // Same promise object, not a .then() link: nothing was added to the path.
    expect(returned).toBe(original.mock.results[0]!.value);
    await expect(returned).resolves.toBe(response);
    expect(mod.isStaleBuild()).toBe(false);
    expect(fetch).toHaveBeenCalledWith('/avatars/nobody.png', undefined);
  });
});

describe('installStaleBuildDetector — raises the flag', () => {
  it("on Next's x-nextjs-action-not-found header", async () => {
    const mod = await freshModule();
    const response = fakeResponse(404, { 'x-nextjs-action-not-found': '1', 'content-type': 'text/plain' });
    const { host } = hostReturning(response);
    mod.installStaleBuildDetector(host);

    expect(mod.isStaleBuild()).toBe(false);
    await expect(host.fetch('/players', ACTION_INIT)).resolves.toBe(response);
    expect(mod.isStaleBuild()).toBe(true);
  });

  it('on a bare 404 to an action call, in case something in front of us ate the header', async () => {
    const mod = await freshModule();
    const { host } = hostReturning(fakeResponse(404, { 'content-type': 'text/html' }));
    mod.installStaleBuildDetector(host);

    await host.fetch('/players', ACTION_INIT);
    expect(mod.isStaleBuild()).toBe(true);
  });

  it('when the action id rides on a Request instead of an init object', async () => {
    const mod = await freshModule();
    const { host } = hostReturning(fakeResponse(404, { 'x-nextjs-action-not-found': '1' }));
    mod.installStaleBuildDetector(host);

    await host.fetch({ url: '/players', headers: new Headers({ 'Next-Action': 'abc' }) });
    expect(mod.isStaleBuild()).toBe(true);
  });

  it('notifies subscribers once, and only on the transition', async () => {
    const mod = await freshModule();
    const { host } = hostReturning(fakeResponse(404, { 'x-nextjs-action-not-found': '1' }));
    mod.installStaleBuildDetector(host);

    const seen = vi.fn();
    const unsubscribe = mod.subscribeToStaleBuild(seen);

    await host.fetch('/players', ACTION_INIT);
    await host.fetch('/players', ACTION_INIT);
    await host.fetch('/players', ACTION_INIT);
    expect(seen).toHaveBeenCalledTimes(1);

    unsubscribe();
    expect(mod.isStaleBuild()).toBe(true);
  });

  it('survives a subscriber that throws', async () => {
    const mod = await freshModule();
    const { host } = hostReturning(fakeResponse(404, { 'x-nextjs-action-not-found': '1' }));
    mod.installStaleBuildDetector(host);

    const good = vi.fn();
    mod.subscribeToStaleBuild(() => {
      throw new Error('boom');
    });
    mod.subscribeToStaleBuild(good);

    await expect(host.fetch('/players', ACTION_INIT)).resolves.toBeTruthy();
    expect(good).toHaveBeenCalledTimes(1);
    expect(mod.isStaleBuild()).toBe(true);
  });
});

// A false positive here tells a member the app was updated and their change was
// lost, when the real problem was something else entirely — worse than the
// dead end we are fixing. These are the cases that must stay quiet.
describe('installStaleBuildDetector — does NOT raise the flag', () => {
  const quiet: Array<[string, ReturnType<typeof fakeResponse>]> = [
    ['a server action that simply succeeded', fakeResponse(200, { 'content-type': 'text/x-component' })],
    ['a validation failure raised inside our own handler', fakeResponse(200, { 'content-type': 'text/x-component' })],
    ['a rate-limited action', fakeResponse(429)],
    ['an unauthenticated action', fakeResponse(401)],
    ['a forbidden action', fakeResponse(403)],
    ['a redirect to login', fakeResponse(307)],
    ['the app being down mid-roll (502)', fakeResponse(502, { 'content-type': 'text/html' })],
    ['a gateway timeout (504)', fakeResponse(504)],
    ['a crash inside the action (500)', fakeResponse(500)],
  ];

  for (const [name, response] of quiet) {
    it(`stays quiet for ${name}`, async () => {
      const mod = await freshModule();
      const { host } = hostReturning(response);
      mod.installStaleBuildDetector(host);

      await host.fetch('/players', ACTION_INIT);
      expect(mod.isStaleBuild()).toBe(false);
    });
  }

  it('stays quiet when the fetch rejects outright', async () => {
    const mod = await freshModule();
    const failure = new TypeError('Failed to fetch');
    const host = { fetch: vi.fn(async () => { throw failure; }) } as any;
    mod.installStaleBuildDetector(host);

    // The rejection must reach the caller unchanged — the App Router's own
    // error handling depends on it.
    await expect(host.fetch('/players', ACTION_INIT)).rejects.toBe(failure);
    expect(mod.isStaleBuild()).toBe(false);
  });

  it('stays quiet for a non-action POST that happens to 404', async () => {
    const mod = await freshModule();
    const { host } = hostReturning(fakeResponse(404));
    mod.installStaleBuildDetector(host);

    await host.fetch('/api/passkey/login/verify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    });
    expect(mod.isStaleBuild()).toBe(false);
  });
});

describe('the flag itself', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  it('starts down and is one-way', async () => {
    const mod = await freshModule();
    expect(mod.isStaleBuild()).toBe(false);
    mod.markStaleBuild();
    expect(mod.isStaleBuild()).toBe(true);
    mod.markStaleBuild();
    expect(mod.isStaleBuild()).toBe(true);
  });

  it('reports healthy for the server snapshot regardless', async () => {
    const mod = await freshModule();
    mod.markStaleBuild();
    // A server that is answering at all IS the current build; only the tab can
    // be stale, so SSR must never render the banner and cause a mismatch.
    expect(mod.getStaleBuildServerSnapshot()).toBe(false);
  });

  it('stops notifying after unsubscribe', async () => {
    const mod = await freshModule();
    const seen = vi.fn();
    mod.subscribeToStaleBuild(seen)();
    mod.markStaleBuild();
    expect(seen).not.toHaveBeenCalled();
  });
});
