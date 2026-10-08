import { FeatureGate } from '@/lib/feature-gate';

export default function MyStatsLayout({ children }: { children: React.ReactNode }) {
  return <FeatureGate feature="my_stats">{children}</FeatureGate>;
}
