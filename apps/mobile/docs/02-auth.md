# Auth: the infrastructure half

The three sign in flows and their code level details are in
`../src/lib/auth/README.md`. This file covers what has to exist outside the app
before any of them work.

## Associated domain files

Native passkeys are bound to a domain, and the binding is verified over the network
at sign in time. Both files must be served from `sfubadminton.com`, the production
domain, and must not redirect.

| Platform | Path | Notes |
|---|---|---|
| Android | `/.well-known/assetlinks.json` | package name plus the signing certificate SHA-256 |
| iOS | `/.well-known/apple-app-site-association` | `application/json`, no `.json` extension |

Two ways this goes wrong late:

1. **The RP ID must match what the existing web passkeys were registered against.**
   If it does not, every passkey already enrolled is invisible to the app, and it
   presents as "passkeys just do not work on mobile" rather than as a configuration
   error.
2. **Android signs differently locally and under Play App Signing.** List both
   fingerprints in `assetlinks.json`, or passkeys work throughout testing and fail
   the moment the app ships.

Note that `badminton.polardev.org` is staging and `sfubadminton.com` is production.
These files belong to production. Serving them from the staging host proves nothing.

## Token storage

Sessions are tokens, not cookies. Keychain on iOS, EncryptedSharedPreferences on
Android. Never AsyncStorage or plain preferences: both are readable on a rooted or
jailbroken device and a refresh token is a long lived credential.

The web cookie name is pinned and must never be renamed, but it is irrelevant here.
This app never sees it.
