# Running it

## Install

From this directory, never the repository root (see the README for why):

```
cd apps/mobile
npm prefix          # must print .../apps/mobile
npm install
cp .env.example .env.local   # then fill in both values
```

Both values are public: the same URL and anon key the player web app ships to every
browser. The URL must be https; the app shows a configuration screen rather than start
against plain http, because the session tokens ride on every request. A local Supabase
stack on http therefore needs an https tunnel in front of it before the app will talk
to it.

## An Android emulator on Apple silicon

Command line only, no Android Studio needed. Install the command line tools (for
example `brew install --cask android-commandlinetools`), then:

```
export ANDROID_HOME="$HOME/Library/Android/sdk"
sdkmanager --sdk_root="$ANDROID_HOME" "platform-tools" "emulator" \
  "platforms;android-<api>" "system-images;android-<api>;google_apis;arm64-v8a"
avdmanager create avd -n badminton -d pixel_8 \
  -k "system-images;android-<api>;google_apis;arm64-v8a"
"$ANDROID_HOME/emulator/emulator" -avd badminton
```

`<api>` is the Android API level the current Expo SDK targets; read it off the SDK's
release notes rather than guessing. The image must be **arm64-v8a**: an x86_64 image
runs under translation on Apple silicon and is unusably slow.

## Expo Go now, a development build later

```
npm run android     # expo start --android: opens the app in Expo Go on the emulator
```

Milestone 1 runs in **Expo Go**, which already contains every native module it uses
(secure store, screens, safe area). That is why there is no `android/` project yet and
why `expo prebuild` has not been run.

A **development build** (the app's own native binary) becomes necessary for:

- **Passkeys.** Native passkeys go through Android's Credential Manager, which needs a
  native module Expo Go does not carry, and a real application id for
  `assetlinks.json` to name. See `02-auth.md`.
- **Push.** FCM needs the app's own `google-services.json` and package name. See
  `03-push.md`.
- **Asset links and deep links** of any kind, for the same application id reason.

The application id in `app.config.ts` is a placeholder until the owner picks one. It
is permanent once a build reaches Google Play.

## Undecided: generated or committed native projects

Continuous Native Generation (`expo prebuild` regenerates `android/` from
`app.config.ts` on every build, nothing native committed) against committing
`android/` and editing it by hand. `.gitignore` currently ignores everything under
`android/` and `ios/` except their READMEs, which keeps both options open. Decide
before the first development build.

## Deferred past milestone 1

- Passkeys and Google sign in (email code only today).
- Any write: challenges, match results, check in, tournament entry, receipt upload.
  Receipts are sent from the website; the Membership tab says so.
- The tournament points ladder tab and the win-rate sort.
- Realtime updates (every screen refreshes by pull to refresh).
- Push notifications.
- The fees feature switch. The web shows the statement only while the switch is on
  (`playerPathVisible('/fees', ...)`); this app shows it to every approved member.
- A minimum version gate (see `04-release-and-versioning.md`).
- CI for this directory.
- iOS.
