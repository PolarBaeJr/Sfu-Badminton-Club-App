# Android app expansion

Empty. The native Android project is generated, not hand written, so nothing is
committed here until the app is initialised.

What will live here once it is:

- the Gradle project, `AndroidManifest.xml`
- the Digital Asset Links intent filter that native passkeys require
- signing configuration (the upload key is a secret and never lands in this repo,
  which is public)

## Before this directory can be filled

1. A Google Play Console account, 25 USD once. Same governance question as iOS: see
   `../ios/README.md`.
2. `https://sfubadminton.com/.well-known/assetlinks.json`, carrying the app's package
   name and the signing certificate SHA-256 fingerprint. Credential Manager reads it
   over the network, so it must be reachable without a redirect.
3. The passkey token change described in `../README.md`.

Note that the signing fingerprint differs between a local build and Play App Signing.
`assetlinks.json` has to list both, or passkeys work in testing and fail in
production, which is the classic way this is discovered late.
