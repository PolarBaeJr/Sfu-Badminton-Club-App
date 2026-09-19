-- Baselines named after the jobs the club actually has.
--
-- WHY THIS IS DATA AND NOT CODE. permission_baselines (00093) already is the
-- mechanism: a named capability set the club writes for itself, editable from
-- /permissions, copied onto a person when it is assigned. ROLE_DEFAULTS stays a
-- frozen transcription of what shipped, exactly as 00104 intended, so its two
-- structural invariants survive literally. Nothing in TypeScript changes here.
-- These are eight rows.
--
-- WHERE THE SETS CAME FROM. Not invented. Every officer on the console was read
-- back, their capability arrays decomposed into the area blocks that recur
-- across them, and the blocks recomposed under the real titles. Two of the eight
-- reproduce a live officer's set exactly: "Coordinator, Community
-- Communication" is byte for byte what that officer holds today, and "Vice
-- President, Competitive Team" is what the VP holds plus the one page below.
--
-- THE DEFECT THIS FIXES. Four officers hold writes in an area whose .page they
-- do not have, so those writes are unreachable through the console: the VP can
-- ban and reinstate members but cannot open Players; the Sponsorship
-- Coordinator can post and delete announcements but cannot open Announcements.
-- Seven cases in all. Every row below carries <area>.page for every area it
-- touches, and the generator refuses to emit one that does not.
--
-- THE OVER-GRANT THIS FIXES. The Sponsorship Coordinator currently holds all 39
-- tournament capabilities, including generating draws, voiding results and
-- finalizing standings. Sponsorship is money and announcements. That row goes
-- from 59 capabilities to 12. Three design and marketing officers likewise hold
-- players.ban.write and seasons.end.write today, which the rows below drop.
--
-- builtin_role IS NULL ON EVERY ROW, deliberately. That is what makes them
-- fully editable: the manager offers Edit and Delete on a club-written baseline
-- and Edit plus Reset on a built-in, which cannot be deleted. These eight are the
-- club's own, to rename, re-scope or throw away.
--
-- ON CONFLICT DO NOTHING, also deliberately. Assigning a baseline COPIES it onto
-- a person, so this file must never re-assert a row the club has since edited.
-- Seeding is a one-time act; re-running this migration is a no-op.
--
-- ASSIGNING THEM IS NOT DONE HERE. These rows change nobody's access on their
-- own. An admin picks one per officer from /permissions, which is the audited
-- path, and that is the point: the club decides who gets what.

-- Vice President, Competitive Team (58 capabilities)
insert into permission_baselines (id, name, capabilities, builtin_role)
values (
  '5eed0060-0000-4000-8000-000000000201',
  'Vice President, Competitive Team',
  array[
    'tournaments.page',
    'tournaments.manage.create.write',
    'tournaments.manage.update.write',
    'tournaments.manage.status.write',
    'tournaments.manage.suspend.write',
    'tournaments.manage.resume.write',
    'tournaments.manage.archive.write',
    'tournaments.manage.delete.write',
    'tournaments.manage.event.create.write',
    'tournaments.manage.event.update.write',
    'tournaments.manage.event.delete.write',
    'tournaments.manage.event.status.write',
    'tournaments.draw.participants.add.write',
    'tournaments.draw.participants.remove.write',
    'tournaments.draw.checkin.token.write',
    'tournaments.draw.checkin.mark.write',
    'tournaments.draw.noshow.write',
    'tournaments.draw.exit.write',
    'tournaments.draw.pairs.add.write',
    'tournaments.draw.pairs.remove.write',
    'tournaments.draw.seed.set.write',
    'tournaments.draw.seed.auto.write',
    'tournaments.draw.seed.clear.write',
    'tournaments.draw.generate.write',
    'tournaments.draw.lock.write',
    'tournaments.draw.unlock.write',
    'tournaments.draw.waivers.read',
    'tournaments.draw.entrycounts.read',
    'tournaments.results.enter.write',
    'tournaments.results.walkover.write',
    'tournaments.results.void.write',
    'tournaments.results.unvoid.write',
    'tournaments.results.undo.write',
    'tournaments.results.edit.write',
    'tournaments.results.entry.write',
    'tournaments.results.doublenoshow.write',
    'tournaments.results.bonuses.write',
    'tournaments.results.standings.write',
    'tournaments.results.finalize.write',
    'matches.page',
    'matches.create.write',
    'matches.convert.write',
    'matches.void.write',
    'sessions.page',
    'sessions.attendance.write',
    'sessions.checkin.token.write',
    'sessions.reminders.write',
    'sessions.create.write',
    'sessions.update.write',
    'sessions.archive.write',
    'sessions.delete.write',
    'players.page',
    'players.read',
    'players.approve.write',
    'players.update.write',
    'players.editor.varsitynotes.write',
    'players.ban.write',
    'players.reinstate.write'
  ]::text[],
  null
)
on conflict do nothing;

-- Internal Events Lead (26 capabilities)
--
-- Named for the portfolio, not for a person. This is the set the officer titled
-- "Coordinator, Events" actually holds today (25 capabilities, plus the missing
-- Matches page). It is a deputy-of-everything-internal set: full roster powers,
-- the whole session desk, match entry and the announcement composer. The club's
-- Director of Internal Events is role = 'admin' and outranks it, so this row is
-- for whoever runs internal events without being an admin.
insert into permission_baselines (id, name, capabilities, builtin_role)
values (
  '5eed0060-0000-4000-8000-000000000202',
  'Internal Events Lead',
  array[
    'sessions.page',
    'sessions.attendance.write',
    'sessions.checkin.token.write',
    'sessions.reminders.write',
    'sessions.create.write',
    'sessions.update.write',
    'sessions.archive.write',
    'sessions.delete.write',
    'matches.page',
    'matches.create.write',
    'matches.convert.write',
    'matches.void.write',
    'announcements.page',
    'announcements.create.write',
    'announcements.update.write',
    'announcements.delete.write',
    'legal.page',
    'legal.reacceptance.write',
    'players.page',
    'players.read',
    'players.approve.write',
    'players.create.write',
    'players.update.write',
    'players.waiver.resign.write',
    'players.ban.write',
    'players.reinstate.write'
  ]::text[],
  null
)
on conflict do nothing;

-- Coordinator, Events (14 capabilities)
insert into permission_baselines (id, name, capabilities, builtin_role)
values (
  '5eed0060-0000-4000-8000-000000000203',
  'Coordinator, Events',
  array[
    'sessions.page',
    'sessions.attendance.write',
    'sessions.checkin.token.write',
    'sessions.reminders.write',
    'sessions.create.write',
    'sessions.update.write',
    'sessions.archive.write',
    'sessions.delete.write',
    'matches.page',
    'announcements.page',
    'announcements.create.write',
    'announcements.update.write',
    'players.page',
    'players.read'
  ]::text[],
  null
)
on conflict do nothing;

-- Director, Social Media and Marketing (8 capabilities)
insert into permission_baselines (id, name, capabilities, builtin_role)
values (
  '5eed0060-0000-4000-8000-000000000204',
  'Director, Social Media and Marketing',
  array[
    'announcements.page',
    'announcements.create.write',
    'announcements.update.write',
    'announcements.delete.write',
    'announcements.discord.write',
    'players.page',
    'players.read',
    'sessions.page'
  ]::text[],
  null
)
on conflict do nothing;

-- Coordinator, Community Communication (11 capabilities)
insert into permission_baselines (id, name, capabilities, builtin_role)
values (
  '5eed0060-0000-4000-8000-000000000205',
  'Coordinator, Community Communication',
  array[
    'announcements.page',
    'announcements.create.write',
    'announcements.update.write',
    'announcements.delete.write',
    'announcements.discord.write',
    'legal.page',
    'legal.reacceptance.write',
    'sessions.page',
    'sessions.attendance.write',
    'sessions.checkin.token.write',
    'sessions.reminders.write'
  ]::text[],
  null
)
on conflict do nothing;

-- Coordinator, Marketing (6 capabilities)
insert into permission_baselines (id, name, capabilities, builtin_role)
values (
  '5eed0060-0000-4000-8000-000000000206',
  'Coordinator, Marketing',
  array[
    'announcements.page',
    'announcements.create.write',
    'announcements.update.write',
    'announcements.delete.write',
    'players.page',
    'players.read'
  ]::text[],
  null
)
on conflict do nothing;

-- Design and Media (5 capabilities)
insert into permission_baselines (id, name, capabilities, builtin_role)
values (
  '5eed0060-0000-4000-8000-000000000207',
  'Design and Media',
  array[
    'announcements.page',
    'announcements.create.write',
    'announcements.update.write',
    'players.page',
    'players.read'
  ]::text[],
  null
)
on conflict do nothing;

-- Sponsorship Coordinator (12 capabilities)
insert into permission_baselines (id, name, capabilities, builtin_role)
values (
  '5eed0060-0000-4000-8000-000000000208',
  'Sponsorship Coordinator',
  array[
    'fees.page',
    'fees.expenses.read',
    'fees.expenses.add.write',
    'announcements.page',
    'announcements.create.write',
    'announcements.update.write',
    'announcements.delete.write',
    'announcements.discord.write',
    'legal.page',
    'legal.reacceptance.write',
    'players.page',
    'players.read'
  ]::text[],
  null
)
on conflict do nothing;

-- NO TREASURER ROW, ON PURPOSE. The built-in "Finance" baseline is already
-- byte for byte the treasurer's set: fees.page, fees.expenses.read,
-- fees.expenses.add.write, which is every fees capability an exec can be
-- offered. Seeding a "Treasurer" row would have shipped two rows meaning the
-- same thing, one offering Reset and one offering Delete, which is the exact
-- confusion this file exists to remove. If the club wants the name to say the
-- job, rename Finance from /permissions; it stays built-in and protected.
--
-- 8 rows, builtin_role null on every one.
