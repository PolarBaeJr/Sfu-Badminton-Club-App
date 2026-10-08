// WHETHER THE ROSTER OFFERS A CONSOLE-ACCESS CONTROL ON A ROW, and which levels
// it offers — the two questions /players has to answer per row now that the club
// owner has asked for console access to be editable from the player menu as well
// as from /permissions.
//
// A PURE MODULE RATHER THAN THREE CONDITIONS IN THE COMPONENT, for the reason
// roster-actions.ts gives for itself: this is the one part of the feature that
// can be checked without a database, a browser or a session, and vitest here
// runs environment: 'node', so a rule left inside a component is a rule with no
// test.
//
// THIS IS NOT A BOUNDARY, AND MUST NOT BE MISTAKEN FOR ONE. Every refusal it
// mirrors is already made — before anything is read — inside
// setConsoleAccessImpl (lib/actions/permissions.ts): the capability itself, the
// self-edit, the admin target, minting an admin, and grant closure in both
// directions. What this decides is only what is DRAWN, and it exists because
// this codebase's rule is that a button guaranteed to refuse is worse than no
// button at all.
import { EXEC_ROLE_OPTIONS, type ExecRole } from './console-access';

export interface ConsoleAccessOffer {
  /** Draw the control at all. */
  offered: boolean;
  /** The levels this viewer may choose for this member, in the order shown. */
  options: typeof EXEC_ROLE_OPTIONS;
}

const WITHOUT_ADMIN = EXEC_ROLE_OPTIONS.filter((option) => option.value !== 'admin');

export function consoleAccessOffer({
  canWrite,
  isSelf,
  current,
  viewerIsAdmin,
}: {
  /** players.consoleaccess.write — the capability setConsoleAccess asks for. */
  canWrite: boolean;
  /** This row is the viewer's own. */
  isSelf: boolean;
  /** What the member's three level columns resolve to today. */
  current: ExecRole;
  viewerIsAdmin: boolean;
}): ConsoleAccessOffer {
  const options = viewerIsAdmin ? EXEC_ROLE_OPTIONS : WITHOUT_ADMIN;

  // SILENTLY ABSENT ON THESE THREE ROWS, where /permissions writes a sentence
  // instead. The difference is that /permissions is a screen about one selected
  // person with room to explain, and this is one control in a strip of buttons
  // repeated down five hundred rows — a paragraph per row would be the loudest
  // thing on the page and it would be answering a question nobody asked, since
  // nothing on a roster row invites you to change a level in the first place.
  //
  //   isSelf              refused by setConsoleAccess before it reads anything:
  //                       handing yourself a level is the one move that would
  //                       let this capability promote its own holder, and
  //                       taking your own away loses you the screen that puts
  //                       it back.
  //   an admin target,    the level no capability hands out is the one no
  //   viewer not admin    capability takes back — the same act in both
  //                       directions, so the same rule.
  const offered = canWrite && !isSelf && !(current === 'admin' && !viewerIsAdmin);

  return { offered, options };
}
