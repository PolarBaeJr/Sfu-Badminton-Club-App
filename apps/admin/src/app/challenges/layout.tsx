import { FeatureOffBanner } from '@/components/feature-off-banner';

export default function ChallengesLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <FeatureOffBanner feature="challenges" />
      {children}
    </>
  );
}
