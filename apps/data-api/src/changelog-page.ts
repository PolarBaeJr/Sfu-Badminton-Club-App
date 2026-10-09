import { PAGE_STYLE } from './docs-page.js';

// The public changelog served at /changelog. It shares the documentation
// page's single stylesheet, so the same CSP hash covers both: no other <style>
// block, no style="" attribute and no script.
//
// Newest first. The text is inserted as HTML, so escape any < or >.

const VERSIONS: { version: string; date: string; title: string; items: string[] }[] = [
  {
    version: '0.1.0',
    date: '2026-10-09',
    title: 'First public version',
    items: [
      'Read-only, keyed access to club data. Each key is limited to the scopes it was granted: <code>players:read</code>, <code>matches:read</code>, <code>ratings:history:read</code>, <code>seasons:read</code>, <code>tournaments:read</code> and <code>schedule:read</code>.',
      'Players appear under a pseudonymous <code>player_ref</code> that is different for every consumer.',
      'Roster: <code>/v1/players</code> and <code>/v1/players/:ref</code>.',
      'Matches: <code>/v1/matches</code>, <code>/v1/matches/:match_ref</code>, a player\'s matches, head-to-head (<code>/v1/players/:ref/vs/:other_ref</code>), per-season records and rating history.',
      'Seasons: <code>/v1/seasons</code>, <code>/v1/seasons/:id</code> and standings.',
      'Tournaments: <code>/v1/tournaments</code>, a tournament, and an event with its entrants and draw, including staged events and external teams.',
      'Schedule: <code>/v1/sessions</code> and <code>/v1/events</code> (club events), filtered by <code>from</code> and <code>to</code>.',
      '<code>/health</code> and this API\'s documentation at <code>/documentations</code> need no key.',
      'This changelog at <code>/changelog</code>, also keyless.',
    ],
  },
];

export const CHANGELOG_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>SFU Badminton Data API changelog</title>
<style>${PAGE_STYLE}</style>
</head>
<body>
<main>
<h1>SFU Badminton Data API changelog</h1>
<p class="lede">What changed in each version of the API. The full reference is the <a href="/documentations">documentation</a>.</p>
${VERSIONS.map(
  (v) => `
<section>
<h2 id="v${v.version}">${v.version}: ${v.title}</h2>
<p class="lede">${v.date}</p>
<ul>
${v.items.map((item) => `<li>${item}</li>`).join('\n')}
</ul>
</section>`,
).join('\n')}
<footer><a href="/documentations">Documentation</a> · <a href="https://sfubadminton.com/">SFU Badminton Club</a></footer>
</main>
</body>
</html>
`;
