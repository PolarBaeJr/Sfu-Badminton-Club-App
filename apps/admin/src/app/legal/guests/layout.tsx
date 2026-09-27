import { FeatureOffBanner } from '@/components/feature-off-banner';

export default function GuestWaiversLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <FeatureOffBanner feature="guest_waivers" />
      {children}
    </>
  );
}
