import { describe, it, expect } from 'vitest';
import {
  EXPORT_HEADER,
  EXPORT_ROW_CAP,
  TRUNCATION_NOTICE,
  exportFilename,
  exportHeader,
  formatClubTimestamp,
  isMissingFunctionError,
  mapConsoleRow,
  mapNotificationRow,
  mapSignInRow,
  mapTournamentRow,
  resolveLogType,
  sourcesForLogType,
  truncationNoticeRow,
  type ConsoleExportRow,
  type NotificationExportRow,
  type SignInRow,
  type TournamentExportRow,
} from '../audit-export';

// WHAT THIS FILE IS DEFENDING. An export is read once, months later, by
// somebody reconstructing what happened, and every failure mode it has is
// silent: a row that vanished, a column that shifted, a timestamp an hour out,
// a cell that Excel decided was a formula. None of those throw and none of them
// look wrong on the screen the file came from. So the mappers are checked cell
// by cell, against rows shaped like the ones the database actually holds.

const CONSOLE_ROW: ConsoleExportRow = {
  id: '4b1c2d3e-1111-2222-3333-444444444444',
  created_at: '2026-09-21T02:00:00.000Z',
  action_type: 'player_banned',
  target_type: 'player',
  target_id: 'aaaaaaaa-0000-0000-0000-000000000000',
  reason: 'Repeated no-shows',
  actor: { full_name: 'Aiko Tanaka' },
  subject: null,
};

describe('formatClubTimestamp', () => {
  it('reads the CLUB clock, not the container clock', () => {
    // The F-022 shape: 02:00 UTC on the 21st is the evening of the 20th in
    // Vancouver. The containers run UTC, so a formatter without an explicit
    // timeZone files this under the wrong day, and the whole file then
    // disagrees with the season it says it covers.
    expect(formatClubTimestamp('2026-09-21T02:00:00.000Z')).toBe('2026-09-20 19:00:00');
  });

  it('reads Vancouver after 2026-11-01 as UTC-07:00 on every build', () => {
    // British Columbia stops falling back on 2026-11-01. Node's bundled tzdata
    // disagrees about that by build (2026a says UTC-8, 2026b says UTC-7), so
    // past the cutover the offset is pinned, the same rule as clubToday() and
    // club_local_instant(). This instant must read 19:00 whatever
    // process.versions.tz says.
    expect(formatClubTimestamp('2026-11-05T02:00:00.000Z')).toBe('2026-11-04 19:00:00');
  });

  it('switches to the pinned offset at midnight club time on the cutover day', () => {
    // 2026-11-01 07:00Z is 00:00 on the 1st at UTC-07:00, the first pinned instant.
    expect(formatClubTimestamp('2026-11-01T07:00:00.000Z')).toBe('2026-11-01 00:00:00');
    // One second earlier is still October, read through tzdata, which every
    // release agrees on for that date (PDT, UTC-07:00).
    expect(formatClubTimestamp('2026-11-01T06:59:59.000Z')).toBe('2026-10-31 23:59:59');
  });

  it('pads every field, so the column sorts as a string', () => {
    expect(formatClubTimestamp('2026-01-02T20:03:04.000Z')).toBe('2026-01-02 12:03:04');
  });

  it('shows an unreadable timestamp verbatim rather than blanking the cell', () => {
    // relativeWhen()'s rule. A row whose timestamp nothing can parse is still a
    // record of something happening.
    expect(formatClubTimestamp('not-a-date')).toBe('not-a-date');
    expect(formatClubTimestamp(null)).toBe('');
    expect(formatClubTimestamp(undefined)).toBe('');
  });
});

describe('resolveLogType', () => {
  it('takes the five it knows', () => {
    expect(resolveLogType('console')).toBe('console');
    expect(resolveLogType('signins')).toBe('signins');
    expect(resolveLogType('tournaments')).toBe('tournaments');
    expect(resolveLogType('notifications')).toBe('notifications');
    expect(resolveLogType('all')).toBe('all');
  });

  it('falls back to console rather than dead-ending', () => {
    // A query string is something somebody can type and a link can carry
    // stale. The answer to all of it is the default view, never an error.
    expect(resolveLogType(undefined)).toBe('console');
    expect(resolveLogType(null)).toBe('console');
    expect(resolveLogType('')).toBe('console');
    expect(resolveLogType('signin')).toBe('console');
    expect(resolveLogType('ALL')).toBe('console');
  });
});

describe('sourcesForLogType', () => {
  it('asks one table for one type and four for everything', () => {
    expect(sourcesForLogType('console')).toEqual(['console']);
    expect(sourcesForLogType('all')).toEqual(['console', 'signins', 'tournaments', 'notifications']);
  });
});

describe('the header', () => {
  it('appends email LAST, so the two shapes agree cell for cell up to it', () => {
    expect(exportHeader(false)).toEqual([...EXPORT_HEADER]);
    expect(exportHeader(true)).toEqual([...EXPORT_HEADER, 'email']);
  });
});

describe('mapConsoleRow', () => {
  it('writes the row the screen shows, at full width', () => {
    expect(mapConsoleRow(CONSOLE_ROW, false)).toEqual([
      '2026-09-20 19:00:00',
      'console',
      'console',
      // The FULL name, not abbreviateActor()'s "A. Tanaka": two officers
      // sharing an initial is exactly the ambiguity an audit trail must not
      // introduce, and a file has no width problem.
      'Aiko Tanaka',
      'PLAYER BANNED',
      'player',
      // The FULL uuid, not shortRef(). The short form is for quoting out loud.
      'aaaaaaaa-0000-0000-0000-000000000000',
      'Repeated no-shows',
      '4b1c2d3e-1111-2222-3333-444444444444',
    ]);
  });

  it('says System for a row no person wrote', () => {
    const row = mapConsoleRow({ ...CONSOLE_ROW, actor: null, action_type: 'auto_marked_inactive' }, false);
    expect(row[3]).toBe('System');
    // A nightly job is console work done to a member, and the actor column
    // already says no person did it.
    expect(row[2]).toBe('console');
  });

  it('reflects entryKind into the kind column for all five named types', () => {
    const kindOf = (action_type: string) =>
      mapConsoleRow({ ...CONSOLE_ROW, action_type }, false)[2];
    expect(kindOf('passkey_verified')).toBe('auth');
    expect(kindOf('passkey_login')).toBe('auth');
    expect(kindOf('passkey_registered')).toBe('auth');
    expect(kindOf('self_rating_seeded')).toBe('self-service');
    expect(kindOf('self_deletion_requested')).toBe('self-service');
  });

  it('exports a type it has never seen instead of dropping the row', () => {
    const row = mapConsoleRow({ ...CONSOLE_ROW, action_type: 'sponsorship_signed' }, false);
    expect(row[2]).toBe('console');
    expect(row[4]).toBe('SPONSORSHIP SIGNED');
  });

  it('says Detail lost rather than printing the sentinel an officer never typed', () => {
    const row = mapConsoleRow(
      { ...CONSOLE_ROW, reason: 'Voided. [audit payload dropped: too large]' },
      false,
    );
    expect(row[7]).toBe('Detail lost');
  });

  it('names the subject when the page resolved one', () => {
    const row = mapConsoleRow({ ...CONSOLE_ROW, subject: { full_name: 'Aiko Tanaka' } }, false);
    expect(row[7]).toBe('re: Aiko Tanaka - Repeated no-shows');
  });

  it('keeps a reason containing a comma and a quote as ONE value', () => {
    // The escaping is csv.ts's job; this is the assertion that the mapper hands
    // it the raw text rather than mangling it first.
    const reason = 'Banned, then she said "no" about it';
    expect(mapConsoleRow({ ...CONSOLE_ROW, reason }, false)[7]).toBe(reason);
  });

  it('leaves the email cell empty rather than short', () => {
    // A ragged row shifts every cell after it one column left, and nothing
    // anywhere reports that.
    const row = mapConsoleRow(CONSOLE_ROW, true);
    expect(row).toHaveLength(EXPORT_HEADER.length + 1);
    expect(row[9]).toBe('');
  });

  it('survives a row with nothing in it but a fact', () => {
    const row = mapConsoleRow(
      { ...CONSOLE_ROW, target_type: null, target_id: null, reason: null, actor: null },
      false,
    );
    expect(row[5]).toBe('');
    expect(row[6]).toBe('');
    expect(row[7]).toBe('');
  });
});

describe('mapSignInRow', () => {
  const row: SignInRow = {
    entry_id: '9f8e7d6c-1111-2222-3333-444444444444',
    occurred_at: '2026-09-21T02:00:00.000Z',
    action: 'user_recovery_requested',
    what: 'passkey login',
    person: 'Viraj Veer Chowdhary',
    email: 'viraj@example.com',
    provider: '(passkey or email code)',
  };

  it('keeps the raw action and the classification in separate columns', () => {
    const cells = mapSignInRow(row, false);
    // Printing `user_recovery_requested` alone would tell the club it emailed a
    // recovery code when it did not; printing only the classification would
    // hide the value the judgement was made from.
    expect(cells[4]).toBe('user_recovery_requested');
    expect(cells[2]).toBe('passkey login');
  });

  it('carries no auth user id, and no ip', () => {
    const cells = mapSignInRow(row, false);
    expect(cells[5]).toBe('auth');
    // An auth uuid in a file any exec can download is a re-identification key
    // with no reader-facing use. The provider label takes the detail column;
    // there is no ip to put anywhere, on this deployment or in this file.
    expect(cells[6]).toBe('');
    expect(cells[7]).toBe('(passkey or email code)');
  });

  it('withholds the email unless it was asked for', () => {
    expect(mapSignInRow(row, false)).toHaveLength(EXPORT_HEADER.length);
    expect(mapSignInRow(row, true)[9]).toBe('viraj@example.com');
  });

  it('passes the unresolved-name marker through rather than blanking it', () => {
    // 00257 returns '(no player name)' itself, so an unresolved person can
    // never be read as a missing value.
    expect(mapSignInRow({ ...row, person: '(no player name)' }, false)[3]).toBe('(no player name)');
  });
});

describe('mapTournamentRow', () => {
  const row: TournamentExportRow = {
    id: '11111111-2222-3333-4444-555555555555',
    created_at: '2026-09-21T02:00:00.000Z',
    action: 'match_voided',
    details: { scores: [[21, 19]], reason: 'Wrong court' },
    tournament_id: 'tttttttt-0000-0000-0000-000000000000',
    event_id: 'eeeeeeee-0000-0000-0000-000000000000',
    match_id: 'mmmmmmmm-0000-0000-0000-000000000000',
    actor: { full_name: 'Sam Mercer' },
  };

  it('names the most specific target the row has', () => {
    expect(mapTournamentRow(row, false).slice(5, 7))
      .toEqual(['match', 'mmmmmmmm-0000-0000-0000-000000000000']);
    expect(mapTournamentRow({ ...row, match_id: null }, false).slice(5, 7))
      .toEqual(['event', 'eeeeeeee-0000-0000-0000-000000000000']);
    expect(mapTournamentRow({ ...row, match_id: null, event_id: null }, false).slice(5, 7))
      .toEqual(['tournament', 'tttttttt-0000-0000-0000-000000000000']);
    expect(mapTournamentRow({ ...row, match_id: null, event_id: null, tournament_id: null }, false).slice(5, 7))
      .toEqual(['', '']);
  });

  it('is always console work, because every writer of that table is', () => {
    expect(mapTournamentRow(row, false)[2]).toBe('console');
  });

  it('truncates a details blob and says it did', () => {
    const long = { note: 'x'.repeat(900) };
    const cell = mapTournamentRow({ ...row, details: long }, false)[7] as string;
    expect(cell).toHaveLength(501);
    expect(cell.endsWith('…')).toBe(true);
  });

  it('leaves the detail cell empty for a row with no payload', () => {
    expect(mapTournamentRow({ ...row, details: null }, false)[7]).toBe('');
  });

  it('handles the nullable created_at this table has', () => {
    expect(mapTournamentRow({ ...row, created_at: null }, false)[0]).toBe('');
  });
});

describe('mapNotificationRow', () => {
  const row: NotificationExportRow = {
    id: '22222222-3333-4444-5555-666666666666',
    created_at: '2026-09-21T02:00:00.000Z',
    type: 'fee_due',
    title: 'Your club fee is due',
    player_id: 'pppppppp-0000-0000-0000-000000000000',
    recipient: { full_name: 'Aiko Tanaka' },
  };

  it('writes System, because the table records no actor at all', () => {
    const cells = mapNotificationRow(row, false);
    expect(cells[3]).toBe('System');
    expect(cells[4]).toBe('NOTIFICATION SENT');
    expect(cells[2]).toBe('fee_due');
  });

  it('names the recipient beside the title, and carries no body', () => {
    // The body is correspondence with one member and adds nothing to the
    // question this file answers.
    expect(mapNotificationRow(row, false)[7]).toBe('to: Aiko Tanaka - Your club fee is due');
    expect(mapNotificationRow({ ...row, recipient: null }, false)[7]).toBe('Your club fee is due');
  });
});

describe('the truncation notice', () => {
  it('is a ROW in the file, not a header nobody reads', () => {
    // A header, a filename or a line on the page all vanish the moment the file
    // is forwarded, and a truncated export is otherwise indistinguishable from
    // a quiet season.
    const notice = truncationNoticeRow('console', false);
    expect(notice[1]).toBe('export');
    expect(notice[2]).toBe('notice');
    expect(notice[5]).toBe('console');
    expect(notice[7]).toBe(TRUNCATION_NOTICE);
    expect(notice).toHaveLength(EXPORT_HEADER.length);
  });

  it('names the cap it is talking about', () => {
    expect(TRUNCATION_NOTICE).toContain(String(EXPORT_ROW_CAP));
  });

  it('stays the same width as everything else when emails are revealed', () => {
    expect(truncationNoticeRow('signins', true)).toHaveLength(EXPORT_HEADER.length + 1);
  });
});

describe('exportFilename', () => {
  it('slugs the scope into the name', () => {
    expect(exportFilename('console', 'Fall 2026', '2026-09-21'))
      .toBe('audit-console-fall-2026-2026-09-21.csv');
    expect(exportFilename('signins', 'Last 30 days', '2026-09-21'))
      .toBe('audit-signins-last-30-days-2026-09-21.csv');
  });

  it('says in the NAME that the sign-ins are missing', () => {
    // A silently shorter file is a lie: it looks exactly like an export of a
    // club where nobody signed in. The filename is the one part of this the
    // reader sees before opening it and that survives being forwarded.
    expect(exportFilename('all', 'Fall 2026', '2026-09-21', true))
      .toBe('audit-all-no-signins-fall-2026-2026-09-21.csv');
    expect(exportFilename('all', 'Fall 2026', '2026-09-21', false))
      .toBe('audit-all-fall-2026-2026-09-21.csv');
  });

  it('only says it for the type where something was actually dropped', () => {
    // Nothing is omitted from a console-only export, whoever asks for it.
    expect(exportFilename('console', 'Fall 2026', '2026-09-21', true))
      .toBe('audit-console-fall-2026-2026-09-21.csv');
  });
});

describe('isMissingFunctionError', () => {
  const fn = 'export_auth_signins';

  it('knows the two codes that mean the migration is not applied', () => {
    expect(isMissingFunctionError({ code: 'PGRST202', message: 'not found' }, fn)).toBe(true);
    expect(isMissingFunctionError({ code: '42883', message: 'undefined function' }, fn)).toBe(true);
  });

  it('has a backstop for a client that reports no code', () => {
    expect(isMissingFunctionError(
      { message: 'Could not find the function public.export_auth_signins in the schema cache' },
      fn,
    )).toBe(true);
  });

  it('calls everything else a real failure, which is the whole point', () => {
    // A blanket catch would mean that once 00257 is applied, a permission, a
    // connection or a timeout ends as a cheerful empty export and the reader
    // concludes nobody signed in.
    expect(isMissingFunctionError({ code: '42501', message: 'permission denied' }, fn)).toBe(false);
    expect(isMissingFunctionError({ code: '57014', message: 'canceling statement' }, fn)).toBe(false);
    // The right shape of message about the WRONG function is still not this one.
    expect(isMissingFunctionError({ message: 'function other_thing does not exist' }, fn)).toBe(false);
    expect(isMissingFunctionError(null, fn)).toBe(false);
    expect(isMissingFunctionError(undefined, fn)).toBe(false);
  });
});
