# Building it

## Prerequisites

- A JDK 17 installed: the build pins a Java 17 toolchain (`jvmToolchain(17)`).
- The Android SDK with platform 36. Android Studio is optional; the Gradle wrapper
  (Gradle 9.7.0) is committed and does everything from the command line.

## Configure

```
cd apps/mobile/android
cp local.properties.example local.properties   # then fill in all three values
```

`local.properties` is gitignored. It holds `sdk.dir` and the two public Supabase
values, `badminton.supabaseUrl` and `badminton.supabaseAnonKey`: the same URL and
anon key the player web app ships to every browser. Never the service role key. For
CI either can be passed as a Gradle property of the same name instead
(`-Pbadminton.supabaseUrl=...`).

A missing value still builds, as an empty string, and the app shows a configuration
screen rather than starting. The URL must be https for the same reason: the session
tokens ride on every request. A local Supabase stack on http needs an https tunnel
in front of it before the app will talk to it.

## Gates

```
./gradlew testDebugUnitTest lintDebug assembleRelease
```

Unit tests are plain JVM tests (no device). Lint aborts on any error, release builds
included. The release build is minified and resource shrunk with R8, so it is where a
missing keep rule would show. There is no signing config yet, so the release APK is
**unsigned** and cannot be installed as is; `assembleDebug` builds a debug-signed
APK instead (`app-debug.apk`).

There is no CI for this directory. Run the gates by hand.

## An emulator on Apple silicon

Not yet done for this app. Should you do it: the app's minSdk is 28 and it targets
36, and the system image must be **arm64-v8a**. An x86_64 image runs under
translation on Apple silicon and is unusably slow.

## Committed, not generated

The Gradle project is hand written and committed. `.gitignore` in `android/` keeps
out `local.properties`, `build/`, `.gradle/`, `.kotlin/`, IDE files, keystores and
built APKs and bundles. The Gradle wrapper jar is committed on purpose.

The application id `com.sfubadminton.app` is permanent once a build reaches Google
Play.

## Deferred past milestone 1

- Passkey sign in (the server side exists, see `02-auth.md`) and Google sign in.
- Any write: challenges, match results, check in, tournament entry, receipt upload.
  Receipts are sent from the website; the Membership tab says so.
- The tournament points ladder tab and the win-rate sort.
- Realtime updates (every screen refreshes by pull to refresh).
- Push notifications.
- The fees feature switch. The web shows the statement only while the switch is on
  (`playerPathVisible('/fees', ...)`); this app shows it to every approved member.
- A launcher icon (the manifest sets none yet) and release signing.
- A minimum version gate (see `04-release-and-versioning.md`).
- CI for this directory.
- iOS.
