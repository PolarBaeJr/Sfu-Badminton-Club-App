export const dynamic = 'force-dynamic';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  formatClubEventCost,
  formatClubEventTime,
  isUuid,
  utcToClubWallClock,
} from '@badminton/shared';
import { Badge, Card, PageHeader } from '@badminton/ui';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import { accessLevelFor, permissionsOf, permits, type Capability } from '@/lib/permissions';
import { ClubEventControls, ClubEventForm, type ClubEventFormValues } from '../event-form';
import { ClubEventSignupsTable, type ClubEventSignupRow } from '../signups-table';

type EventRow = {
  id: string;
  title: string;
  kind: string;
  description: string | null;
  location: string | null;
  starts_at: string;
  ends_at: string | null;
  capacity: number | null;
  cost_cents: number | null;
  signup_opens_at: string | null;
  signup_closes_at: string | null;
  status: string;
  cancelled_at: string | null;
  cancelled_reason: string | null;
};

type SignupRow = {
  player_id: string;
  created_at: string;
  players: { full_name: string | null } | { full_name: string | null }[] | null;
};

export default async function ClubEventPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const viewer = await requireCapability('events.page');
  if (!isUuid(id)) notFound();
  const level = accessLevelFor(viewer);
  const permissions = permissionsOf(accessLevelFor(viewer), viewer);
  const may = (capability: Capability) => permits(level, permissions, capability);
  const canEdit = may('events.manage.update.write');
  const canCancel = may('events.manage.cancel.write');
  const canDelete = may('events.manage.delete.write');
  // A FETCH gate, not a render one: without the read the names never leave the
  // database, rather than being hidden in markup that still carries them.
  const canSeeSignups = may('events.signups.read');
  const canRemoveSignup = may('events.signups.remove.write');

  const adminClient = createAdminClient();
  const { data: eventData } = await adminClient
    .from('club_events')
    .select(
      'id, title, kind, description, location, starts_at, ends_at, capacity, cost_cents, signup_opens_at, signup_closes_at, status, cancelled_at, cancelled_reason',
    )
    .eq('id', id)
    .maybeSingle();
  const event = eventData as EventRow | null;
  if (!event) notFound();

  const { count: takenCount } = await adminClient
    .from('club_event_signups')
    .select('player_id', { count: 'exact', head: true })
    .eq('event_id', id);
  const taken = takenCount ?? 0;

  // The service-role client, so the players embed is not narrowed by the
  // column grants members are held to.
  const { data: signupData } = canSeeSignups
    ? await adminClient
        .from('club_event_signups')
        .select('player_id, created_at, players(full_name)')
        .eq('event_id', id)
        .order('created_at', { ascending: true })
    : { data: null };
  const signups: ClubEventSignupRow[] = ((signupData ?? []) as SignupRow[]).map((row) => {
    const player = Array.isArray(row.players) ? row.players[0] : row.players;
    return { player_id: row.player_id, created_at: row.created_at, name: player?.full_name ?? 'A member' };
  });

  const cancelled = event.status === 'cancelled';
  const cost = formatClubEventCost(event.cost_cents);
  const initial: ClubEventFormValues = {
    title: event.title,
    kind: event.kind,
    description: event.description ?? '',
    location: event.location ?? '',
    starts_at: utcToClubWallClock(event.starts_at),
    ends_at: event.ends_at ? utcToClubWallClock(event.ends_at) : '',
    signup_opens_at: event.signup_opens_at ? utcToClubWallClock(event.signup_opens_at) : '',
    signup_closes_at: event.signup_closes_at ? utcToClubWallClock(event.signup_closes_at) : '',
    capacity: event.capacity === null ? '' : String(event.capacity),
    cost_dollars: event.cost_cents === null ? '' : (event.cost_cents / 100).toFixed(2),
    publish: event.status === 'published',
  };

  return (
    <div>
      <PageHeader
        eyebrow="EVENTS"
        title={event.title}
        sub={<Link href="/events" className="hover:underline">Back to club events</Link>}
      />
      <div className="flex flex-col gap-5">
        <Card>
          <div className="flex flex-col gap-2 text-sm text-[var(--ink-2)]">
            <div className="flex flex-wrap items-center gap-2">
              {cancelled ? (
                <Badge variant="danger">Cancelled</Badge>
              ) : event.status === 'published' ? (
                <Badge variant="success">Published</Badge>
              ) : (
                <Badge variant="neutral">Draft</Badge>
              )}
              {event.capacity !== null && taken > event.capacity && (
                <Badge variant="warning">Over capacity</Badge>
              )}
            </div>
            <div>
              {formatClubEventTime(event.starts_at)}
              {event.ends_at ? ` to ${formatClubEventTime(event.ends_at)}` : ''}
            </div>
            <div>
              {event.capacity === null ? `${taken} signed up` : `${taken} of ${event.capacity} places taken`}
            </div>
            {cost && <div>Cost: {cost}</div>}
            {cancelled && event.cancelled_reason && <div>Reason: {event.cancelled_reason}</div>}
          </div>
        </Card>

        {canEdit && !cancelled && <ClubEventForm eventId={event.id} initial={initial} />}

        <ClubEventControls
          eventId={event.id}
          canCancel={canCancel && !cancelled}
          canDelete={canDelete && taken === 0}
        />

        {canSeeSignups && (
          <Card className="p-0">
            <h2
              className="px-5 pb-4 pt-5 text-[13px] font-bold uppercase tracking-[0.14em] text-[var(--ink)]"
              style={{ fontFamily: 'var(--display)' }}
            >
              Signed up
            </h2>
            <ClubEventSignupsTable eventId={event.id} rows={signups} canRemove={canRemoveSignup} />
          </Card>
        )}
      </div>
    </div>
  );
}
