export const dynamic = 'force-dynamic';
import Link from 'next/link';
import { PageHeader } from '@badminton/ui';
import { requireCapability } from '@/lib/supabase-server';
import { ClubEventForm } from '../event-form';

export default async function NewClubEventPage() {
  await requireCapability('events.manage.create.write');
  return (
    <div>
      <PageHeader
        eyebrow="EVENTS"
        title="New club event"
        sub={<Link href="/events" className="hover:underline">Back to club events</Link>}
      />
      <ClubEventForm />
    </div>
  );
}
