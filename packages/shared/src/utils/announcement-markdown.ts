// The announcement body, with its formatting taken back off.
//
// WHY THIS EXISTS. The console's Body box carries a formatting toolbar
// (apps/admin/src/app/announcements/format-bar.tsx) and the player app renders
// what it writes (apps/player/src/lib/announcement-markdown.tsx). Two
// destinations render NOTHING and never can: the bell row's body, read by
// `notificationHeadline`, and the web push payload, which becomes an OS
// lock-screen notification. Those two are plain strings all the way down, so a
// `**` typed in the composer would reach a phone as two asterisks.
//
// THE SET HERE AND THE SET THERE MUST MATCH. The renderer is the definition of
// what the club's markdown is; this file is the same list with the markers
// removed rather than drawn. A construct added to one belongs in the other on
// the same day, which is why they cross-reference each other by path.

/**
 * How long a preview may be before it is cut, matching the `notifications` row
 * and the push payload that both read it.
 */
export const ANNOUNCEMENT_PREVIEW_MAX = 140;

/** The paired markers, longest first so `**` is consumed before `*`. */
const PAIRED = ['**', '__', '~~', '*', '`'];

/** The line-leading markers, longest first for the same reason. */
const LEADING = ['### ', '## ', '# ', '- ', '* ', '> '];

/**
 * Strip the club's markdown, keeping every character a reader was meant to read.
 *
 * A marker with no partner is left alone rather than deleted: somebody who typed
 * one asterisk on purpose (a footnote, a measurement) keeps it, which is the same
 * call the renderer makes when it refuses to style an unclosed wrapper.
 *
 * A SINGLE `_` IS LEFT ALONE TOO, and that is not an oversight: the renderer
 * deliberately does not italicise `_text_`, because `some_file_name.pdf` is
 * ordinary announcement content. Stripping it here would make the notification
 * and the page disagree about the same body.
 */
export function stripAnnouncementMarkdown(text: string): string {
  return text
    .split('\n')
    .map((line) => {
      let out = line;
      for (const marker of LEADING) {
        if (out.startsWith(marker)) {
          out = out.slice(marker.length);
          break;
        }
      }
      return stripPaired(out);
    })
    .join('\n');
}

/**
 * The paired markers, one left-to-right pass per line.
 *
 * LINE-BOUNDED, exactly like the renderer's scan: a closer has to sit on the
 * same line as its opener, so one stray backtick cannot swallow the rest of the
 * post here either.
 */
function stripPaired(line: string): string {
  let out = '';
  let i = 0;

  while (i < line.length) {
    let matched = false;
    for (const marker of PAIRED) {
      if (!line.startsWith(marker, i)) continue;
      const close = line.indexOf(marker, i + marker.length);
      // An absent closer and an empty pair both fall through to the literal
      // characters, which is what the renderer shows for the same input.
      if (close <= i + marker.length) continue;
      const inner = line.slice(i + marker.length, close);
      // Recursed, so `**bold and *italic* both**` comes out as words: the
      // renderer parses inside a wrapper too, and the two must agree. Every call
      // is handed a strictly shorter string, so this always terminates.
      //
      // EXCEPT INSIDE BACKTICKS, which do not recurse for the same reason the
      // renderer does not: code keeps its own asterisks.
      out += marker === '`' ? inner : stripPaired(inner);
      i = close + marker.length;
      matched = true;
      break;
    }
    if (matched) continue;
    out += line[i]!;
    i++;
  }

  return out;
}
