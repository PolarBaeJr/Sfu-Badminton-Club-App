import { FeatureGate } from '@/lib/feature-gate';

export default function MembershipLayout({ children }: { children: React.ReactNode }) {
  return <FeatureGate feature="membership">{children}</FeatureGate>;
}
