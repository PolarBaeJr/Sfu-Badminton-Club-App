import Link from 'next/link';
import { ChevronRight } from 'lucide-react';
import { formatRelativeTime } from '@badminton/shared';
import { AvatarChip } from '@badminton/ui';
import { AnnouncementMarkdown } from '@/lib/announcement-markdown';
import type { DaySection, RiverPerson } from '@/lib/feed-activity';

/** A row in the river. Both kinds carry `at`, which is the only field the day
 *  grouping needs to know about. */
export type RiverItem =
  | {
      kind: 'match';
      id: string;
      at: string;
      mine: boolean;
      sentence: string;
      meta: string;
      face: RiverPerson;
      delta: number | null;
      rating: number | null;
      href: string;
    }
  | {
      kind: 'challenge';
      id: string;
      at: string;
      mine: true;
      sentence: string;
      meta: string;
      face: RiverPerson;
      href: string;
    };

export interface ClubNotice {
  title: string;
  body: string;
  createdAt: string;
  authorName: string | null;
}

/** A name with the handle 00092 gave the member beside it: beside, never
 *  instead of, and nothing at all when they have not chosen one. */
function Handle({ handle }: { handle: string | null }) {
  if (!handle) return null;
  return (
    <span className="mono muted" style={{ fontSize: 11, marginLeft: 6 }}>
      @{handle}
    </span>
  );
}

/**
 * What the club has been doing: the current notice, pending challenges and
 * the results river, in one titled card of its own. Below the schedule on a
 * phone and in the side column on a laptop, so the schedule leads either way.
 */
export function ActivityPanel({
  sections,
  notice,
  week,
  showChallengeCta,
  announcementsOn,
}: {
  sections: DaySection<RiverItem>[];
  notice: ClubNotice | null;
  week: number | null;
  showChallengeCta: boolean;
  announcementsOn: boolean;
}) {
  return (
    <section className="card-base home-activity" aria-labelledby="activity-title" data-tour="activity">
      <div className="card-head">
        <div>
          <h2 className="card-title" id="activity-title">Club activity</h2>
          <div className="card-sub">Results, challenges and club notices.</div>
        </div>
      </div>

      {notice && (
        <Link href="/announcements" className="home-notice press">
          <div className="wide-cap">Club notice</div>
          <h3 className="card-title" style={{ margin: '8px 0 6px' }}>
            {notice.title}
          </h3>
          <AnnouncementMarkdown text={notice.body} style={{ fontSize: 15, lineHeight: 1.45, margin: 0 }} />
          <div
            className="mono muted"
            style={{ fontSize: 10, letterSpacing: '.1em', textTransform: 'uppercase', marginTop: 12 }}
          >
            {/* The author's own name, which is what the notice is signed with
                everywhere else in the app. */}
            {notice.authorName ? `Posted by ${notice.authorName}` : 'Posted by the club'}{' '}
            · {formatRelativeTime(notice.createdAt)}
          </div>
        </Link>
      )}

      {sections.length === 0 ? (
        <div className="empty">
          <div className="empty-title">Nothing has happened yet</div>
          <div className="empty-hint">
            Results and challenges land here as the club plays. Issue a challenge to
            put the first one on the board.
          </div>
          {showChallengeCta && (
            <Link href="/challenges/new" className="btn btn-ghost">
              Issue a challenge <ChevronRight size={12} />
            </Link>
          )}
        </div>
      ) : (
        <div>
          {sections.map((section) => (
            <div key={section.key}>
              <div className="river-day">{section.label}</div>
              {section.items.map((item) => (
                <Link
                  key={`${item.kind}-${item.id}`}
                  href={item.href}
                  className={`river-row press${item.mine ? ' mine' : ''}`}
                >
                  <AvatarChip name={item.face.name} id={item.face.id} src={item.face.avatarUrl} size="sm" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div className="river-sentence">
                      {item.sentence}
                      <Handle handle={item.face.handle} />
                    </div>
                    <div className="river-meta">{item.meta}</div>
                  </div>
                  {item.kind === 'challenge' ? (
                    <span className="btn btn-ghost btn-sm" style={{ marginLeft: 'auto' }}>
                      Reply
                    </span>
                  ) : (
                    <div className="river-value">
                      {typeof item.delta === 'number' && (
                        <div
                          className="river-delta"
                          style={{ color: item.delta >= 0 ? 'var(--win)' : 'var(--loss)' }}
                        >
                          {item.delta >= 0 ? '+' : ''}
                          {item.delta}
                        </div>
                      )}
                      {typeof item.rating === 'number' && <div className="river-rating">{item.rating}</div>}
                    </div>
                  )}
                </Link>
              ))}
            </div>
          ))}
          <div className="river-end">{week ? `End of week ${week}` : 'End of the feed'}</div>
        </div>
      )}

      <div className="home-activity-foot">
        <Link href="/notifications" className="btn btn-ghost btn-sm">
          All notifications <ChevronRight size={12} />
        </Link>
        {announcementsOn && (
          <Link href="/announcements" className="btn btn-ghost btn-sm">
            Announcements <ChevronRight size={12} />
          </Link>
        )}
      </div>
    </section>
  );
}
