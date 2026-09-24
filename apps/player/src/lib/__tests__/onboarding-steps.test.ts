import { describe, it, expect } from 'vitest';
import { activeOnboardingStep, onboardingSteps } from '../onboarding-steps';

describe('onboardingSteps', () => {
  it('is five steps when the club has tiers', () => {
    expect(onboardingSteps({ tiersAvailable: true })).toEqual([
      'about', 'level', 'agreements', 'signin', 'review',
    ]);
  });

  it('keeps the level step while the tiers are loading', () => {
    expect(onboardingSteps({ tiersAvailable: null })).toContain('level');
  });

  it('drops the level step when the tiers could not be loaded', () => {
    expect(onboardingSteps({ tiersAvailable: false })).toEqual([
      'about', 'agreements', 'signin', 'review',
    ]);
  });
});

describe('activeOnboardingStep', () => {
  it('keeps a step that is still in the list', () => {
    expect(activeOnboardingStep('signin', onboardingSteps({ tiersAvailable: true }))).toBe('signin');
  });

  it('moves forward, never back, off a step that dropped out', () => {
    expect(activeOnboardingStep('level', onboardingSteps({ tiersAvailable: false }))).toBe('agreements');
  });
});
