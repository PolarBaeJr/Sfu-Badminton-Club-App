import { COMMAND_DEFINITIONS } from './commands.js';

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
// Run manually: `npm run register -w bot`
async function main() {
  const token = process.env.DISCORD_BOT_TOKEN;
  const applicationId = process.env.DISCORD_APPLICATION_ID;

  if (!token || !applicationId) {
    console.error('DISCORD_BOT_TOKEN and DISCORD_APPLICATION_ID must both be set');
    process.exit(1);
  }

  const response = await fetch(
    `https://discord.com/api/v10/applications/${applicationId}/commands`,
    {
      method: 'PUT', // PUT replaces the full set, so removals take effect too.
      headers: {
        authorization: `Bot ${token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(COMMAND_DEFINITIONS),
    }
  );

  if (!response.ok) {
    console.error(`Registration failed: ${response.status}`);
    console.error(await response.text());
    process.exit(1);
  }

  const registered = (await response.json()) as { name: string }[];
  console.log(`Registered ${registered.length}: ${registered.map((c) => c.name).join(', ')}`);
}

main();
