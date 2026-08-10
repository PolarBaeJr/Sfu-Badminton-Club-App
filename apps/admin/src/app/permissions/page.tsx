export const dynamic = 'force-dynamic';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import {
  accessLevelFor,
  effectiveCapabilities,
  permissionsOf,
  type AccessLevel,
} from '@/lib/permissions';
import { EmptyState, PageHeader } from '@badminton/ui';
import { PermissionEditor, type PersonRow } from './permission-editor';

// WHO HOLDS CONSOLE ACCESS, AND WHAT THEY CAN DO WITH IT.
//
// Gated HERE as well as in permissions.ts: middleware decides who may open the
// route, but this page lists the club's privilege assignments and hands out a
// form that writes them, so it must not depend on middleware having been
// reached.
//
// EVERYONE WITH A LEVEL IS LISTED, and execs and trainers alike can be composed
// here. A trainer used to be read-only on the grounds that their whole level is
// the roster and varsity notes, with nothing in it to narrow — but the club has
// a varsity trainer who also runs sessions, and the alternative was making them
// an exec and handing over the whole exec baseline. The resolver never cared
// about levels, so composing one takes the same path composing an exec does.
//
// ADMINS STAY READ-ONLY, and for a different reason that has not changed: an
// admin is a superuser by LEVEL, permits() short-circuits before any stored set
// is consulted, so a role on an admin's row would look like a narrowing and
// would not be one.
//
// Listing an admin anyway is the point: this page answers "who can get into the
// console", and a page that silently omitted the level it cannot edit would
// answer a narrower question than its title claims.
export default async function PermissionsPage() {
  const viewer = await requireCapability('permissions.page');
  const viewerSet = effectiveCapabilities(accessLevelFor(viewer), permissionsOf(viewer));

  // All three permission columns, together. Selecting permission_role without
  // both delta columns makes permissionsOf() throw — deliberately, because the
  // alternative is a narrowed SELECT quietly turning a stored revoke into
  // nothing.
  const { data: people } = await createAdminClient()
    .from('players')
    .select(
      'id, full_name, email, exec_title, role, is_exec, is_trainer, permission_role, permission_grants, permission_revokes',
    )
    .or('role.eq.admin,is_exec.eq.true,is_trainer.eq.true')
    .order('full_name');

  // Built through accessLevelFor rather than from the flags directly, so this
  // page cannot develop its own idea of what makes somebody an exec. A row that
  // resolves to no level is dropped: the filter above should make that
  // impossible, and if it ever stops being impossible, listing somebody with no
  // level on the permissions page is the wrong way to find out.
  const rows: PersonRow[] = (people ?? [])
    .map((person) => ({ person, level: accessLevelFor(person) }))
    .filter((entry): entry is { person: typeof entry.person; level: AccessLevel } =>
      entry.level !== null,
    )
    .map(({ person, level }) => ({
      id: person.id as string,
      name: (person.full_name as string | null) ?? (person.email as string | null) ?? 'Unnamed',
      title: (person.exec_title as string | null) ?? null,
      level,
      role: (person.permission_role as string | null) ?? null,
      grants: (person.permission_grants as string[] | null) ?? [],
      revokes: (person.permission_revokes as string[] | null) ?? [],
    }));

  return (
    <div>
      <PageHeader
        title="Permissions"
        sub="Who can open this console, and what each of them may do"
        watermark="P"
      />

      {rows.length === 0 ? (
        <EmptyState
          title="Nobody has console access"
          description="No admin, executive or varsity trainer is on the roster."
        />
      ) : (
        <PermissionEditor
          people={rows}
          viewerId={viewer.id as string}
          // The actor's own set, resolved on the SERVER through the same path
          // the gates use, and sent as a plain array because a Set does not
          // cross this boundary. It only decides what the editor DISABLES:
          // setPlayerPermissions resolves the same set again from the actor's
          // own row and refuses anything outside it, so this is a courtesy, not
          // the boundary.
          viewerCapabilities={[...viewerSet]}
        />
      )}
    </div>
  );
}
