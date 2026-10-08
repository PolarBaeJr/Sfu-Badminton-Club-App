import { FeatureGate } from '@/lib/feature-gate';

export default function FeesLayout({ children }: { children: React.ReactNode }) {
  return <FeatureGate feature="fees">{children}</FeatureGate>;
}
