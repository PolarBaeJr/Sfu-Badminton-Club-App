import { createHash } from 'node:crypto';

// The public documentation page served at /documentations. A module rather
// than a file on disk so the image needs nothing beyond dist/.
//
// It describes what server.ts, auth.ts and rate-limit.ts DO. A drift test in
// __tests__/docs-page.test.ts fails when a route, scope or error code in
// server.ts is missing from this page.
//
// The CSP allows exactly this one stylesheet by hash, so the page must carry
// no other <style> block and no style="" attribute.

const STYLE = `
:root { color-scheme: light dark; --bg: #ffffff; --fg: #1b1f24; --mute: #57606a; --line: #d0d7de; --code-bg: #f3f5f7; --accent: #b5121b; }
@media (prefers-color-scheme: dark) {
  :root { --bg: #0e1116; --fg: #e6edf3; --mute: #9aa4af; --line: #30363d; --code-bg: #161b22; --accent: #ff6b6b; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg); font: 16px/1.6 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif; }
main { max-width: 46rem; margin: 0 auto; padding: 2rem 1.25rem 4rem; }
h1 { font-size: 1.9rem; margin: 0 0 0.25rem; }
h2 { font-size: 1.35rem; margin: 2.5rem 0 0.75rem; padding-top: 0.5rem; border-top: 1px solid var(--line); }
h3 { font-size: 1.05rem; margin: 1.75rem 0 0.5rem; }
p, li { color: var(--fg); }
.lede { color: var(--mute); margin-top: 0; }
a { color: var(--accent); }
code, pre { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.9em; }
code { background: var(--code-bg); padding: 0.1em 0.3em; border-radius: 4px; }
pre { background: var(--code-bg); border: 1px solid var(--line); border-radius: 8px; padding: 0.9rem 1rem; overflow-x: auto; line-height: 1.45; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; width: 100%; margin: 0.75rem 0; font-size: 0.95em; }
th, td { text-align: left; vertical-align: top; border-bottom: 1px solid var(--line); padding: 0.4rem 0.5rem; }
th { color: var(--mute); font-weight: 600; }
nav { border: 1px solid var(--line); border-radius: 8px; padding: 0.75rem 1rem; margin: 1.5rem 0; }
nav ol { margin: 0.25rem 0 0; padding-left: 1.25rem; }
.note { border-left: 3px solid var(--accent); padding: 0.25rem 0 0.25rem 0.9rem; color: var(--mute); }
`;

export const DOCS_STYLE_HASH = `sha256-${createHash('sha256').update(STYLE).digest('base64')}`;

export const DOCS_CSP = [
  "default-src 'none'",
  `style-src '${DOCS_STYLE_HASH}'`,
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

const EXAMPLE_REF = '9ec62d3216c769dacbc45fe6a696ef143669011e13e16e7215f7239bfc576544';
const EXAMPLE_REF_2 = 'deb9f2c86c09c08fc5bc0ecaab85117d6264378ff6c6e71f3d7bb833a8cd748e';

export const DOCS_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="referrer" content="no-referrer">
<title>SFU Badminton Data API</title>
<style>${STYLE}</style>
</head>
<body>
<main>
<h1>SFU Badminton Data API</h1>
<p class="lede">A read-only, key-authenticated JSON feed of pseudonymous player ratings from the SFU Badminton Club.</p>

<nav aria-label="Contents">
<strong>Contents</strong>
<ol>
<li><a href="#purpose">What it is for</a></li>
<li><a href="#base-urls">Base URLs</a></li>
<li><a href="#authentication">Authentication</a></li>
<li><a href="#scopes">Scopes</a></li>
<li><a href="#endpoints">Endpoints</a></li>
<li><a href="#fields">Player fields</a></li>
<li><a href="#errors">Errors and status codes</a></li>
<li><a href="#rate-limits">Rate limits</a></li>
<li><a href="#versioning">Versioning and stability</a></li>
<li><a href="#data-handling">Data handling</a></li>
<li><a href="#contact">Contact</a></li>
</ol>
</nav>

<h2 id="purpose">What it is for</h2>
<p>The API exists to support predicting the outcome of a challenge between two club members. That is the use case it was designed around, and its shape reflects it.</p>
<p>It deliberately carries <strong>no names, emails, Discord handles, phone numbers, avatars, student numbers or member codes</strong>. Every player is identified by a <code>player_ref</code>: a salted hash of their internal id. It is stable across requests, different for every consumer (so datasets from separate keys cannot be joined), and cannot be turned back into a person outside the club. Treat it as an opaque string.</p>
<p>The feed contains active, approved members who have not opted out of published rankings and have not requested deletion of their account. <code>count</code> is the size of that set at the moment of the request; it is not the club's membership. A member who leaves the set simply stops appearing.</p>
<p class="note">Today the club has recorded no rated matches, so every win, loss and matches-played figure is <code>0</code> and <code>/v1/matches</code> is empty. Ratings are assigned by skill tier at signup rather than earned from play. A reasonable baseline is the Elo expectation: <code>P(A beats B) = 1 / (1 + 10 ** ((elo_B - elo_A) / 400))</code>.</p>

<h2 id="base-urls">Base URLs</h2>
<table>
<tr><th>Environment</th><th>Base URL</th></tr>
<tr><td>Production</td><td><code>https://api.sfubadminton.com</code></td></tr>
</table>
<p>All responses except this page are JSON (<code>application/json; charset=utf-8</code>) and are sent with <code>Cache-Control: no-store</code>.</p>

<h2 id="authentication">Authentication</h2>
<p>Every endpoint except <code>/health</code> and this page needs a key, sent in the <code>Authorization</code> header:</p>
<pre><code>Authorization: Bearer sfubad_&lt;43 characters&gt;</code></pre>
<ul>
<li>A key is <code>sfubad_</code> followed by exactly 43 characters from <code>A-Z a-z 0-9 _ -</code>.</li>
<li>The scheme is the word <code>Bearer</code>, exactly one space, then the key. Anything else is treated as a missing key.</li>
<li>Keys are never accepted in the URL. Do not put one in a query string.</li>
</ul>
<p><strong>Getting a key.</strong> A club exec mints one in the Accounts page of the club's admin console, choosing its scopes and an optional expiry. The key is shown exactly once, at creation. The club stores only a hash, so nobody can recover a lost key; it is revoked and a new one issued.</p>
<p><strong>Revocation.</strong> Verification results are cached briefly. A revoked or expired key stops working within 30 seconds. A key that was rejected (for example, used a moment before it was minted) keeps being rejected for up to 5 seconds.</p>

<h2 id="scopes">Scopes</h2>
<p>A key is allowed nothing by default, only the scopes it was granted.</p>
<table>
<tr><th>Scope</th><th>Needed for</th></tr>
<tr><td><code>players:read</code></td><td><code>GET /v1/players</code> and <code>GET /v1/players/:ref</code></td></tr>
<tr><td><code>matches:read</code></td><td><code>GET /v1/matches</code></td></tr>
<tr><td><code>ratings:history:read</code></td><td>Nothing yet. A key may carry it, but the club does not journal rating changes and no endpoint serves rating history.</td></tr>
</table>
<p>A valid key without the needed scope gets <code>403</code>.</p>

<h2 id="endpoints">Endpoints</h2>
<p>Every endpoint answers <code>GET</code> only; any other method, including <code>HEAD</code>, gets <code>405</code>. (This page also answers <code>HEAD</code>.) There are <strong>no query parameters</strong> and <strong>no pagination</strong>: query strings are ignored, and a list endpoint returns the whole set in one response.</p>

<h3 id="health">GET /health</h3>
<p>No key. For uptime checks. <code>version</code> is the service's release version.</p>
<pre><code>curl -s https://api.sfubadminton.com/health</code></pre>
<pre><code>{ "ok": true, "version": "0.1.0" }</code></pre>

<h3 id="players">GET /v1/players</h3>
<p>Requires <code>players:read</code>. Every player in the feed, one object each.</p>
<pre><code>curl -s -H "Authorization: Bearer $SFUBAD_API_KEY" \\
  https://api.sfubadminton.com/v1/players</code></pre>
<pre><code>{
  "season": null,
  "generated_at": "2026-10-02T18:30:12Z",
  "count": 2,
  "players": [
    {
      "player_ref": "${EXAMPLE_REF}",
      "singles_elo": 1150,
      "doubles_elo": 1020,
      "singles_provisional": false,
      "doubles_provisional": true,
      "singles_matches_played": 0,
      "doubles_matches_played": 0,
      "singles_wins": 0,
      "singles_losses": 0,
      "doubles_wins": 0,
      "doubles_losses": 0,
      "updated_at": "2026-09-20T03:15:40Z"
    },
    {
      "player_ref": "${EXAMPLE_REF_2}",
      "singles_elo": 820,
      "doubles_elo": 860,
      "singles_provisional": true,
      "doubles_provisional": true,
      "singles_matches_played": 0,
      "doubles_matches_played": 0,
      "singles_wins": 0,
      "singles_losses": 0,
      "doubles_wins": 0,
      "doubles_losses": 0,
      "updated_at": "2026-09-22T17:02:09Z"
    }
  ]
}</code></pre>
<table>
<tr><th>Field</th><th>Type</th><th>Meaning</th></tr>
<tr><td><code>season</code></td><td>object or null</td><td>Reserved for the club's active season. <strong>Always <code>null</code> today.</strong></td></tr>
<tr><td><code>generated_at</code></td><td>string</td><td>Server time of the response, ISO 8601 UTC to the second, for example <code>2026-10-02T18:30:12Z</code>.</td></tr>
<tr><td><code>count</code></td><td>integer</td><td>Number of objects in <code>players</code>.</td></tr>
<tr><td><code>players</code></td><td>array</td><td>Player objects, described under <a href="#fields">Player fields</a>.</td></tr>
</table>

<h3 id="player">GET /v1/players/:ref</h3>
<p>Requires <code>players:read</code>. One player, the same object shape as an item of <code>players</code> above, with no wrapper. <code>:ref</code> is a <code>player_ref</code> exactly as the list returned it. A ref that is not in your feed, or that is not a <code>player_ref</code> at all, gets <code>404</code>.</p>
<pre><code>curl -s -H "Authorization: Bearer $SFUBAD_API_KEY" \\
  https://api.sfubadminton.com/v1/players/${EXAMPLE_REF}</code></pre>
<pre><code>{
  "player_ref": "${EXAMPLE_REF}",
  "singles_elo": 1150,
  "doubles_elo": 1020,
  "singles_provisional": false,
  "doubles_provisional": true,
  "singles_matches_played": 0,
  "doubles_matches_played": 0,
  "singles_wins": 0,
  "singles_losses": 0,
  "doubles_wins": 0,
  "doubles_losses": 0,
  "updated_at": "2026-09-20T03:15:40Z"
}</code></pre>

<h3 id="matches">GET /v1/matches</h3>
<p>Requires <code>matches:read</code>. <strong>Always empty today</strong>: the club has no rated matches to publish, and the shape of a match object has not been defined yet.</p>
<pre><code>curl -s -H "Authorization: Bearer $SFUBAD_API_KEY" \\
  https://api.sfubadminton.com/v1/matches</code></pre>
<pre><code>{ "generated_at": "2026-10-02T18:30:12Z", "count": 0, "matches": [] }</code></pre>

<h3 id="documentations">GET /documentations</h3>
<p>This page. No key. Also served at <code>/documentations/</code>.</p>

<h2 id="fields">Player fields</h2>
<table>
<tr><th>Field</th><th>Type</th><th>Meaning</th></tr>
<tr><td><code>player_ref</code></td><td>string</td><td>Opaque pseudonym, stable, different per consumer. Currently 64 lowercase hex characters; do not rely on that.</td></tr>
<tr><td><code>singles_elo</code>, <code>doubles_elo</code></td><td>number</td><td>Current rating on each ladder, roughly 400 to 1400. Singles and doubles are separate ladders; do not average them or use one to predict the other.</td></tr>
<tr><td><code>singles_provisional</code>, <code>doubles_provisional</code></td><td>boolean</td><td><code>true</code> while the rating is still settling. A provisional rating is a guess; weight it accordingly or exclude it.</td></tr>
<tr><td><code>singles_matches_played</code>, <code>doubles_matches_played</code></td><td>integer</td><td>Rated matches only.</td></tr>
<tr><td><code>singles_wins</code>, <code>singles_losses</code>, <code>doubles_wins</code>, <code>doubles_losses</code></td><td>integer</td><td>Rated matches only. Wins plus losses need not equal matches played; derive a win rate from wins and losses.</td></tr>
<tr><td><code>updated_at</code></td><td>string</td><td>When the rating row last changed, ISO 8601 UTC to the second.</td></tr>
</table>
<p>All figures are <strong>lifetime</strong> totals, not per season. Only the fields above are ever returned. A field the database has no value for is <code>null</code>, so parse defensively.</p>

<h2 id="errors">Errors and status codes</h2>
<p>Every error is a JSON object with an <code>error</code> string. A <code>403</code> also carries a <code>detail</code> string.</p>
<pre><code>{ "error": "forbidden", "detail": "this key does not carry players:read" }</code></pre>
<table>
<tr><th>Status</th><th><code>error</code></th><th>When</th></tr>
<tr><td><code>200</code></td><td></td><td>Success.</td></tr>
<tr><td><code>401</code></td><td><code>unauthorized</code></td><td>Key missing, malformed, unknown, expired or revoked. Deliberately identical in all five cases, with a <code>WWW-Authenticate: Bearer</code> header.</td></tr>
<tr><td><code>403</code></td><td><code>forbidden</code></td><td>Valid key without the scope this endpoint needs.</td></tr>
<tr><td><code>404</code></td><td><code>not_found</code></td><td>No such route, or a <code>:ref</code> that is unknown or not a <code>player_ref</code>.</td></tr>
<tr><td><code>405</code></td><td><code>method_not_allowed</code></td><td>A method other than <code>GET</code> on an existing route (other than <code>GET</code> or <code>HEAD</code> on this page). The <code>Allow</code> header lists what is accepted.</td></tr>
<tr><td><code>429</code></td><td><code>rate_limited</code></td><td>A rate limit was hit. The <code>Retry-After</code> header gives whole seconds to wait.</td></tr>
<tr><td><code>503</code></td><td><code>unavailable</code></td><td>The club's database could not be reached or answered with an error. Retry later with backoff.</td></tr>
</table>
<p>Checks run in this order: route (<code>404</code>), method (<code>405</code>), key (<code>401</code>, or <code>429</code> from the per-address limit below), per-key rate (<code>429</code>), scope (<code>403</code>), then the player ref (<code>404</code>). So a request without a valid key never learns whether a ref exists, and a request refused for scope still spends one unit of the key's rate budget.</p>

<h2 id="rate-limits">Rate limits</h2>
<ul>
<li><strong>Per key: 60 requests per minute.</strong> A token bucket holding 60, refilling at one per second, so a burst of 60 is allowed and then one request per second.</li>
<li><strong>Per client address: 30 failed key lookups per minute.</strong> Every <code>401</code> spends one, including a missing or malformed header. When the budget is empty, a well-formed key that the server has not checked recently gets <code>429</code> instead of being looked up. A missing or malformed header still gets <code>401</code>, as does a key rejected in the last 5 seconds, and a key verified in the last 30 seconds is not affected by this limit.</li>
<li><code>/health</code> and this page are not rate-limited by key.</li>
<li>The limits are enforced per server process, and the club's network edge applies its own limits in front of them. Do not rely on the exact figures; honour <code>Retry-After</code>.</li>
</ul>
<p>The data changes slowly. Polling every few minutes gains nothing: pull <code>/v1/players</code> on a schedule measured in hours and cache it.</p>

<h2 id="versioning">Versioning and stability</h2>
<p>The <code>/v1</code> prefix is the contract. Within it, new fields may be added, and existing fields will not be removed or change meaning. Ignore fields you do not recognise. A breaking change becomes <code>/v2</code>. This is version 0 of the service; <code>/health</code> reports the running version.</p>

<h2 id="data-handling">Data handling</h2>
<p>This is real data about real people, shared under a named key that identifies who received it.</p>
<ul>
<li>Do not attempt to re-identify players.</li>
<li>Do not redistribute the data or publish it as a dataset.</li>
<li>Keep the key out of version control, URLs and logs.</li>
<li>Tell the club if a key leaks; it will be revoked and reissued.</li>
</ul>

<h2 id="contact">Contact</h2>
<p>For a key, a scope change, a leaked key or a question about the data, contact the club exec, for example through the club Discord at <a href="https://discord.sfubadminton.com">discord.sfubadminton.com</a>.</p>
</main>
</body>
</html>
`;
