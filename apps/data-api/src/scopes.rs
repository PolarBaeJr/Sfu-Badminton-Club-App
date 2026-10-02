// A copy of DATA_API_SCOPES in packages/shared/src/utils/data-api-key.ts, which
// the console mints keys with. tests/scopes.rs checks both this list and the
// vocabulary 00264 enforces in the database, so the three cannot drift apart.

pub const DATA_API_SCOPES: [&str; 6] = [
    "players:read",
    "matches:read",
    "ratings:history:read",
    "seasons:read",
    "tournaments:read",
    "schedule:read",
];
