import { FeatureOffBanner } from '@/components/feature-off-banner';

export default function AnnouncementsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <FeatureOffBanner feature="announcements" />
      {children}
    </>
  );
}
