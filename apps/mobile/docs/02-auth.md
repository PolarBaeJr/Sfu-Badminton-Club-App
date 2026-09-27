# Auth

## Email code: what the app does today

`auth/EmailCode.kt` ports the player web app's email code client
(`apps/player/src/lib/email-code-client.ts`).

- **Send** calls GoTrue `/otp` with `create_user: false`, so only an existing
  account gets a code. Accounts are created on the website, where the waivers are.
  A send that fails the way an idle auth gateway fails is retried once, silently.
- **Verify** tries each OTP type GoTrue may have issued, then makes the web login's
  check: no `players_self` row means an account that never finished signing up. That
  session is logged out on this device, never kept, and the sign-in screen says why.

## Token storage

Sessions are tokens, not cookies. The web cookie name is pinned and must never be
renamed, but this app never sees it.

The session is one file, `session.bin` in the app's private files directory:

- AES-256-GCM under a key in the **Android Keystore** that never leaves it. No user
  authentication on the key: a routine launch must refresh a token without asking
  for a fingerprint. EncryptedSharedPreferences is not used (androidx
  security-crypto is deprecated).
- Written through `AtomicFile`, so a crash mid write never leaves a torn file.
- Excluded from cloud backup and device transfer, and `allowBackup` is false. A copy
  on another phone could not be decrypted anyway.
- Anything that cannot be decrypted or parsed is deleted and reads as signed out.

## Refresh

`auth/SessionManager.kt` is the one owner of the session. Every token read refreshes
first if the token is within 90 seconds of expiry.

Refresh is **single flight** behind a mutex, because GoTrue rotates the refresh token
on use: two refreshes racing with the same token would have the second refused and
sign the member out. The new session is written to disk before it is published, so a
process killed in between never wakes holding a spent refresh token.

A 4xx from the refresh grant ends the session. Anything else (offline, a gateway 5xx)
keeps it for the next attempt. The app also refreshes when it returns to the
foreground.

## Passkeys: server side built, app side not yet

The server half exists on branch `feat/passkey-native-app` (not merged here):

- `POST /api/passkey/app/login/options` returns the WebAuthn options with a signed
  `challengeToken` in the body instead of a cookie.
- `POST /api/passkey/app/login/verify` takes the credential and that token and
  returns the Supabase session tokens in the body. The challenge is single use and a
  failed attempt burns it, so the app must fetch fresh options for every attempt.
- `/.well-known/assetlinks.json` is built from `PASSKEY_ANDROID_CERT_SHA256`
  (comma separated signing certificate fingerprints) and `PASSKEY_ANDROID_PACKAGE`
  (empty means `com.sfubadminton.app`). With no fingerprint it answers 404.

The Android app does not call any of them yet. The next step is passkey sign-in
through Android's Credential Manager against those two routes, storing the returned
tokens exactly as the email code flow does. Operating detail is in
`docs/ops/native-app-passkeys.md` on that branch.

Two ways this goes wrong late:

1. **The RP ID must match what the existing web passkeys were registered against.**
   If it does not, every passkey already enrolled is invisible to the app, and it
   presents as "passkeys just do not work on mobile" rather than as a configuration
   error.
2. **Every signing certificate must be listed.** The debug keystore, the upload key
   and Play App Signing's key all sign installable builds. A missing fingerprint
   makes passkeys work throughout testing and fail the moment the app ships.

These files belong to production, `sfubadminton.com`, and must not redirect. Serving
them from staging proves nothing.
