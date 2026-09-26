// THE ONBOARDING STEPS, in order, for this member. A pure function so a test
// can read it: the page itself is a client component.
//
// One screen per question, and nothing new is asked: the same answers the old
// three-step form collected, split so each has room to explain itself.
//
//   about       name, display name, phone
//   level       the skill tier (00127). Only when the club's tiers loaded; kept
//               while they are still loading so the count does not jump, and
//               dropped when the read failed, because a question that cannot be
//               asked must never hold the door shut.
//   agreements  the four legal documents and their checkboxes
//   signin      the passkey question (00121). Always a step: when a passkey is
//               impossible it says so and asks nothing. It is the last step,
//               and its "Enter the club" button submits.
//
// Budget: setup plus the member tour must fit in 3 minutes on a phone
// (onboarding-budget.test.ts). Do not add a step without cutting one.

export type OnboardingStepId = 'about' | 'level' | 'agreements' | 'signin';

export const ONBOARDING_STEP_ORDER: readonly OnboardingStepId[] = [
  'about',
  'level',
  'agreements',
  'signin',
];

export const ONBOARDING_STEP_TITLES: Record<OnboardingStepId, string> = {
  about: 'About you',
  level: 'Your level',
  agreements: 'Agreements',
  signin: 'How you sign in',
};

export const ONBOARDING_STEP_COPY: Record<OnboardingStepId, { heading: string; subheading: string }> = {
  about: {
    heading: 'Set up your profile',
    subheading: 'This is how other players will see you. Display name and phone are optional.',
  },
  level: {
    heading: 'How do you play?',
    subheading: 'This sets where you start on the ladder. Your rating adjusts quickly, so pick the closest fit.',
  },
  agreements: {
    heading: 'Waiver & club policies',
    subheading: 'Read and accept the terms of use, privacy policy, liability waiver, and code of conduct to play.',
  },
  signin: {
    heading: 'How you sign in',
    subheading: 'Choose how you sign in from now on, then enter the club.',
  },
};

/** `tiersAvailable` is null while the tiers are loading. */
export function onboardingSteps({ tiersAvailable }: { tiersAvailable: boolean | null }): OnboardingStepId[] {
  return ONBOARDING_STEP_ORDER.filter((id) => id !== 'level' || tiersAvailable !== false);
}

/**
 * The step to show when the one asked for has dropped out of the list (the
 * level step, once the tiers fail to load): the next one after it in the
 * canonical order, never an earlier one.
 */
export function activeOnboardingStep(
  wanted: OnboardingStepId,
  steps: readonly OnboardingStepId[],
): OnboardingStepId {
  if (steps.includes(wanted)) return wanted;
  const from = ONBOARDING_STEP_ORDER.indexOf(wanted);
  return steps.find((id) => ONBOARDING_STEP_ORDER.indexOf(id) > from) ?? steps[steps.length - 1]!;
}
