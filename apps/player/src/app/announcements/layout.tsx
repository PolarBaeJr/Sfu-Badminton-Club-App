import { FeatureGate } from '@/lib/feature-gate';

export default function AnnouncementsLayout({ children }: { children: React.ReactNode }) {
  return <FeatureGate feature="announcements">{children}</FeatureGate>;
}
