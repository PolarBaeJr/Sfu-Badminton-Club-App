# Cloudflare DNS Setup for SFU Badminton Platform

## 1. Buy a Domain on Namecheap

1. Go to [namecheap.com](https://www.namecheap.com) and search for your desired domain (e.g., `sfubadminton.club`).
2. Add it to cart and complete the purchase.
3. After purchase, go to **Dashboard > Domain List** and click **Manage** on your new domain.

## 2. Point Nameservers to Cloudflare

1. Create a free account at [cloudflare.com](https://www.cloudflare.com).
2. Click **Add a Site** and enter your domain name (e.g., `sfubadminton.club`).
3. Select the **Free** plan.
4. Cloudflare will provide you two nameservers, for example:
   - `aria.ns.cloudflare.com`
   - `logan.ns.cloudflare.com`
5. Go back to **Namecheap > Domain List > Manage** for your domain.
6. Under **Nameservers**, select **Custom DNS** from the dropdown.
7. Enter the two Cloudflare nameservers and click the green checkmark to save.
8. Wait for propagation (can take up to 24 hours, usually under 1 hour).
9. Back in Cloudflare, click **Check Nameservers** to verify.

## 3. Add DNS Records for Vercel

In the Cloudflare dashboard, go to **DNS > Records** and add the following:

### Player App (e.g., `app.sfubadminton.club`)

| Type | Name | Content | Proxy | TTL |
|------|------|---------|-------|-----|
| A | `app` | `76.76.21.21` | Proxied (orange cloud) | Auto |

### Admin App (e.g., `admin.sfubadminton.club`)

| Type | Name | Content | Proxy | TTL |
|------|------|---------|-------|-----|
| CNAME | `admin` | `cname.vercel-dns.com` | Proxied (orange cloud) | Auto |

> **Note:** The A record IP `76.76.21.21` is Vercel's anycast IP. The CNAME `cname.vercel-dns.com` is Vercel's recommended CNAME target.

## 4. Enable Cloudflare Proxying (Orange Cloud)

When adding DNS records above, make sure the **Proxy status** toggle is enabled (orange cloud icon). This routes traffic through Cloudflare's network, providing:

- DDoS protection
- CDN caching of static assets
- Web Application Firewall (WAF)
- Analytics

To verify: in **DNS > Records**, both records should show an orange cloud icon, not a grey one.

## 5. Configure SSL/TLS to Full (Strict)

1. In the Cloudflare dashboard, go to **SSL/TLS > Overview**.
2. Set the encryption mode to **Full (strict)**.

This ensures:
- Cloudflare encrypts traffic between visitors and Cloudflare (browser to edge).
- Cloudflare encrypts traffic between Cloudflare and Vercel (edge to origin).
- Cloudflare validates Vercel's SSL certificate, preventing MITM attacks.

> **Important:** Do not use "Flexible" mode. This would leave the Cloudflare-to-Vercel connection unencrypted. Vercel provides free SSL certificates, so Full (strict) works out of the box.

## 6. Configure Vercel Domains

1. In your Vercel dashboard, go to each project's **Settings > Domains**.
2. For the player app: add `app.sfubadminton.club`.
3. For the admin app: add `admin.sfubadminton.club`.
4. Vercel will automatically provision SSL certificates for both subdomains.

## 7. Verify Everything Works

1. Visit `https://app.sfubadminton.club` -- should load the player app.
2. Visit `https://admin.sfubadminton.club` -- should load the admin app.
3. Check that the padlock icon appears in the browser (valid SSL).
4. In Cloudflare **Analytics**, confirm traffic is flowing through the proxy.
