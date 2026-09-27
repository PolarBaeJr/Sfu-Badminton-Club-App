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
| Credential Manager (androidx.credentials) | 1.6.0 |

Compose and lifecycle are held at those versions because their next releases need
compileSdk 37.

Libraries are kept few on purpose: Compose, activity and lifecycle, coroutines,
kotlinx.serialization, and Credential Manager for passkey sign-in. No Supabase SDK
and no HTTP client library; networking is `HttpURLConnection`.

Credential Manager needs `credentials-play-services-auth` on API 33 and below
(minSdk is 28), which brings Play services auth, FIDO and fragment with it;
`credentials` 1.6.0 itself brings biometric, and with it appcompat. That is the
passkey cost: the unsigned release APK went from about 2.4 MB to about 3.2 MB
(about 1.2 MB to 1.6 MB to download). None of it starts with the app: the merged
manifest gains no content provider or startup initializer, and Credential
Manager is created only when a member taps the passkey button.

The website's fonts cost about 148 KiB more to download. The unsigned release APK
went from 3,174,477 to 3,362,620 bytes on disk and from 1,557,102 to 1,708,699
bytes to download (apkanalyzer), a rise of 151,597 bytes. Nearly all of it is the
five latin-only TTFs in `res/font` (compressed in the APK: Barlow 400, 600 and 700
about 19 KB each, Barlow Condensed 700 about 18 KB, the variable JetBrains Mono
about 37 KB); the vector icons and the licence texts in `assets/licenses` are a
few KB. Where the fonts come from is in `../assets/fonts/README.md`.

It runs on the emulator against staging. The restyled sign-in screen, launcher
icon and cold start have been checked there; the restyled signed-in screens have
not been checked on a device yet.

## Before it can ship

1. A Google Play Console account, 25 USD once. Same governance question as iOS: see
   `../ios/README.md`.
2. Release signing. The upload key is a secret and never lands in this repo, which is
   public.
3. For passkeys, `https://<rpId>/.well-known/assetlinks.json` (for production,
   `https://sfubadminton.com`) listing the package name and **every** signing
   certificate SHA-256: debug, upload key and Play App Signing. The route that
   serves it is on `feat/passkey-native-app`; see `../docs/02-auth.md`. The release
   build also needs `badminton.siteUrl` set, or it offers no passkey button.
