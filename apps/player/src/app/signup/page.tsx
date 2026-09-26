import { getFeatureFlags } from '@/lib/feature-gate';
import { SignupForm } from './signup-form';

// A server wrapper, for the same reason as /login.
export default async function SignupPage() {
  const flags = await getFeatureFlags();
  return <SignupForm guestWaiversOn={flags.guest_waivers} />;
}
