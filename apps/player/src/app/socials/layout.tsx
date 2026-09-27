import { FeatureGate } from '@/lib/feature-gate';

export default function SocialsLayout({ children }: { children: React.ReactNode }) {
  return <FeatureGate feature="socials">{children}</FeatureGate>;
}
