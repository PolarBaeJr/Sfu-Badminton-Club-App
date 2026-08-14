import { describe, it, expect } from 'vitest';
import { IDLE_SCAN, clearedScanError, failedScan, restartedScan } from '../scan-retry';

// The defect these guard against shipped to production and reached members the
// day `Permissions-Policy: camera=()` was relaxed to `camera=(self)`: the
// tournament scanner's retry called setScanning(true) on a `scanning` that was
// already true. No state change, no remount, dead camera, reload the page.
//
// So the property under test is not "retry sets a flag" — it is "retry produces
// a DIFFERENT key from the one QrScanner is currently mounted under", because
// only a different key unmounts it.

describe('restartedScan — the remount', () => {
  it('changes the key, which is the only thing that restarts the camera', () => {
    const failed = failedScan(IDLE_SCAN, 'Invalid check-in code');
    const retried = restartedScan(failed);
    expect(retried.attempt).not.toBe(failed.attempt);
  });

  it('gives a fresh key every time, so a second failure can also be retried', () => {
    // A member at the door mis-scans repeatedly. Every tap must produce a
    // camera; a key that stopped moving after the first retry would strand
    // them on attempt three.
    const keys: number[] = [];
    let state = IDLE_SCAN;
    for (let i = 0; i < 5; i++) {
      state = failedScan(state, 'nope');
      state = restartedScan(state);
      keys.push(state.attempt);
    }
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('brings the scanner back and clears the message with it', () => {
    const retried = restartedScan(failedScan(IDLE_SCAN, 'Invalid check-in code'));
    expect(retried.stopped).toBe(false);
    expect(retried.error).toBeNull();
  });

  it('is not a no-op from idle either — opening the scanner mounts a new one', () => {
    // The dialog reuses this to OPEN the scanner, not only to retry. If the
    // last session ended in a decode, the component behind it is latched off,
    // so opening must remount just as retrying does.
    expect(restartedScan(IDLE_SCAN).attempt).not.toBe(IDLE_SCAN.attempt);
  });
});

describe('failedScan — the loop that must not happen', () => {
  it('does NOT move the key, so nothing remounts itself', () => {
    // The failing code is still in front of the lens. An automatic remount
    // would decode it, fail, and remount again roughly once a second — and a
    // server-side failure would make that an unthrottled stream of server
    // action calls.
    const failed = failedScan(IDLE_SCAN, 'Check-in opens at 6:00 PM');
    expect(failed.attempt).toBe(IDLE_SCAN.attempt);
  });

  it('stops the camera and reports why', () => {
    const failed = failedScan(IDLE_SCAN, 'Check-in opens at 6:00 PM');
    expect(failed.stopped).toBe(true);
    expect(failed.error).toBe('Check-in opens at 6:00 PM');
  });

  it('keeps the camera stopped across repeated failures', () => {
    const twice = failedScan(failedScan(IDLE_SCAN, 'first'), 'second');
    expect(twice.stopped).toBe(true);
    expect(twice.error).toBe('second');
    expect(twice.attempt).toBe(IDLE_SCAN.attempt);
  });
});

describe('clearedScanError', () => {
  it('drops the message without disturbing the camera', () => {
    const midSubmit = clearedScanError({ attempt: 3, stopped: false, error: 'stale' });
    expect(midSubmit).toEqual({ attempt: 3, stopped: false, error: null });
  });
});

describe('IDLE_SCAN', () => {
  it('starts live, with nothing to report', () => {
    expect(IDLE_SCAN).toEqual({ attempt: 0, stopped: false, error: null });
  });
});
