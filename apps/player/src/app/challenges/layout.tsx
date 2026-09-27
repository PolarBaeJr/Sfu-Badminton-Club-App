import { FeatureGate } from '@/lib/feature-gate';

export default function ChallengesLayout({ children }: { children: React.ReactNode }) {
  return <FeatureGate feature="challenges">{children}</FeatureGate>;
}
