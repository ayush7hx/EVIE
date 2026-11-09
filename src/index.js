require("dotenv").config();

const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const {
  ChannelType,
  Client,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
} = require("discord.js");

const PREFIX = "=";
const OWNER_ID = process.env.BOT_OWNER_ID || "1255716509443948648";
const BACKUP_ROOT = path.join(__dirname, "..", "data", "backups");
const TEMPLATE_ROOT = path.join(__dirname, "..", "data", "templates");
const BACKUPABLE_CHANNEL_TYPES = new Set([
  ChannelType.GuildCategory,
  ChannelType.GuildText,
  ChannelType.GuildAnnouncement,
  ChannelType.GuildVoice,
]);

if (!process.env.BOT_TOKEN) {
  throw new Error("BOT_TOKEN is missing. Add it to your .env file.");
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.DirectMessages,
  ],
  partials: [Partials.Channel],
});

const pendingRestores = new Map();

function isOwner(message) {
  return message.author.id === OWNER_ID;
}

function validateGuildId(guildId) {
  if (!/^\d{17,20}$/.test(guildId || "")) {
    throw new Error("Provide a valid server ID.");
  }
}

async function getGuild(guildId) {
  validateGuildId(guildId);

  try {
    return await client.guilds.fetch(guildId);
  } catch (error) {
    throw new Error(
      `EVIE could not access server ${guildId}. Make sure the bot is a member of it.`,
      { cause: error },
    );
  }
}

function explainCommands() {
  return [
    "╭───────────────〔 EVIE 〕───────────────╮",
    "│  Authorized server structure tools    │",
    "├───────────────────────────────────────┤",
    "│  =help                 Show this menu │",
    "│  =ping                 Check latency  │",
    "│  =backup [server-id]   Save structure │",
    "│  =backups [server-id]  List backups   │",
    "│  =restore <src> <id> <target>         │",
    "│  =sync <source> <target>              │",
    "│  =template save <name> [server-id]    │",
    "│  =template list                       │",
    "│  =template apply <name> <target-id>   │",
    "│  =confirm <code>      Apply preview   │",
    "├───────────────────────────────────────┤",
    "│  Add missing only; preview required.  │",
    "╰───────────────────────────────────────╯",
  ].join("\n");
}

function getRoleOverwrite(overwrite, guild) {
  if (overwrite.type !== 0) {
    return null;
  }

  const role = guild.roles.cache.get(overwrite.id);
  if (!role) {
    return null;
  }

  return {
    roleId: role.id,
    roleName: role.name,
    allow: overwrite.allow.bitfield.toString(),
    deny: overwrite.deny.bitfield.toString(),
  };
}

function mapRoleOverwrites(channelData, existingRoles, restoredRoleIds) {
  return channelData.roleOverwrites
    .map((overwrite) => {
      const role =
        restoredRoleIds.get(overwrite.roleId) ||
        existingRoles.get(overwrite.roleName);
      if (!role) {
        return null;
      }
      return {
        id: role.id,
        allow: BigInt(overwrite.allow),
        deny: BigInt(overwrite.deny),
      };
    })
    .filter(Boolean);
}

function createSnapshot(guild) {
  const roles = guild.roles.cache
    .filter((role) => role.id !== guild.id && !role.managed)
    .map((role) => ({
      id: role.id,
      name: role.name,
      color: role.color,
      hoist: role.hoist,
      mentionable: role.mentionable,
      permissions: role.permissions.bitfield.toString(),
      position: role.position,
    }))
    .sort((a, b) => a.position - b.position);

  const channels = guild.channels.cache
    .filter((channel) => BACKUPABLE_CHANNEL_TYPES.has(channel.type))
    .map((channel) => ({
      name: channel.name,
      type: channel.type,
      parentName: channel.parent?.name ?? null,
      position: channel.position,
      topic: "topic" in channel ? channel.topic : null,
      nsfw: "nsfw" in channel ? channel.nsfw : false,
      rateLimitPerUser:
        "rateLimitPerUser" in channel ? channel.rateLimitPerUser : 0,
      bitrate: "bitrate" in channel ? channel.bitrate : null,
      userLimit: "userLimit" in channel ? channel.userLimit : null,
      roleOverwrites: channel.permissionOverwrites.cache
        .map((overwrite) => getRoleOverwrite(overwrite, guild))
        .filter(Boolean),
    }))
    .sort((a, b) => a.position - b.position);

  return {
    schemaVersion: 1,
    guildId: guild.id,
    guildName: guild.name,
    createdAt: new Date().toISOString(),
    roles,
    channels,
  };
}

async function saveBackup(guild) {
  await Promise.all([guild.roles.fetch(), guild.channels.fetch()]);
  const snapshot = createSnapshot(guild);
  const suffix = String(randomBytes(3).readUIntBE(0, 3) % 1_000_000).padStart(
    6,
    "0",
  );
  const backupId = `${Date.now()}${suffix}`;
  const directory = path.join(BACKUP_ROOT, guild.id);
  await fs.mkdir(directory, { recursive: true });
  await fs.writeFile(
    path.join(directory, `${backupId}.json`),
    JSON.stringify(snapshot, null, 2),
    "utf8",
  );
  return { backupId, snapshot };
}

async function listBackups(guildId) {
  validateGuildId(guildId);
  const directory = path.join(BACKUP_ROOT, guildId);
  let names;
  try {
    names = await fs.readdir(directory);
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }

  const backups = [];
  for (const name of names.filter((entry) => /^\d+\.json$/.test(entry))) {
    const backupId = name.slice(0, -5);
    const contents = await fs.readFile(path.join(directory, name), "utf8");
    const snapshot = JSON.parse(contents);
    backups.push({
      backupId,
      guildName: snapshot.guildName,
      createdAt: snapshot.createdAt,
    });
  }
  return backups.sort((a, b) => b.backupId.localeCompare(a.backupId));
}

function validateSnapshot(snapshot, guildId) {
  if (
    snapshot.schemaVersion !== 1 ||
    snapshot.guildId !== guildId ||
    !Array.isArray(snapshot.roles) ||
    !Array.isArray(snapshot.channels)
  ) {
    throw new Error("The backup is invalid or belongs to another server.");
  }
}

async function readBackup(guildId, backupId) {
  validateGuildId(guildId);
  if (!/^\d{1,20}$/.test(backupId)) {
    throw new Error("Backup ID must contain only digits.");
  }

  const filePath = path.join(BACKUP_ROOT, guildId, `${backupId}.json`);
  let snapshot;
  try {
    snapshot = JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("That backup was not found for this server.");
    }
    throw error;
  }

  validateSnapshot(snapshot, guildId);
  return snapshot;
}

async function restoreSnapshot(guild, snapshot) {
  await Promise.all([guild.roles.fetch(), guild.channels.fetch()]);
  const me = await guild.members.fetchMe();
  const missingRoles = snapshot.roles.filter(
    (roleData) =>
      !guild.roles.cache.has(roleData.id) &&
      !guild.roles.cache.some((role) => role.name === roleData.name),
  );
  const missingChannels = snapshot.channels.filter((channelData) => {
    const identity = `${channelData.type}:${channelData.name}`;
    return !guild.channels.cache.some(
      (channel) => `${channel.type}:${channel.name}` === identity,
    );
  });
  if (
    missingRoles.length > 0 &&
    !me.permissions.has(PermissionFlagsBits.ManageRoles)
  ) {
    throw new Error("EVIE needs Manage Roles permission in the target server.");
  }
  if (
    missingChannels.length > 0 &&
    !me.permissions.has(PermissionFlagsBits.ManageChannels)
  ) {
    throw new Error(
      "EVIE needs Manage Channels permission in the target server.",
    );
  }

  const existingRoles = new Map(
    guild.roles.cache.map((role) => [role.name, role]),
  );
  const restoredRoleIds = new Map();
  for (const roleData of snapshot.roles) {
    let role =
      guild.roles.cache.get(roleData.id) || existingRoles.get(roleData.name);
    if (!role) {
      role = await guild.roles.create({
        name: roleData.name,
        color: roleData.color,
        hoist: roleData.hoist,
        mentionable: roleData.mentionable,
        permissions: BigInt(roleData.permissions),
        reason: "EVIE authorized structure restore",
      });
    }
    existingRoles.set(role.name, role);
    restoredRoleIds.set(roleData.id, role);
  }

  const categories = new Map(
    guild.channels.cache
      .filter((channel) => channel.type === ChannelType.GuildCategory)
      .map((channel) => [channel.name, channel]),
  );
  let permissionOverwritesApplied = 0;
  for (const channelData of snapshot.channels) {
    if (channelData.type !== ChannelType.GuildCategory) {
      continue;
    }
    if (!categories.has(channelData.name)) {
      const permissionOverwrites = mapRoleOverwrites(
        channelData,
        existingRoles,
        restoredRoleIds,
      );
      const category = await guild.channels.create({
        name: channelData.name,
        type: ChannelType.GuildCategory,
        permissionOverwrites,
        reason: "EVIE authorized structure restore",
      });
      permissionOverwritesApplied += permissionOverwrites.length;
      categories.set(category.name, category);
    }
  }

  const existingChannels = new Set(
    guild.channels.cache.map((channel) => `${channel.type}:${channel.name}`),
  );
  let createdChannels = 0;
  for (const channelData of snapshot.channels) {
    if (channelData.type === ChannelType.GuildCategory) {
      continue;
    }

    const identity = `${channelData.type}:${channelData.name}`;
    if (existingChannels.has(identity)) {
      continue;
    }

    const permissionOverwrites = mapRoleOverwrites(
      channelData,
      existingRoles,
      restoredRoleIds,
    );

    const options = {
      name: channelData.name,
      type: channelData.type,
      parent: channelData.parentName
        ? categories.get(channelData.parentName)?.id
        : undefined,
      permissionOverwrites,
      reason: "EVIE authorized structure restore",
    };
    if (channelData.type === ChannelType.GuildText ||
        channelData.type === ChannelType.GuildAnnouncement) {
      options.topic = channelData.topic ?? undefined;
      options.nsfw = channelData.nsfw;
      options.rateLimitPerUser = channelData.rateLimitPerUser;
    } else if (channelData.type === ChannelType.GuildVoice) {
      options.bitrate = channelData.bitrate ?? undefined;
      options.userLimit = channelData.userLimit ?? undefined;
    }

    await guild.channels.create(options);
    permissionOverwritesApplied += permissionOverwrites.length;
    existingChannels.add(identity);
    createdChannels += 1;
  }

  return {
    roles: missingRoles.length,
    channels: createdChannels,
    permissionOverwrites: permissionOverwritesApplied,
  };
}

async function saveTemplate(name, guild) {
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(name || "")) {
    throw new Error("Template names must be 1-40 letters, digits, _ or -.");
  }
  await Promise.all([guild.roles.fetch(), guild.channels.fetch()]);
  const snapshot = createSnapshot(guild);
  await fs.mkdir(TEMPLATE_ROOT, { recursive: true });
  await fs.writeFile(
    path.join(TEMPLATE_ROOT, `${name.toLowerCase()}.json`),
    JSON.stringify(snapshot, null, 2),
    "utf8",
  );
  return snapshot;
}

async function listTemplates() {
  let names;
  try {
    names = await fs.readdir(TEMPLATE_ROOT);
  } catch (error) {
    if (error.code === "ENOENT") {
      return [];
    }
    throw error;
  }
  return names
    .filter((name) => /^[a-z0-9][a-z0-9_-]{0,39}\.json$/i.test(name))
    .map((name) => name.slice(0, -5))
    .sort((a, b) => a.localeCompare(b));
}

async function readTemplate(name) {
  if (!/^[a-z0-9][a-z0-9_-]{0,39}$/i.test(name || "")) {
    throw new Error("Template names must be 1-40 letters, digits, _ or -.");
  }
  let snapshot;
  try {
    snapshot = JSON.parse(
      await fs.readFile(
        path.join(TEMPLATE_ROOT, `${name.toLowerCase()}.json`),
        "utf8",
      ),
    );
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error("That template was not found.");
    }
    throw error;
  }
  validateSnapshot(snapshot, snapshot.guildId);
  return snapshot;
}

async function previewRestore(message, guild, snapshot, description) {
  await Promise.all([guild.roles.fetch(), guild.channels.fetch()]);
  const existingRoles = guild.roles.cache;
  const existingChannels = guild.channels.cache;
  const rolesToAdd = snapshot.roles.filter(
    (roleData) =>
      !existingRoles.has(roleData.id) &&
      !existingRoles.some((role) => role.name === roleData.name),
  ).length;
  const channelsToAdd = snapshot.channels.filter(
    (channelData) =>
      !existingChannels.some(
        (channel) =>
          channel.type === channelData.type &&
          channel.name === channelData.name,
      ),
  ).length;
  const missingChannelData = snapshot.channels.filter(
    (channelData) =>
      !existingChannels.some(
        (channel) =>
          channel.type === channelData.type &&
          channel.name === channelData.name,
      ),
  );
  const permissionOverwritesToApply = missingChannelData.reduce(
    (count, channelData) =>
      count + (Array.isArray(channelData.roleOverwrites)
        ? channelData.roleOverwrites.length
        : 0),
    0,
  );
  let code;
  do {
    code = randomBytes(3).toString("hex");
  } while (pendingRestores.has(code));

  const timeout = setTimeout(() => pendingRestores.delete(code), 60_000);
  timeout.unref();
  pendingRestores.set(code, {
    targetGuildId: guild.id,
    snapshot,
    timeout,
  });
  await message.reply(
    `**EVIE preview · ${description}**\n` +
      `Target: **${guild.name}** (\`${guild.id}\`)\n` +
      `Will add: ${rolesToAdd} missing roles, ${channelsToAdd} missing supported channels.\n` +
      `Will apply ${permissionOverwritesToApply} saved role permission overwrites to those new channels/categories.\n` +
      "Existing items will not be changed; extra target items will not be removed.\n" +
      `To apply this preview within 60 seconds, run \`=confirm ${code}\`.`,
  );
}

client.on("messageCreate", async (message) => {
  if (message.author.bot || !message.content.startsWith(PREFIX)) {
    return;
  }

  if (!isOwner(message)) {
    return;
  }
  const [command = "", ...args] = message.content
    .slice(PREFIX.length)
    .trim()
    .split(/\s+/);
  const normalizedCommand = command.toLowerCase();

  if (normalizedCommand === "help") {
    await message.reply(`\`\`\`\n${explainCommands()}\n\`\`\``);
    return;
  }
  if (normalizedCommand === "ping") {
    await message.reply(`Pong · ${client.ws.ping} ms`);
    return;
  }

  try {
    if (normalizedCommand === "backup") {
      const guildId = args[0] || message.guild?.id;
      if (!guildId) {
        await message.reply("Usage: `=backup <server-id>`");
        return;
      }
      const guild = await getGuild(guildId);
      const { backupId, snapshot } = await saveBackup(guild);
      await message.reply(
        `Backup saved · ID: \`${backupId}\` · source: **${guild.name}** · ${snapshot.roles.length} roles · ${snapshot.channels.length} supported channels.`,
      );
    } else if (normalizedCommand === "backups") {
      const guildId = args[0] || message.guild?.id;
      if (!guildId) {
        await message.reply("Usage: `=backups <server-id>`");
        return;
      }
      const backups = await listBackups(guildId);
      if (backups.length === 0) {
        await message.reply("No backups found for that server.");
        return;
      }
      const lines = backups.slice(0, 10).map(
        (backup) => `· \`${backup.backupId}\` — ${backup.createdAt}`,
      );
      await message.reply(`**EVIE backups**\n${lines.join("\n")}`);
    } else if (normalizedCommand === "restore") {
      let sourceGuildId;
      let backupId;
      let targetGuildId;
      if (args.length === 1 && message.guild) {
        sourceGuildId = message.guild.id;
        [backupId] = args;
        targetGuildId = message.guild.id;
      } else {
        [sourceGuildId, backupId, targetGuildId] = args;
      }
      if (!sourceGuildId || !backupId || !targetGuildId) {
        await message.reply(
          "Usage: `=restore <source-server-id> <backup-id> <target-server-id>`",
        );
        return;
      }
      const [snapshot, targetGuild] = await Promise.all([
        readBackup(sourceGuildId, backupId),
        getGuild(targetGuildId),
      ]);
      await previewRestore(message, targetGuild, snapshot, "backup restore");
    } else if (normalizedCommand === "sync") {
      const [sourceId, targetId] = args;
      if (!sourceId || !targetId) {
        await message.reply("Usage: `=sync <source-server-id> <target-server-id>`");
        return;
      }
      const [sourceGuild, targetGuild] = await Promise.all([
        getGuild(sourceId),
        getGuild(targetId),
      ]);
      const { snapshot } = await saveBackup(sourceGuild);
      await previewRestore(message, targetGuild, snapshot, "server sync");
    } else if (normalizedCommand === "template") {
      const [action, ...templateArgs] = args;
      if (action === "save") {
        const [name, guildId = message.guild?.id] = templateArgs;
        if (!name || !guildId) {
          await message.reply(
            "Usage: `=template save <name> [source-server-id]`",
          );
          return;
        }
        const snapshot = await saveTemplate(name, await getGuild(guildId));
        await message.reply(
          `Template \`${name}\` saved · ${snapshot.roles.length} roles · ${snapshot.channels.length} supported channels.`,
        );
      } else if (action === "list") {
        const templates = await listTemplates();
        await message.reply(
          templates.length
            ? `**EVIE templates**\n${templates.map((name) => `· \`${name}\``).join("\n")}`
            : "No templates saved yet.",
        );
      } else if (action === "apply") {
        const [name, targetId] = templateArgs;
        if (!name || !targetId) {
          await message.reply(
            "Usage: `=template apply <name> <target-server-id>`",
          );
          return;
        }
        const [snapshot, targetGuild] = await Promise.all([
          readTemplate(name),
          getGuild(targetId),
        ]);
        await previewRestore(message, targetGuild, snapshot, `template \`${name}\``);
      } else {
        await message.reply(
          "Usage: `=template save <name> [server-id]`, `=template list`, or `=template apply <name> <target-server-id>`",
        );
      }
    } else if (normalizedCommand === "confirm") {
      const code = args[0]?.toLowerCase();
      const operation = pendingRestores.get(code);
      if (!operation) {
        await message.reply("That preview expired or the code is invalid.");
        return;
      }
      clearTimeout(operation.timeout);
      pendingRestores.delete(code);
      const targetGuild = await getGuild(operation.targetGuildId);
      const result = await restoreSnapshot(targetGuild, operation.snapshot);
      await message.reply(
        `Apply complete · ${result.roles} roles and ${result.channels} channels added; ${result.permissionOverwrites} role permission overwrites applied. Existing items were not changed or removed.`,
      );
    }
  } catch (error) {
    console.error(`EVIE ${normalizedCommand} failed:`, error);
    await message.reply(`Command failed: ${error.message}`);
  }
});

client.once("ready", () => {
  console.log(`EVIE is online as ${client.user.tag}. Prefix: ${PREFIX}`);
});

const port = Number(process.env.PORT || 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error("PORT must be a valid TCP port.");
}

const healthServer = http.createServer((request, response) => {
  if (request.url !== "/" && request.url !== "/healthz") {
    response.writeHead(404);
    response.end("Not found");
    return;
  }

  const isReady = client.isReady();
  response.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(
    JSON.stringify({
      name: "EVIE",
      status: isReady ? "ready" : "starting",
      discord: isReady,
    }),
  );
});

healthServer.on("error", (error) => {
  console.error("EVIE health server failed:", error);
  client.destroy();
  process.exitCode = 1;
});

healthServer.listen(port, "0.0.0.0", () => {
  console.log(`EVIE health endpoint listening on port ${port}.`);
});

client.on("error", (error) => {
  console.error("Discord client error:", error);
});

client.login(process.env.BOT_TOKEN);
