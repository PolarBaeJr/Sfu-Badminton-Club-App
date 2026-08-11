// The floor for the typed reason on an audited /legal action.
//
// Its own module rather than a const in actions/settings.ts because that file
// is `'use server'`, where every export must be an async function — a plain
// constant there is a build error. Both halves import this one: the server
// action rejects anything shorter (the boundary), and the form disables the
// publish buttons against the same number so the rejection never has to
// happen. Two hardcoded 10s would drift the moment one moved.
//
// Long enough that "x" and "typo" do not pass, short enough that "fixed s3
// wording" does.
export const MIN_REASON_LENGTH = 10;
