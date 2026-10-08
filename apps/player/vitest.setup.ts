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
// The repo has since moved to Node 24, which HAS the global, so the guard below
// is false and this block no-ops. It is kept, not deleted: it costs nothing when
// the global exists, and it is the only thing standing between a contributor on
// an older Node and the same baffling error. The real fix for the drift that
// caused this is the pin — .nvmrc + engines.node + engine-strict — not the stub.
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
