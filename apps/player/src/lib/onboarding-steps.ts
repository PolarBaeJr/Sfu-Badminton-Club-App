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
//               impossible it says so and asks nothing.
//   review      a read-only summary with an Edit button per answer

export type OnboardingStepId = 'about' | 'level' | 'agreements' | 'signin' | 'review';

export const ONBOARDING_STEP_ORDER: readonly OnboardingStepId[] = [
  'about',
  'level',
  'agreements',
  'signin',
  'review',
];

export const ONBOARDING_STEP_TITLES: Record<OnboardingStepId, string> = {
  about: 'About you',
  level: 'Your level',
  agreements: 'Agreements',
  signin: 'How you sign in',
  review: 'Review',
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
