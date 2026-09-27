import { getFeatureFlags } from '@/lib/feature-gate';
import { LoginForm } from './login-form';

// A server wrapper so the form knows whether to offer the guest waiver: the
// switches are read with the service role, which a client component cannot.
export default async function LoginPage() {
  const flags = await getFeatureFlags();
  return <LoginForm guestWaiversOn={flags.guest_waivers} />;
}
