import { putCommandSet, scopeLabel } from './register-commands.js';

// Registers slash commands GLOBALLY.
//
// Global, not per-guild, because the bot is multi-guild: guild-scoped commands
// would have to be re-registered on every new server it joins. Global commands
// can take up to an hour to propagate the first time, which is worth knowing
// before concluding a deploy failed.
//
// `autocomplete: true` IS PART OF THE STORED DEFINITION, not something the bot
// decides at runtime. Deploying the handler alone changes nothing: Discord will
// not send an autocomplete interaction for an option it has not been told is
// one, so /profile's handle picker stays inert until this runs again — and then
// for up to an hour more while the global registration propagates.
//
// UNLESS DISCORD_DEV_GUILD_ID IS SET, in which case the same set is registered
// to that one guild instead — which Discord applies IMMEDIATELY.
//
// Worth the branch because the alternative has cost this project real time
// twice: a new command is deployed, does not appear, and the hour of global
// propagation is indistinguishable from a registration that failed. A guild
// registration is a separate list from the global one, so a test server ends up
// showing both copies until the global set catches up — untidy, and much better
// than debugging the wrong layer.
//
// Run manually: `npm run register -w bot`
//
// THIS FILE IS ONLY THE COMMAND-LINE WRAPPER now. The request lives in
// register-commands.ts, shared with the bot's own startup, which registers the
// same set on a prod deploy when REGISTER_COMMANDS_ON_BOOT is set - see that
// file's header. Running this by hand still works exactly as it always has,
// and still writes UNCONDITIONALLY: a human typing the command has a reason,
// and the comparison the boot path does would only stand between them and it.
async function main() {
  const token = process.env.DISCORD_BOT_TOKEN;
  const applicationId = process.env.DISCORD_APPLICATION_ID;
  const devGuildId = process.env.DISCORD_DEV_GUILD_ID;

  if (!token || !applicationId) {
    console.error('DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID must both be set');
    process.exit(1);
  }

  const result = await putCommandSet({ token, applicationId, devGuildId });

  if (!result.ok) {
    console.error(`Registration failed: ${result.status}`);
    console.error(result.body);
    process.exit(1);
  }

  console.log(
    `Registered ${result.registered.length} ${scopeLabel(devGuildId)}: ` +
      result.registered.map((c) => c.name).join(', ')
  );
}

main();
