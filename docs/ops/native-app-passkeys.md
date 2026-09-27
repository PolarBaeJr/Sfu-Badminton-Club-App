# Native app passkeys

How the native Android and iOS apps sign in with the same passkeys members
already use on the website, and what the owner has to configure for it.

No migration is involved. The web sign-in routes behave exactly as before.

## Routes

All in the player app, all public in middleware (they create a session, so
they cannot require one), all under the edge rate limit on the `/api/passkey`
prefix (see `rate-limits.md`).

| route | purpose |
| --- | --- |
| `POST /api/passkey/app/login/options` | mint a challenge for the app |
| `POST /api/passkey/app/login/verify` | verify an assertion, return session tokens |
| `GET /.well-known/assetlinks.json` | Android trust file, built from env |
| `GET /.well-known/apple-app-site-association` | iOS trust file, built from env |

The web pair (`/api/passkey/login/options` and `/verify`) is unchanged and does
not accept any Android origin. Both verify routes share one implementation,
`apps/player/src/lib/passkey/login-assertion.ts`.

## Token contract

### Options

Request: `POST`, no body.

Response `200`, `Cache-Control: no-store`, no cookie:

```json
{ "options": { "challenge": "...", "rpId": "...", "allowCredentials": [], "...": "..." },
  "challengeToken": "<opaque>" }
```

Pass `options` to Credential Manager (Android) or
`ASAuthorizationPlatformPublicKeyCredentialProvider` (iOS). Keep
`challengeToken` and send it back unchanged. It expires after 5 minutes.

`503 { "error": "Passkeys are not configured" }` when the server has no
`PASSKEY_COOKIE_SECRET`. Treat it as "passkeys unavailable", not as a fault.

### Verify

Request: `POST`, JSON body:

```json
{ "credential": { "id": "...", "rawId": "...", "type": "public-key", "response": { "...": "..." } },
  "challengeToken": "<from options>" }
```

`credential` is the standard WebAuthn `AuthenticationResponseJSON`.

Response `200`, `Cache-Control: no-store`, no cookie:

```json
{ "access_token": "...", "refresh_token": "...", "expires_in": 3600,
  "expires_at": 1790000000, "token_type": "bearer" }
```

This is an ordinary Supabase session. Hand it to supabase-js / supabase-kt /
supabase-swift with `setSession` and let the client refresh it from there.

Every failure is `{ "error": "Passkey sign-in failed" }`, with status `400`
(anything the caller got wrong, or a signature that does not verify), `403`
(the account is banned) or `500` (the server could not mint the session). The
message is deliberately the same for all of them.

### Rules for the app

- **Fetch fresh options for every attempt.** The challenge is single-use and
  claimed server side before anything is verified (00181), so a failed attempt
  burns it. Retrying verify with the same `challengeToken` always fails.
- A web challenge cookie is not accepted here, and an app `challengeToken` is
  not accepted by the web route: they are signed with different types.
- Never log either token or the session.

## Origins the app route accepts

- the web origin (`NEXT_PUBLIC_APP_URL`)
- `https://<rpId>` (`NEXT_PUBLIC_PASSKEY_RP_ID`). This is there for native iOS
  assertions, which carry the RP ID's origin. It comes from Apple's
  documentation, not from a captured assertion: confirm it against a real one
  once the Swift app exists.
- `android:apk-key-hash:<base64url of the SHA-256 cert digest, no padding>`, one
  per fingerprint in `PASSKEY_ANDROID_CERT_SHA256`.

Matching is exact. A missing fingerprint fails every sign-in from builds signed
with that key, with the generic message and nothing more specific in the logs.

## Environment

Runtime, server-only, player app only. Set through the dashboard like the rest
of the player env; no rebuild is needed because none is `NEXT_PUBLIC_`.

| variable | value |
| --- | --- |
| `PASSKEY_ANDROID_CERT_SHA256` | comma-separated SHA-256 fingerprints, colon hex |
| `PASSKEY_ANDROID_PACKAGE` | application id; empty means `com.sfubadminton.app` |
| `PASSKEY_IOS_APP_IDS` | comma-separated `TEAMID.bundle.id` |

Case and colons in fingerprints are normalised. Entries that are not exactly
32 bytes (a SHA-1, most likely) are dropped with one warning that does not
repeat the value. iOS ids that do not look like `TEAMID.bundle.id` are dropped.

With all three empty the well-known files answer `404` and nothing about the
site changes.

## Owner steps

1. Collect the SHA-256 fingerprints:
   - debug: `keytool -list -v -keystore ~/.android/debug.keystore -alias androiddebugkey -storepass android -keypass android`
   - upload key: the same command against the upload keystore
   - Play App Signing: Play Console, the app, Test and release, App integrity,
     App signing, "App signing key certificate"
2. Set `PASSKEY_ANDROID_CERT_SHA256` (all of them, comma-separated) and, if the
   application id is not the default, `PASSKEY_ANDROID_PACKAGE`, on the player
   service for the environment being tested (staging first).
3. For iOS, set `PASSKEY_IOS_APP_IDS` once the app has a team and bundle id,
   and add `webcredentials:<host>` to the app's Associated Domains.
4. Check both files are served directly, with no redirect:

   ```sh
   curl -i https://<host>/.well-known/assetlinks.json
   curl -i https://<host>/.well-known/apple-app-site-association
   ```

   Expect `200`, `Content-Type: application/json`, and no `Location` header.
   Check through the public entrance, because that is what Google and Apple
   fetch.
5. Optionally, confirm Google agrees with Google's Digital Asset Links API
   (`digitalassetlinks.googleapis.com/v1/statements:list`) for the host and the
   `delegate_permission/common.get_login_creds` relation.
