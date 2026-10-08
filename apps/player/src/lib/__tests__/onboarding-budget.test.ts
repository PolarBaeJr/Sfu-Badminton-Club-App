import { describe, it, expect } from 'vitest';
import { ALL_FEATURES_ENABLED } from '@badminton/shared/src/utils/features';
import { selectSteps, type TourContext } from '@badminton/ui/src/tour';
import { memberTourSteps } from '../tours/member-tour';
import { ONBOARDING_STEP_COPY, onboardingSteps } from '../onboarding-steps';

// THE OWNER'S REQUIREMENT: "the whole onboarding shouldn't take more than 3
// minutes". That is account setup and the member tour back to back, on a
// phone. Nothing here times a real member; these are the proxies that keep the
// flow from creeping back up: how many screens, and how much there is to read
// on each. A change that fails this has to cut something, not raise the limit.

const words = (s: string) => s.trim().split(/\s+/).filter(Boolean).length;

const base: Omit<TourContext, 'approved'> = {
  features: { ...ALL_FEATURES_ENABLED },
  featureAccess: [],
  held: new Set<string>(),
};

describe('the onboarding time budget', () => {
  for (const approved of [true, false]) {
    describe(`the member tour, ${approved ? 'approved' : 'pending'}`, () => {
      const ctx: TourContext = { ...base, approved };
      const steps = selectSteps(memberTourSteps(ctx), ctx);

      it('is at most six steps', () => {
        expect(steps.length).toBeLessThanOrEqual(6);
      });

      it('is at most 110 words in all', () => {
        expect(steps.reduce((n, s) => n + words(s.body), 0)).toBeLessThanOrEqual(110);
      });

      it('has no step over 25 words', () => {
        for (const step of steps) expect(words(step.body), step.id).toBeLessThanOrEqual(25);
      });
    });
  }

  describe('account setup', () => {
    it('is at most four steps', () => {
      expect(onboardingSteps({ tiersAvailable: true }).length).toBeLessThanOrEqual(4);
    });

    it('has no subheading over 20 words', () => {
      for (const [id, copy] of Object.entries(ONBOARDING_STEP_COPY)) {
        expect(words(copy.subheading), id).toBeLessThanOrEqual(20);
      }
    });
  });
});
