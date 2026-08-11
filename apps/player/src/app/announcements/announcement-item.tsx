'use client';

import { useEffect, useRef } from 'react';
import { markAnnouncementRead } from '@/lib/actions';
import { AvatarChip, Badge } from '@badminton/ui';

/** Everything the row needs, already resolved and already formatted.
 *
 *  Dates arrive as strings rather than as ISO timestamps on purpose: they are
 *  formatted on the server in the club's timezone (see page.tsx), so a member
 *  reading this in another timezone sees the date the exec meant, and the
 *  markup React hydrates matches the markup it rendered. Formatting a date in a
 *  client component is how the old version of this screen could differ between
 *  server and browser.
 */
export interface NewsPost {
  id: string;
  title: string;
  body: string;
  /** Uppercased category label, e.g. 'VENUE'. Always present. */
  category: string;
  /** Badge tone for that category. Unknown categories resolve to neutral. */
  tone: 'default' | 'success' | 'warning' | 'danger' | 'info' | 'neutral';
  /** '18 JAN' on a row, '2 DAYS AGO' on the pinned notice. */
  stamp: string;
  author: {
    id: string;
    /** Full name, for the avatar's initials and the pinned notice. */
    name: string;
    /** 'P. RAMAN' — what the byline under a row shows. */
    shortName: string;
    /** Exec title, uppercased. Null for an author who is not on the exec. */
    role: string | null;
    avatarUrl: string | null;
  } | null;
}

/** Marks a post read once it has actually been on screen.
 *
 *  Scroll position, not page load: the unread count in the tab bar is meant to
 *  mean "there is something here you have not seen", and marking everything
 *  read the moment the route renders would make it mean "you opened the page".
 *  Both the pinned notice and the month rows use this — a pinned post that
 *  never cleared its unread state would keep the badge lit forever.
 */
function useMarkReadOnView<T extends HTMLElement>(id: string, isRead: boolean) {
  const ref = useRef<T>(null);
  const markedRef = useRef(false);

  useEffect(() => {
    if (isRead || markedRef.current) return;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[0];
        if (entry?.isIntersecting && !markedRef.current) {
          markedRef.current = true;
          markAnnouncementRead(id).catch(() => {});
          observer.disconnect();
        }
      },
      // A long post can be taller than the viewport, and 0.6 of it can never
      // intersect — so this fires on any part of it being visible instead.
      { threshold: 0.01 },
    );
    const el = ref.current;
    if (el) observer.observe(el);
    return () => observer.disconnect();
  }, [id, isRead]);

  return ref;
}

/** The one card on this screen. A pinned post is the thing the exec wants read
 *  before anything else, so it keeps the surface, the border and the red spine
 *  that the rows below deliberately do without. */
export function PinnedNotice({ post, isRead }: { post: NewsPost; isRead: boolean }) {
  const ref = useMarkReadOnView<HTMLDivElement>(post.id, isRead);

  return (
    <div ref={ref} className="card-base news-pin">
      <div className="news-pin-top">
        <span className="news-pin-flag">PINNED</span>
        <span className="news-stamp">{post.stamp}</span>
      </div>
      <h2 className="news-pin-title">{post.title}</h2>
      <p className="news-body">{post.body}</p>
      {post.author && (
        <div className="news-pin-foot">
          <AvatarChip name={post.author.name} id={post.author.id} src={post.author.avatarUrl} size="sm" />
          <div style={{ minWidth: 0 }}>
            <div className="news-pin-name">{post.author.name}</div>
            {post.author.role && <div className="news-pin-role">{post.author.role}</div>}
          </div>
        </div>
      )}
    </div>
  );
}

/** A post in the month list. Not a card: a stack of cards turns a term's worth
 *  of notices into more border than text, and hairline-ruled rows read as the
 *  one list they are — the same shape the feed's river uses. */
export function AnnouncementRow({ post, isRead }: { post: NewsPost; isRead: boolean }) {
  const ref = useMarkReadOnView<HTMLElement>(post.id, isRead);

  return (
    <article ref={ref} className="news-row">
      <div className="news-row-top">
        <Badge variant={post.tone} className="news-badge">{post.category}</Badge>
        <span className="news-stamp">{post.stamp}</span>
      </div>
      <h2 className="news-headline">{post.title}</h2>
      <p className="news-body">{post.body}</p>
      {post.author && (
        <div className="news-byline">
          <AvatarChip name={post.author.name} id={post.author.id} src={post.author.avatarUrl} size="xs" />
          <span>
            {post.author.shortName}
            {post.author.role && <> · {post.author.role}</>}
          </span>
        </div>
      )}
    </article>
  );
}
