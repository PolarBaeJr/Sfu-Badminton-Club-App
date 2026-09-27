import { redirect } from 'next/navigation';
import { isUuid } from '@badminton/shared';

// THE SCHEDULE LIVES ON /feed NOW, and this route stays only to send people
// there. It cannot simply be deleted:
//  - calendar subscriptions already on members' phones carry
//    `URL:.../sessions?s=<id>` until their next refresh, and delivered push
//    notifications and old links point here too;
//  - feature-registry.test.ts (and CAPABILITY_GATES) require the sessions
//    feature to own a gated route, which is sessions/layout.tsx. With the
//    switch off, that layout redirects before this page runs.
// The card components beside this file are imported by the feed from here.
//
// `?s=` is carried across only when it is a real uuid, so nothing arbitrary
// rides along into the URL.
export default async function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<{ s?: string | string[] }>;
}) {
  const { s } = await searchParams;
  redirect(typeof s === 'string' && isUuid(s) ? `/feed?s=${s}` : '/feed');
}
