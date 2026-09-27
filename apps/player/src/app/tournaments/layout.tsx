import { FeatureGate } from '@/lib/feature-gate';

export default function TournamentsLayout({ children }: { children: React.ReactNode }) {
  return <FeatureGate feature="tournaments">{children}</FeatureGate>;
}
