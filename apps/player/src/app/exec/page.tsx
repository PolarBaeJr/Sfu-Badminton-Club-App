import Link from 'next/link';
import { Users } from 'lucide-react';
import { createServerSupabaseClient, getExecutives } from '@/lib/supabase-server';
import { AvatarChip } from '@badminton/ui';

// Public page — viewable without an account (see middleware public allowlist).
export const dynamic = 'force-dynamic';

/** Everything on this screen comes from get_executives() (00042), which returns
 *  exactly `id, name, exec_title, exec_photo_url, bio` for rows with
 *  `is_exec AND active_flag`. It is SECURITY DEFINER and granted to anon
 *  precisely so this page works logged out — 00032 revoked blanket SELECT on
 *  players, so exec_title and bio are unreachable from an ordinary embed. There
 *  is no email column in that signature and no club contact address anywhere in
 *  platform_settings, which is why no officer here carries a contact control:
 *  publishing an address the function deliberately withholds would be a privacy
 *  decision, not a layout one. */

/** Titles are free text — the admin console accepts any string up to 60 chars
 *  (schemas.ts: `exec_title: blankAsUndefined(z.string().max(60))`) — so there
 *  is no closed set to key a lookup table off. This predicate is the one
 *  exception, and it is asked twice by the design (the president leads the list,
 *  and only the president's title is set in --red), so it is one fact answered
 *  once. `vice`/`vp`/`deputy` are excluded first because 'Vice President'
 *  contains 'President'; a co-president legitimately matches and is hoisted too. */
function isPresident(title: string | null) {
  if (!title) return false;
  const t = title.toLowerCase();
  if (/\b(vice|vp|deputy)\b/.test(t)) return false;
  return /\bpresident\b/.test(t);
}

/** 'Five volunteers' reads as a sentence where '5 volunteers' reads as a stat,
 *  and this line is prose. Falls back to the digits above twelve rather than
 *  growing a spelling table nobody will ever exercise — a club with thirteen
 *  execs has bigger problems than typography. */
const COUNT_WORDS = [
  'Zero', 'One', 'Two', 'Three', 'Four', 'Five', 'Six',
  'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve',
];

function countWord(n: number) {
  return COUNT_WORDS[n] ?? String(n);
}

export default async function ExecPage() {
  const execs = await getExecutives();

  // Only to choose the back link. getCurrentPlayer() would be the wrong tool:
  // it reads the whole players row through the service-role client, and this
  // page needs to know nothing about the visitor beyond whether Me exists for
  // them. A signed-out visitor arrives here from the landing page, and '← ME'
  // would walk them into a login wall.
  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  const back = user ? { href: '/my-stats', label: '← ME' } : { href: '/', label: '← HOME' };

  // get_executives() orders alphabetically by title — `ORDER BY (exec_title IS
  // NULL), exec_title, name` — which puts Marketing above President and reads
  // as no order at all. The president leads; everyone else keeps the function's
  // order, which Array#sort preserves because it is stable.
  const officers = [...execs].sort(
    (a, b) => Number(isPresident(b.exec_title)) - Number(isPresident(a.exec_title))
  );

  return (
    <div data-screen-label="Executives" className="exec-screen wide-page">
      <header className="exec-head wide-head">
        <Link href={back.href} className="exec-back">{back.label}</Link>
        <h1 className="exec-title">Executives<span className="dot">.</span></h1>
        {officers.length > 0 && (
          <p className="exec-sub">
            {officers.length === 1
              ? 'One volunteer. Ask them anything.'
              : `${countWord(officers.length)} volunteers. Ask any of them anything.`}
          </p>
        )}
      </header>

      {officers.length === 0 ? (
        <div className="card-base" style={{ marginTop: 20 }}>
          <div className="empty">
            <div className="empty-icon"><Users size={20} /></div>
            <div className="empty-title">No executives listed yet</div>
            <div className="empty-hint">The exec team will appear here once it&apos;s been added.</div>
          </div>
        </div>
      ) : (
        <div className="exec-list">
          {officers.map((e) => (
            <article key={e.id} className="exec-officer">
              <div className="exec-officer-top">
                {/* exec_photo_url, NOT the ladder avatar: this page gets proper
                    posed photos, and pointing it at avatar_url would mean a
                    profile-picture change silently altered the club page.
                    Falls back to initials when no exec photo is set. */}
                <AvatarChip name={e.name} src={e.exec_photo_url} size="lg" id={e.id} />
                <div className="exec-officer-id">
                  <div className="exec-officer-name">{e.name}</div>
                  {e.exec_title && (
                    <div
                      className="exec-officer-role"
                      data-lead={isPresident(e.exec_title) ? 'true' : undefined}
                    >
                      {e.exec_title}
                    </div>
                  )}
                </div>
              </div>
              {/* players.bio, which execs write about themselves in Settings and
                  which 00042 added to this function specifically so it would
                  land here. Omitted rather than substituted when empty: a
                  sentence invented per job title would be the club making a
                  promise on a volunteer's behalf. */}
              {e.bio && <p className="exec-officer-bio">{e.bio}</p>}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
