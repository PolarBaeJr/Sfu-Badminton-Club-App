# auth

Three sign in methods, three different amounts of work.

## Google: no backend change

Native Google sign in returns an ID token; `signInWithIdToken` exchanges it for a
Supabase session. Nothing on the server moves.

## Email code: no backend change, but inherit the quirk

`signInWithOtp` then `verifyOtp`. GoTrue issues a different token TYPE per flow and
the obvious one is wrong: an existing account gets a token typed `recovery`, an
account that has never confirmed its email gets `signup`, and the `type: 'email'` the
documentation suggests matches neither and always fails with "Invalid email
verification type".

`apps/admin/src/lib/auth-otp.ts:23` already encodes the answer as `SIGNIN_OTP_TYPES`
and explains why trying both in turn is safe (a wrong type attempt reads a different
token column and returns not found without consuming the real token). Import that
constant. Do not rediscover it.

## Passkeys: this one needs the server to change

Both verify routes mint the session by calling `generateLink` and redeeming it on a
**cookie writing** server client:

- `apps/player/src/app/api/passkey/login/verify/route.ts:173`
- `apps/admin/src/app/api/passkey/login/verify/route.ts:221`

A phone app has no cookie jar, so the route has to return the access and refresh
tokens in the response body instead. Store them in Keychain on iOS and
EncryptedSharedPreferences on Android, never in plain preferences or AsyncStorage.

Scope this change on its own and review it on its own. It touches shipped
authentication code on both web apps, and the web behaviour must not change.

### A side effect worth knowing about

GoTrue records that `generateLink` call as `user_recovery_requested` even though no
email is ever sent. Measured on production 2026-09-21, that accounts for 30 of the 64
rows carrying that action, against 24 real emailed sign in codes and 10 codes
requested and never used. Anything reporting on authentication has to separate them
or it reads as "64 people forgot their password", which never happened.
`scripts/auth-log-export.sh` carries the query that splits them.
