import { FeatureOffBanner } from '@/components/feature-off-banner';

export default function TournamentsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <FeatureOffBanner feature="tournaments" />
      {children}
    </>
  );
}
