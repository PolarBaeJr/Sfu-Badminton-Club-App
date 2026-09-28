import { ForgotForm } from './forgot-form';

// Public through /login's prefix (see public-paths), so a signed-out member
// can reach it.
export default function ForgotPasswordPage() {
  return <ForgotForm />;
}
