# iOS app

Not started. The iOS app will be native Swift and SwiftUI, a separate codebase from
the Kotlin Android app in `../android/`, not generated from it.

What it will need:

- An Apple Developer Program membership, 99 USD per year. Who owns it is a
  governance question, not a technical one: the club's exec turns over annually and
  an account tied to one student leaves with them.
- The **associated domains** entitlement (`webcredentials:sfubadminton.com`) for
  native passkeys, and
  `https://sfubadminton.com/.well-known/apple-app-site-association` served as
  `application/json` with no redirect. The RP ID must match the one the existing web
  passkeys were registered against, or every enrolled passkey is invisible to the
  app. A route for that file is on branch `feat/passkey-native-app`.
- Session tokens in the Keychain. The token-returning passkey routes described in
  `../docs/02-auth.md` serve iOS as well as Android.
- Its own port of the shared rules the Android app ports into Kotlin (see
  `../README.md`), kept in step the same way.
