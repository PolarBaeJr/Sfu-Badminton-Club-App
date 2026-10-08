import { describe, expect, it } from 'vitest';
import {
  TOUR_RESUME_MAX_AGE_MS,
  parseTourProgress,
  serializeTourProgress,
  type TourProgress,
} from '@badminton/ui/src/tour';
import { tourProgressStorageKey } from '@badminton/shared/src/utils/tours';

// Resuming a tour after a reload: what a saved place must be to be trusted.

const NOW = Date.parse('2026-09-27T12:00:00Z');
const STEP_IDS = ['welcome', 'calendar', 'challenges', 'settings'] as const;

const saved = (over: Partial<TourProgress> = {}): string =>
  serializeTourProgress({
    v: 1,
    key: 'member_v2',
    stepId: 'challenges',
    index: 2,
    startPath: '/feed',
    replay: false,
    savedAt: NOW - 60_000,
    ...over,
  });

const read = (raw: string | null, stepIds: readonly string[] = STEP_IDS) =>
  parseTourProgress(raw, { tourKey: 'member_v2', stepIds, now: NOW });

describe('parseTourProgress', () => {
  it('round-trips a fresh place', () => {
    expect(read(saved())).toEqual({ index: 2, startPath: '/feed', replay: false });
    expect(read(saved({ replay: true }))?.replay).toBe(true);
  });

  it('finds the step by id when the steps shifted', () => {
    expect(read(saved(), ['welcome', 'challenges', 'settings'])).toEqual({
      index: 1,
      startPath: '/feed',
      replay: false,
    });
  });

  it('refuses a step this person no longer gets', () => {
    expect(read(saved(), ['welcome', 'settings'])).toBeNull();
  });

  it('refuses a place older than half an hour, or from the future', () => {
    expect(read(saved({ savedAt: NOW - TOUR_RESUME_MAX_AGE_MS - 1 }))).toBeNull();
    expect(read(saved({ savedAt: NOW - TOUR_RESUME_MAX_AGE_MS }))).not.toBeNull();
    expect(read(saved({ savedAt: NOW + 1000 }))).toBeNull();
  });

  it('refuses another tour, including the v1 key', () => {
    expect(read(saved({ key: 'exec_v2' }))).toBeNull();
    expect(read(saved({ key: 'member_v1' }))).toBeNull();
  });

  it('refuses a start path that is not a plain app path', () => {
    for (const startPath of ['feed', '//evil.example.invalid', '/\\evil', 'https://evil.example.invalid']) {
      expect(read(saved({ startPath })), startPath).toBeNull();
    }
  });

  it('refuses anything unreadable', () => {
    expect(read(null)).toBeNull();
    expect(read('')).toBeNull();
    expect(read('not json')).toBeNull();
    expect(read('null')).toBeNull();
    expect(read(JSON.stringify({ ...JSON.parse(saved()), v: 2 }))).toBeNull();
    expect(read(JSON.stringify({ ...JSON.parse(saved()), replay: 'yes' }))).toBeNull();
  });
});

describe('tourProgressStorageKey', () => {
  it('is namespaced per tour', () => {
    expect(tourProgressStorageKey('member_v2')).toBe('club-ladder:tour-progress:member_v2');
    expect(tourProgressStorageKey('exec_v2')).not.toBe(tourProgressStorageKey('member_v2'));
  });
});
