# iOS app expansion

Empty. The native iOS project is generated, not hand written, so nothing is committed
here until the app is initialised.

What will live here once it is:

- the Xcode project and workspace
- `Info.plist`, entitlements, and the **associated domains** entitlement
  (`webcredentials:sfubadminton.com`) that native passkeys require
- signing configuration and the provisioning profile reference

## Before this directory can be filled

1. An Apple Developer Program membership, 99 USD per year. Who owns it is a
   governance question, not a technical one: the club's exec turns over annually and
   an account tied to one student leaves with them.
2. `https://sfubadminton.com/.well-known/apple-app-site-association`, served as
   `application/json` with **no** `.json` extension and no redirect. The RP ID must
   match the one the existing web passkeys were registered against, or every enrolled
   passkey is invisible to the app.
3. The passkey token change described in `../README.md`. Until the verify route can
   return tokens instead of writing a cookie, there is no way to hold a session here.
