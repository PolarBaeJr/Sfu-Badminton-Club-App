// Recovering from a failed QR scan, for both scanners in the app.
//
// WHY THIS IS A MODULE AND NOT THREE useStates IN A COMPONENT. QrScanner latches
// itself off the moment it decodes anything (`stopped.current = true`) and its
// effect only re-runs when `onResult` changes identity — which it never does,
// because every caller wraps it in a stable useCallback. Its `paused` prop
// cannot help either: that effect sets `stopped.current = true` and has no
// branch that clears it.
//
// So there is exactly ONE way to scan a second time: unmount QrScanner and
// mount a new one. In React that means changing its `key`. The tournament
// scanner shipped `setScanning(true)` on failure, on a `scanning` that was
// already true — a state write with no state change, therefore no remount,
// therefore a dead camera until the member reloaded the page. The bug is
// invisible at the call site and obvious here, which is the point of moving it.
//
// The rules encoded below, both load-bearing:
//
//   restarting  MUST change `attempt`. That is the remount, and it is the only
//               one. Anything that "retries" without moving this number is the
//               original bug wearing a different name.
//
//   failing     MUST NOT change `attempt`. The code that just failed is still
//               the code in front of the lens, so an automatic remount would
//               decode it, fail, and remount again about once a second for
//               ever. When the failure came from the server that loop is an
//               unthrottled stream of server-action calls: the rate limit
//               covering check-in lives at the EDGE on the /checkin path, and
//               neither in-app scanner ever touches it. A failure stops the
//               camera and waits for a deliberate tap.

export interface ScanRetryState {
  /** The `key` on QrScanner. A new value is a new camera. */
  attempt: number;
  /** Torn down after a failure, waiting for a tap on "Scan again". */
  stopped: boolean;
  /** What went wrong, shown above the scanner. */
  error: string | null;
}

export const IDLE_SCAN: ScanRetryState = { attempt: 0, stopped: false, error: null };

/**
 * A scan failed — unreadable, the wrong kind of code, or refused by the server.
 *
 * Stops the camera and says why. `attempt` is deliberately untouched: see the
 * loop described at the top of this file.
 */
export function failedScan(state: ScanRetryState, message: string): ScanRetryState {
  return { ...state, stopped: true, error: message };
}

/**
 * The member tapped "Scan again" (or opened the scanner afresh).
 *
 * The increment IS the fix. Nothing else in the app can restart a latched-off
 * QrScanner.
 */
export function restartedScan(state: ScanRetryState): ScanRetryState {
  return { attempt: state.attempt + 1, stopped: false, error: null };
}

/** Clears the message without touching the camera — used at the start of a
 *  submit, so the previous failure does not sit over a request in flight. */
export function clearedScanError(state: ScanRetryState): ScanRetryState {
  return { ...state, error: null };
}
