export const dynamic = 'force-dynamic';
import { createAdminClient, requireCapability } from '@/lib/supabase-server';
import {
  accessLevelFor,
  effectiveCapabilities,
  isBuiltinPermissionRole,
  isCapability,
  isInGoodStanding,
  permissionsOf,
  type AccessLevel,
} from '@/lib/permissions';
import { isAdminActor } from '@/lib/player-field-access';
import { PageHeader } from '@badminton/ui';
import { PermissionEditor, type PersonRow } from './permission-editor';
import { BaselineManager, type BaselineRow } from './baseline-manager';

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
// ADMINS STAY READ-ONLY FOR THEIR CAPABILITIES, and for a different reason that
// has not changed: an admin is a superuser by LEVEL, permits() short-circuits
// before any stored set is consulted, so a role on an admin's row would look
// like a narrowing and would not be one. Their console ACCESS is still editable
// — that is a level, not a capability.
//
// AND NOW EVERY OTHER MEMBER TOO, because the page's own subtitle promises to
// answer "who can open this console" and it could only ever answer the second
// half. Giving somebody the console was a control on the /players Edit dialog,
// three tabs away from the screen that describes what having it means.
//
// TWO QUERIES, AND THE SHAPES ARE DELIBERATELY DIFFERENT. The people who hold a
// level are few and each of them needs the whole permission triple. The rest are
// a hundred rows on staging and none of them has anything to resolve — they have
// no level, so no gate is ever reached and no stored set is ever consulted — so
// they travel as a name, an email and whether they can sign in, which is
// everything the search box and the console-access control read. Fetching the
// full row for all of them would put four unread columns per member into the RSC
// payload to render a list that starts out hidden.
export default async function PermissionsPage() {
  const viewer = await requireCapability('permissions.page');
  const viewerSet = effectiveCapabilities(accessLevelFor(viewer), permissionsOf(viewer));
  const adminClient = createAdminClient();

  // All three permission columns, together. Selecting permission_role without
  // both delta columns makes permissionsOf() throw — deliberately, because the
  // alternative is a narrowed SELECT quietly turning a stored revoke into
  // nothing.
  //
  // The standing columns are here for what the page SAYS, not for what it
  // allows: accessLevelFor ignores standing, but isInGoodStanding does not, so a
  // banned or deactivated executive holds the level and still cannot get through
  // the front door. Offering to compose them without saying so would be a screen
  // describing access that nobody has.
  const { data: people } = await adminClient
    .from('players')
    .select(
      'id, full_name, email, exec_title, role, is_exec, is_trainer, is_banned, status, active_flag, permission_role, permission_grants, permission_revokes, permission_baseline_id',
    )
    .or('role.eq.admin,is_exec.eq.true,is_trainer.eq.true')
    .order('full_name');

  // Built through accessLevelFor rather than from the flags directly, so this
  // page cannot develop its own idea of what makes somebody an exec. A row that
  // resolves to no level is dropped: the filter above should make that
  // impossible, and if it ever stops being impossible, listing somebody with no
  // level among the console holders is the wrong way to find out.
  const holders: PersonRow[] = (people ?? [])
    .map((person) => ({ person, level: accessLevelFor(person) }))
    .filter((entry): entry is { person: typeof entry.person; level: AccessLevel } =>
      entry.level !== null,
    )
    .map(({ person, level }) => ({
      id: person.id as string,
      name: (person.full_name as string | null) ?? (person.email as string | null) ?? 'Unnamed',
      email: (person.email as string | null) ?? null,
      title: (person.exec_title as string | null) ?? null,
      level,
      canSignIn: isInGoodStanding(person),
      role: (person.permission_role as string | null) ?? null,
      grants: (person.permission_grants as string[] | null) ?? [],
      revokes: (person.permission_revokes as string[] | null) ?? [],
      baselineId: (person.permission_baseline_id as string | null) ?? null,
    }));

  // Everyone else, and ONLY FOR AN ADMIN. Giving somebody the console is a
  // level, and levels are handed out by admins alone — so for anybody else this
  // is a hundred rows they could look at and do nothing with, fetched on every
  // request. Not a security decision (setConsoleAccess refuses them regardless);
  // a decision about what is worth sending.
  //
  // Excluded by id rather than by re-stating the level filter with the sense
  // flipped: two filters that have to be exact opposites of each other are one
  // edit away from listing somebody twice, and a duplicated row on a permissions
  // page is a person an admin thinks they have two answers for.
  //
  // Excluded HERE rather than in the query, and that is the point of the extra
  // few rows. A `.not('id', 'in', …)` that PostgREST refused would come back as
  // `data: null` with the error unread, which renders as a search box that finds
  // nobody — no error, no empty state, nothing to notice. A Set the code owns
  // cannot fail that way.
  const viewerIsAdmin = isAdminActor(viewer);
  const holderIds = new Set(holders.map((person) => person.id));
  const { data: members } = viewerIsAdmin
    ? await adminClient
        .from('players')
        .select('id, full_name, email, is_banned, status, active_flag')
        .order('full_name')
    : { data: [] };

  // No level, so no permission columns and nothing to resolve. Written out as
  // the empty composition rather than left off the type: the editor asks one
  // question of every row it lists, and a second row shape would be a second
  // path through it for no gain.
  const others: PersonRow[] = (members ?? [])
    .filter((person) => !holderIds.has(person.id as string))
    .map((person) => ({
      id: person.id as string,
      name: (person.full_name as string | null) ?? (person.email as string | null) ?? 'Unnamed',
      email: (person.email as string | null) ?? null,
      title: null,
      level: null,
      canSignIn: isInGoodStanding(person),
      role: null,
      grants: [],
      revokes: [],
      baselineId: null,
    }));

  // THE CLUB'S OWN BASELINES. Read here rather than in the editor because the
  // editor is a client component and this is one query the page already has a
  // service-role client open for.
  //
  // FILTERED THROUGH THIS BUILD'S VOCABULARY on the way in, exactly as a stored
  // delta is: a string the code no longer knows resolves to nothing, and a
  // baseline offering one would promise a capability the app cannot deliver.
  // Every reader here — the picker, the summary line, the manager — then sees
  // the same list.
  //
  // A count of holders per baseline, from the rows already fetched above rather
  // than from a second query. It is what the manager needs to say how many
  // people an edit would reach and why a deletion is refused, and the holders
  // are by definition people with a level, who are already all here.
  const { data: baselineRows } = await adminClient
    .from('permission_baselines')
    .select('id, name, capabilities, builtin_role, created_at, updated_at')
    .order('name');

  const baselines: BaselineRow[] = (baselineRows ?? []).map((row) => {
    const builtinRole = isBuiltinPermissionRole(row.builtin_role) ? row.builtin_role : null;
    return {
      id: row.id as string,
      name: row.name as string,
      capabilities: ((row.capabilities as string[] | null) ?? []).filter(isCapability),
      builtinRole,
      // BOTH POPULATIONS, for the same reason holdersOf() counts both: a built-in
      // role reaches people whose grants were copied from it AND anybody still
      // storing the legacy permission_role it replaced. 00104 converts the second
      // kind, so this is normally zero — but a count that under-reports is the
      // one thing this number must never do, because it is what the Edit dialog
      // promises ("...and 3 people") before an admin presses the button.
      holders: holders.filter(
        (person) =>
          person.baselineId === row.id
          || (builtinRole !== null && person.baselineId === null && person.role === builtinRole),
      ).length,
    };
  });

  return (
    <div>
      <PageHeader
        title="Permissions"
        sub="Who can open this console, and what each of them may do"
        watermark="P"
      />

      <PermissionEditor
        holders={holders}
        others={others}
        viewerId={viewer.id as string}
        // Console access is a LEVEL, and levels are handed out by admins alone —
        // the hard floor in player-field-access.ts, which no capability reaches.
        // setConsoleAccess checks this again from the actor's own row; this only
        // decides whether the control is drawn.
        viewerIsAdmin={viewerIsAdmin}
        // The actor's own set, resolved on the SERVER through the same path
        // the gates use, and sent as a plain array because a Set does not
        // cross this boundary. It only decides what the editor DISABLES:
        // setPlayerPermissions resolves the same set again from the actor's
        // own row and refuses anything outside it, so this is a courtesy, not
        // the boundary.
        viewerCapabilities={[...viewerSet]}
        // The holder COUNT is dropped on the way in — the editor picks baselines,
        // it does not manage them — but `builtinRole` is not, because the picker
        // labels a built-in differently: to somebody assigning it, Finance is
        // still Finance and not "Baseline — Finance".
        baselines={baselines.map(({ id, name, capabilities, builtinRole }) => ({
          id,
          name,
          capabilities,
          builtinRole,
        }))}
      />

      {/* THE BASELINES THEMSELVES, below the editor rather than beside it. They
          are a different question — what the club's jobs ARE, not who holds one
          — and the two-pane editor is already a rail beside a tree on a laptop
          and a full screen on a phone. A third pane would have nowhere to go. */}
      <div className="mt-6">
        <BaselineManager
          baselines={baselines}
          viewerCapabilities={[...viewerSet]}
        />
      </div>
    </div>
  );
}
