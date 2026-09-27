import { FeatureOffBanner } from '@/components/feature-off-banner';

export default function ClubEventsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <FeatureOffBanner feature="events" />
      {children}
    </>
  );
}
