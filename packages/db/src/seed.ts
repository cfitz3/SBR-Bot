/**
 * `npm run db:seed` — register this Discord server on the platform.
 *
 * Every guild-scoped surface (admin commands, the bridge relay, the panel's
 * guild APIs) resolves the incoming Discord snowflake to an internal `Guild.id`
 * first. With no matching row, a correctly-configured bot still answers "This
 * server isn't set up on the platform" — so a fresh install needs exactly one
 * Guild row before anything works.
 *
 * Reads DISCORD_GUILD_ID / BRIDGE_CHANNEL_ID / GUILD_NAME from the root .env.
 * Idempotent: re-running updates the existing rows instead of duplicating them.
 *
 *   node dist/seed.js [ownerDiscordId]
 *
 * The optional owner id (or GUILD_OWNER_DISCORD_ID) grants that Discord account
 * the OWNER role, without which every admin command is refused — the rank
 * resolver defaults unknown accounts to MEMBER, and /warn already needs
 * MODERATOR.
 */
import { loadRootEnv } from "@sbr/env";
import { prisma, disconnectDb } from "./client.js";

loadRootEnv();

function required(key: string): string {
  const value = process.env[key]?.trim();
  if (!value) {
    throw new Error(
      `${key} is not set in .env — it is the Discord server this platform manages.\n` +
        "Enable Developer Mode in Discord, right-click your server, and Copy Server ID.",
    );
  }
  return value;
}

async function main(): Promise<void> {
  const discordGuildId = required("DISCORD_GUILD_ID");
  const name = process.env.GUILD_NAME?.trim() || "SBR";
  const bridgeChannelId = process.env.BRIDGE_CHANNEL_ID?.trim() || null;
  const ownerDiscordId = (process.argv[2] ?? process.env.GUILD_OWNER_DISCORD_ID ?? "").trim();

  const guild = await prisma.guild.upsert({
    where: { discordGuildId },
    update: { name },
    create: { discordGuildId, name },
  });
  process.stdout.write(`guild ready: ${guild.name} (${guild.id}) → discord ${discordGuildId}\n`);

  await prisma.guildConfig.upsert({
    where: { guildId: guild.id },
    update: { bridgeChannelId },
    create: { guildId: guild.id, bridgeChannelId },
  });
  process.stdout.write(`guild config ready: bridgeChannelId=${bridgeChannelId ?? "(unset)"}\n`);

  if (ownerDiscordId) {
    const user = await prisma.discordUser.upsert({
      where: { discordId: ownerDiscordId },
      update: { isStaff: true },
      create: { discordId: ownerDiscordId, isStaff: true },
    });
    const membership = await prisma.guildMember.upsert({
      where: { guildId_discordUserId: { guildId: guild.id, discordUserId: user.id } },
      update: { role: "OWNER", status: "ACTIVE" },
      create: { guildId: guild.id, discordUserId: user.id, role: "OWNER", status: "ACTIVE" },
    });
    process.stdout.write(`owner ready: discord ${ownerDiscordId} → role ${membership.role}\n`);
  } else {
    process.stdout.write(
      "\nNo owner id given, so no account has staff rank yet — admin commands need MODERATOR or higher.\n" +
        "Re-run with your Discord user id to grant yourself OWNER:\n" +
        "  npm run db:seed -- <yourDiscordUserId>\n",
    );
  }
}

main()
  .then(() => disconnectDb())
  .catch(async (error: unknown) => {
    process.stderr.write(`seed failed: ${error instanceof Error ? error.message : String(error)}\n`);
    await disconnectDb();
    process.exit(1);
  });
