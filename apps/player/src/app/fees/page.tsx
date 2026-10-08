import { redirect } from 'next/navigation';

// A member's statement lives on /membership now, with the way to pay it. Kept
// as a redirect so old links, bookmarks and notifications still land.
export default function FeesPage() {
  redirect('/membership');
}
