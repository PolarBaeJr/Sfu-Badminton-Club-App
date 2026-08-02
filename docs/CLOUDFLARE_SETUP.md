# Cloudflare DNS Setup for SFU Badminton Platform

> **Current setup:** the apps are **self-hosted on a Raspberry Pi**, behind
> Cloudflare. They are no longer on Vercel. An earlier version of this document
> told you to point DNS at Vercel's anycast IP (`76.76.21.21`) — following that
> today takes the site offline, which is why it has been rewritten.

## Architecture

```
browser → Cloudflare (proxied) → Raspberry Pi → proxy-manager → player / admin containers
```

Both apps are served from **one hostname**: the player app at the apex, the
admin console under `/admin`. There is no separate `admin.` subdomain and no
per-app DNS record — `proxy-manager` routes by container label, not by DNS.

## 1. Domain and nameservers

1. Create a free account at [cloudflare.com](https://www.cloudflare.com), click
   **Add a Site**, enter the domain (`sfubadminton.com`), pick the **Free** plan.
2. Cloudflare gives you two nameservers, e.g. `aria.ns.cloudflare.com`.
3. At the registrar, set **Custom DNS** to those two nameservers.
4. Wait for propagation (usually under an hour), then **Check Nameservers**.

## 2. DNS records

In **DNS > Records**:

| Type | Name | Content | Proxy | TTL |
|------|------|---------|-------|-----|
| A | `@` | *the Pi's public IP* | Proxied (orange cloud) | Auto |
| TXT/MX | `mail`, `send.` etc. | *as issued by Resend* | **DNS only** (grey) | Auto |

**Keep the apex record proxied (orange).** That is what gives DDoS protection
and hides the Pi's home IP. It is also what puts `cf-connecting-ip` on every
request — the app's rate limiting reads that header to identify clients, so
turning the proxy off would collapse every visitor into a single bucket.

**Mail records must stay DNS-only (grey).** Those are the Resend DKIM/SPF
records that carry auth email (sender: `login@mail.sfubadminton.com`);
proxying them breaks delivery.

## 3. SSL/TLS

Set **SSL/TLS > Overview** to **Full (strict)**.

- Browser → Cloudflare is encrypted.
- Cloudflare → Pi is encrypted, and Cloudflare validates the origin certificate.
- `proxy-manager` obtains and renews the origin certificate automatically.

> Do **not** use "Flexible" — that leaves the Cloudflare→Pi hop unencrypted.

## 4. Adding an app to the proxy

Routing is by Docker label, not DNS. The player and admin services already carry
these in `docker-compose.yml`; a new service needs the same, plus joining the
external `edge` network:

```yaml
labels:
  proxy.enable:  "true"
  proxy.host:    "sfubadminton.com"
  proxy.port:    "3000"
  proxy.service: "badminton-player"
```

`PROXY_DOMAIN` in the Pi's `.env` sets the served hostname. The proxy picks up
changes within seconds of `docker compose up -d` — no nginx config to edit.

## 5. Verify

1. `https://sfubadminton.com` → player app, padlock valid.
2. `https://sfubadminton.com/admin` → admin console (redirects to login).
3. A **`522`** means Cloudflare is healthy but the **Pi is unreachable** — check
   the Pi, not DNS.
4. Cloudflare **Analytics** should show traffic flowing through the proxy.
