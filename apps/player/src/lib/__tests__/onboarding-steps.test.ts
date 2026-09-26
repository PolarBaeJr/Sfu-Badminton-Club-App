import { describe, it, expect } from 'vitest';
import { activeOnboardingStep, onboardingSteps, ONBOARDING_STEP_COPY, ONBOARDING_STEP_ORDER } from '../onboarding-steps';

describe('onboardingSteps', () => {
  it('is four steps when the club has tiers', () => {
    expect(onboardingSteps({ tiersAvailable: true })).toEqual([
      'about', 'level', 'agreements', 'signin',
    ]);
  });

  it('keeps the level step while the tiers are loading', () => {
    expect(onboardingSteps({ tiersAvailable: null })).toContain('level');
  });

  it('drops the level step when the tiers could not be loaded', () => {
    expect(onboardingSteps({ tiersAvailable: false })).toEqual([
      'about', 'agreements', 'signin',
    ]);
  });

  it('has a heading and subheading for every step', () => {
    for (const id of ONBOARDING_STEP_ORDER) {
      expect(ONBOARDING_STEP_COPY[id].heading, id).not.toBe('');
      expect(ONBOARDING_STEP_COPY[id].subheading, id).not.toBe('');
    }
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
