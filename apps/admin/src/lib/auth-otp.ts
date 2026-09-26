// Moved to packages/shared/src/utils/auth-otp.ts so the player app's sign-in
// and signup pages use the same rules. Re-exported here so the console's
// imports and its tests stay as they were.
export { SIGNIN_OTP_TYPES, shouldTryNextOtpType, isUnknownAccountError } from '@badminton/shared';
