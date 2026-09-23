import { FeatureOffBanner } from '@/components/feature-off-banner';

export default function SessionsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <FeatureOffBanner feature="sessions" />
      {children}
    </>
  );
}
