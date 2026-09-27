# Android app

The native Android app: Kotlin, Jetpack Compose, application id
`com.sfubadminton.app`. Building and configuring it is in
`../docs/05-development.md`; how it signs in and keeps a session is in
`../docs/02-auth.md`.

| | |
|---|---|
| Gradle | 9.7.0 (wrapper) |
| Android Gradle Plugin | 9.3.1 |
| Kotlin | 2.4.20 |
| compileSdk / targetSdk / minSdk | 36 / 36 / 28 |
| Compose BOM | 2026.06.01 |
| Lifecycle | 2.10.0 |

Compose and lifecycle are held at those versions because their next releases need
compileSdk 37.

Libraries are kept few on purpose: Compose, activity and lifecycle, coroutines and
kotlinx.serialization. No Supabase SDK and no HTTP client library; networking is
`HttpURLConnection`. The unsigned release APK is about 2.4 MB (about 1.2 MB to
download).

It has not yet been run on a device or emulator.

## Before it can ship

1. A Google Play Console account, 25 USD once. Same governance question as iOS: see
   `../ios/README.md`.
2. Release signing. The upload key is a secret and never lands in this repo, which is
   public.
3. For passkeys, `https://sfubadminton.com/.well-known/assetlinks.json` listing the
   package name and **every** signing certificate SHA-256: debug, upload key and Play
   App Signing. The route that serves it is on `feat/passkey-native-app`; see
   `../docs/02-auth.md`.
