// WebSocket stub for Node runtimes that lack the global.
//
// Two tests in announcement-visibility.test.ts build a REAL supabase-js client
// so they can assert the query string a genuine PostgREST builder produces —
// that is the whole point of them, and mocking the builder would test the mock.
// supabase-js refuses to construct without a global WebSocket ("Node.js
// detected but native WebSocket not found"), which Node 20 does not have and
// Node 22+ does.
//
// So the suite passed on a developer machine and failed on CI, and only when it
// ran UNCACHED — a Turbo cache hit had been hiding it. That is the worst shape
// a test failure can have: environment-dependent AND intermittent.
//
// A stub rather than a real polyfill, deliberately. Nothing under test opens a
// socket; the constructor merely has to exist. Importing a polyfill would pull
// a runtime dependency into the test path to satisfy a check that never fires.
if (typeof globalThis.WebSocket === 'undefined') {
  class WebSocketStub {
    static readonly CONNECTING = 0;
    static readonly OPEN = 1;
    static readonly CLOSING = 2;
    static readonly CLOSED = 3;
    readonly readyState = WebSocketStub.CLOSED;
    close(): void {}
    send(): void {}
    addEventListener(): void {}
    removeEventListener(): void {}
  }
  (globalThis as { WebSocket?: unknown }).WebSocket = WebSocketStub;
}
