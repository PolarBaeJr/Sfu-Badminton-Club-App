import { FeatureGate } from '@/lib/feature-gate';

export default function CheckinLayout({ children }: { children: React.ReactNode }) {
  return <FeatureGate feature="sessions">{children}</FeatureGate>;
}
