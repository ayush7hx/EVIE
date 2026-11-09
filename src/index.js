require("dotenv").config();

const fs = require("node:fs/promises");
const http = require("node:http");
const path = require("node:path");
const { randomBytes } = require("node:crypto");
const {
  ActionRowBuilder,
  AttachmentBuilder,
  ButtonBuilder,
  ButtonStyle,
  ChannelType,
  Client,
  GatewayIntentBits,
  Partials,
  PermissionFlagsBits,
  SlashCommandBuilder,
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
    "**EVIE commands**",
    "`/backup` — back up this server.",
    "`/backups` — list backups for this server, or another server ID.",
    "`/restore` — restore a backup into this server. Leave backup ID blank for the latest backup.",
    "`/confirm` — confirm the preview code EVIE gives you.",
    "`/sync` — back up another server and preview adding its structure here.",
    "`/template save`, `/template list`, `/template apply` — manage reusable templates.",
    "`/ping` — check bot latency.",
    "",
    "Restore options let you review role/channel loading, settings, and safe extra-item deletion before applying changes.",
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

function getRestoreChannelType(channelType) {
  return channelType === ChannelType.GuildAnnouncement
    ? ChannelType.GuildText
    : channelType;
}

function hasMatchingChannel(existingChannels, channelData) {
  return existingChannels.some((channel) =>
    channelMatchesData(channel, channelData),
  );
}

function channelMatchesData(channel, channelData) {
  const sameType =
    channel.type === channelData.type ||
    channel.type === getRestoreChannelType(channelData.type);
  if (channel.name !== channelData.name || !sameType) {
    return false;
  }
  return (
    channelData.type === ChannelType.GuildCategory ||
    (channel.parent?.name ?? null) === (channelData.parentName ?? null)
  );
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

async function buildRestorePlan(guild, snapshot, options) {
  await Promise.all([guild.roles.fetch(), guild.channels.fetch()]);
  const me = await guild.members.fetchMe();
  const rolesToDelete = [];
  const skippedRoleDeletes = [];
  if (options.deleteRoles) {
    for (const role of guild.roles.cache.values()) {
      if (role.id === guild.id || role.managed) {
        continue;
      }
      if (
        snapshot.roles.some(
          (roleData) => roleData.id === role.id || roleData.name === role.name,
        )
      ) {
        continue;
      }
      (role.editable ? rolesToDelete : skippedRoleDeletes).push({
        id: role.id,
        name: role.name,
      });
    }
  }

  const rolesToCreate = [];
  const rolesToUpdate = [];
  const skippedRoleUpdates = [];
  if (options.loadRoles) {
    for (const roleData of snapshot.roles) {
      const role =
        guild.roles.cache.get(roleData.id) ||
        guild.roles.cache.find((candidate) => candidate.name === roleData.name);
      if (!role) {
        rolesToCreate.push(roleData);
      } else if (role.editable) {
        rolesToUpdate.push({ id: role.id, roleData });
      } else {
        skippedRoleUpdates.push(role.name);
      }
    }
  }

  const backupableChannels = guild.channels.cache.filter((channel) =>
    BACKUPABLE_CHANNEL_TYPES.has(channel.type),
  );
  const channelsInBackup = (channel) =>
    snapshot.channels.some((channelData) =>
      channelMatchesData(channel, channelData),
    );
  const channelsToDelete = [];
  const skippedChannelDeletes = [];
  if (options.deleteChannels) {
    for (const channel of backupableChannels.values()) {
      if (channelsInBackup(channel)) {
        continue;
      }
      (channel.deletable ? channelsToDelete : skippedChannelDeletes).push({
        id: channel.id,
        name: channel.name,
        type: channel.type,
      });
    }
  }
  channelsToDelete.sort(
    (a, b) =>
      Number(a.type === ChannelType.GuildCategory) -
      Number(b.type === ChannelType.GuildCategory),
  );

  const channelsToCreate = options.loadChannels
    ? snapshot.channels
        .filter((channelData) => !hasMatchingChannel(backupableChannels, channelData))
        .sort(
          (a, b) =>
            Number(a.type !== ChannelType.GuildCategory) -
            Number(b.type !== ChannelType.GuildCategory),
        )
    : [];
  const channelsToUpdate = [];
  const skippedChannelUpdates = [];
  if (options.loadSettings) {
    for (const channelData of snapshot.channels) {
      const channel = backupableChannels.find((candidate) =>
        channelMatchesData(candidate, channelData),
      );
      if (!channel) {
        continue;
      }
      (channel.manageable ? channelsToUpdate : skippedChannelUpdates).push(
        channel.manageable
          ? { id: channel.id, channelData }
          : channel.name,
      );
    }
  }

  if (
    (rolesToDelete.length || rolesToCreate.length || rolesToUpdate.length) &&
    !me.permissions.has(PermissionFlagsBits.ManageRoles)
  ) {
    throw new Error("EVIE needs Manage Roles permission in the target server.");
  }
  if (
    (channelsToDelete.length ||
      channelsToCreate.length ||
      channelsToUpdate.length) &&
    !me.permissions.has(PermissionFlagsBits.ManageChannels)
  ) {
    throw new Error(
      "EVIE needs Manage Channels permission in the target server.",
    );
  }

  return {
    rolesToDelete,
    skippedRoleDeletes,
    rolesToCreate,
    rolesToUpdate,
    skippedRoleUpdates,
    channelsToDelete,
    skippedChannelDeletes,
    channelsToCreate,
    channelsToUpdate,
    skippedChannelUpdates,
  };
}

async function restoreSnapshot(guild, snapshot, options, plan) {
  await Promise.all([guild.roles.fetch(), guild.channels.fetch()]);
  const counts = {
    rolesAdded: 0,
    rolesUpdated: 0,
    rolesDeleted: 0,
    channelsAdded: 0,
    channelsUpdated: 0,
    channelsDeleted: 0,
    permissionOverwrites: 0,
    announcementChannelsConverted: 0,
  };

  for (const entry of plan.channelsToDelete) {
    const channel = guild.channels.cache.get(entry.id);
    if (channel?.deletable) {
      await channel.delete("EVIE authorized backup restore");
      counts.channelsDeleted += 1;
    }
  }
  for (const entry of plan.rolesToDelete) {
    const role = guild.roles.cache.get(entry.id);
    if (role?.editable) {
      await role.delete("EVIE authorized backup restore");
      counts.rolesDeleted += 1;
    }
  }

  for (const roleData of plan.rolesToCreate) {
    if (guild.roles.cache.some((role) => role.name === roleData.name)) {
      continue;
    }
    await guild.roles.create({
      name: roleData.name,
      color: roleData.color,
      hoist: roleData.hoist,
      mentionable: roleData.mentionable,
      permissions: BigInt(roleData.permissions),
      reason: "EVIE authorized structure restore",
    });
    counts.rolesAdded += 1;
  }
  for (const entry of plan.rolesToUpdate) {
    const role =
      guild.roles.cache.get(entry.id) ||
      guild.roles.cache.find((candidate) => candidate.name === entry.roleData.name);
    if (!role?.editable) {
      continue;
    }
    await role.edit({
      name: entry.roleData.name,
      color: entry.roleData.color,
      hoist: entry.roleData.hoist,
      mentionable: entry.roleData.mentionable,
      permissions: BigInt(entry.roleData.permissions),
      reason: "EVIE authorized backup restore",
    });
    counts.rolesUpdated += 1;
  }

  const existingRoles = new Map(
    guild.roles.cache.map((role) => [role.name, role]),
  );
  const restoredRoleIds = new Map();
  restoredRoleIds.set(snapshot.guildId, guild.roles.everyone);
  for (const roleData of snapshot.roles) {
    const role =
      guild.roles.cache.get(roleData.id) || existingRoles.get(roleData.name);
    if (role) {
      restoredRoleIds.set(roleData.id, role);
    }
  }

  const categories = new Map(
    guild.channels.cache
      .filter((channel) => channel.type === ChannelType.GuildCategory)
      .map((channel) => [channel.name, channel]),
  );
  const createdChannelIds = new Set();
  if (options.loadChannels) {
    for (const channelData of plan.channelsToCreate) {
      if (channelData.type === ChannelType.GuildCategory) {
        const category = await guild.channels.create({
          name: channelData.name,
          type: ChannelType.GuildCategory,
          reason: "EVIE authorized structure restore",
        });
        categories.set(category.name, category);
        createdChannelIds.add(category.id);
        counts.channelsAdded += 1;
      }
    }
    for (const channelData of plan.channelsToCreate) {
      if (channelData.type === ChannelType.GuildCategory) {
        continue;
      }
      const channelOptions = {
        name: channelData.name,
        type: getRestoreChannelType(channelData.type),
        reason: "EVIE authorized structure restore",
      };
      if (channelData.parentName && categories.has(channelData.parentName)) {
        channelOptions.parent = categories.get(channelData.parentName).id;
      }
      const channel = await guild.channels.create(channelOptions);
      createdChannelIds.add(channel.id);
      counts.channelsAdded += 1;
      if (channelData.type === ChannelType.GuildAnnouncement) {
        counts.announcementChannelsConverted += 1;
      }
    }
  }

  if (options.loadSettings) {
    const mappedRoleIds = new Set(
      [guild.roles.everyone?.id, ...restoredRoleIds.values()]
        .filter(Boolean)
        .map((role) => role.id),
    );
    for (const channelData of snapshot.channels) {
      const channel = guild.channels.cache.find((candidate) =>
        channelMatchesData(candidate, channelData),
      );
      if (!channel) {
        continue;
      }
      if (
        !createdChannelIds.has(channel.id) &&
        !plan.channelsToUpdate.some((entry) => entry.id === channel.id)
      ) {
        continue;
      }

      const editOptions = {};
      if (channelData.type !== ChannelType.GuildCategory) {
        if (channelData.parentName) {
          const parent = categories.get(channelData.parentName);
          if (parent) {
            editOptions.parent = parent.id;
          }
        } else {
          editOptions.parent = null;
        }
        if (
          channelData.type === ChannelType.GuildText ||
          channelData.type === ChannelType.GuildAnnouncement
        ) {
          editOptions.topic = channelData.topic ?? null;
          editOptions.nsfw = channelData.nsfw;
          editOptions.rateLimitPerUser = channelData.rateLimitPerUser;
        } else if (channelData.type === ChannelType.GuildVoice) {
          editOptions.bitrate = channelData.bitrate ?? undefined;
          editOptions.userLimit = channelData.userLimit ?? undefined;
        }
      }
      if (Object.keys(editOptions).length) {
        editOptions.reason = "EVIE authorized backup restore";
        await channel.edit(editOptions);
      }
      if (plan.channelsToUpdate.some((entry) => entry.id === channel.id)) {
        counts.channelsUpdated += 1;
      }

      const desiredOverwrites = mapRoleOverwrites(
        channelData,
        existingRoles,
        restoredRoleIds,
      );
      const desiredRoleIds = new Set(
        desiredOverwrites.map((overwrite) => overwrite.id),
      );
      for (const overwrite of channel.permissionOverwrites.cache.values()) {
        if (
          overwrite.type === 0 &&
          mappedRoleIds.has(overwrite.id) &&
          !desiredRoleIds.has(overwrite.id)
        ) {
          await channel.permissionOverwrites.delete(
            overwrite.id,
            "EVIE authorized backup restore",
          );
          counts.permissionOverwrites += 1;
        }
      }
      for (const overwrite of desiredOverwrites) {
        await channel.permissionOverwrites.edit(
          overwrite.id,
          { allow: overwrite.allow, deny: overwrite.deny },
          "EVIE authorized backup restore",
        );
        counts.permissionOverwrites += 1;
      }
    }
  }

  return { ...counts, plan };
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

function createRestoreOptions() {
  return {
    deleteRoles: false,
    deleteChannels: false,
    loadRoles: true,
    loadChannels: true,
    loadSettings: true,
  };
}

function restoreOptionRows(code, options) {
  const choices = [
    ["deleteRoles", "Delete roles"],
    ["deleteChannels", "Delete channels"],
    ["loadRoles", "Load roles"],
    ["loadChannels", "Load channels"],
    ["loadSettings", "Load settings"],
  ];
  const choiceRow = new ActionRowBuilder().addComponents(
    ...choices.map(([key, label]) =>
      new ButtonBuilder()
        .setCustomId(`evie:${code}:${key}`)
        .setLabel(label)
        .setStyle(options[key] ? ButtonStyle.Success : ButtonStyle.Secondary),
    ),
  );
  const actionRow = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`evie:${code}:continue`)
      .setLabel("Continue")
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`evie:${code}:cancel`)
      .setLabel("Cancel")
      .setStyle(ButtonStyle.Secondary),
  );
  return [choiceRow, actionRow];
}

function restoreConfirmationRows(code) {
  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId(`evie:${code}:apply`)
        .setLabel("Confirm restore")
        .setStyle(ButtonStyle.Danger),
      new ButtonBuilder()
        .setCustomId(`evie:${code}:cancel`)
        .setLabel("Cancel")
        .setStyle(ButtonStyle.Secondary),
    ),
  ];
}

function formatRestorePlan(guild, description, plan, confirmCommand) {
  const lines = [
    `EVIE restore preview · ${description}`,
    `Target: ${guild.name} (${guild.id})`,
    "",
    "Planned changes:",
  ];
  for (const role of plan.rolesToDelete) {
    lines.push(`- Delete extra role: ${role.name} (removes its member assignments)`);
  }
  for (const roleData of plan.rolesToCreate) {
    lines.push(`+ Create role: ${roleData.name}`);
  }
  for (const entry of plan.rolesToUpdate) {
    lines.push(`~ Update role settings: ${entry.roleData.name}`);
  }
  for (const channel of plan.channelsToDelete) {
    const label =
      channel.type === ChannelType.GuildCategory ? "category" : "channel";
    lines.push(`- Delete extra ${label}: ${channel.name}`);
  }
  for (const channelData of plan.channelsToCreate) {
    const label =
      channelData.type === ChannelType.GuildCategory ? "category" : "channel";
    lines.push(`+ Create ${label}: ${channelData.name}`);
  }
  for (const entry of plan.channelsToUpdate) {
    lines.push(`~ Apply backup settings to existing channel: ${entry.channelData.name}`);
  }
  for (const name of plan.skippedRoleDeletes) {
    lines.push(`! Cannot delete protected role: ${name}`);
  }
  for (const name of plan.skippedRoleUpdates) {
    lines.push(`! Cannot update protected role: ${name}`);
  }
  for (const channel of plan.skippedChannelDeletes) {
    lines.push(`! Cannot delete protected channel/category: ${channel.name}`);
  }
  for (const name of plan.skippedChannelUpdates) {
    lines.push(`! Cannot update protected channel: ${name}`);
  }
  if (
    !plan.rolesToDelete.length &&
    !plan.rolesToCreate.length &&
    !plan.rolesToUpdate.length &&
    !plan.channelsToDelete.length &&
    !plan.channelsToCreate.length &&
    !plan.channelsToUpdate.length
  ) {
    lines.push("No changes are needed for the selected options.");
  }
  lines.push(
    "",
    "Only extra roles/channels absent from the backup are deleted. " +
      "Managed roles and member-specific channel permissions are preserved.",
    `Confirm with the button below, or use ${confirmCommand}.`,
  );

  const report = lines.join("\n");
  if (report.length <= 1_800) {
    return { content: report };
  }
  const summary =
    `**EVIE restore preview · ${description}**\n` +
    `Target: **${guild.name}** (\`${guild.id}\`). The complete change list is attached.\n` +
    `Confirm with the button, or use ${confirmCommand}.`;
  return {
    content: summary,
    files: [
      new AttachmentBuilder(Buffer.from(report, "utf8"), {
        name: "evie-restore-preview.txt",
      }),
    ],
  };
}

async function previewRestore(reply, guild, snapshot, description, confirmCommand) {
  let code;
  do {
    code = randomBytes(3).toString("hex");
  } while (pendingRestores.has(code));

  const timeout = setTimeout(() => pendingRestores.delete(code), 60_000);
  timeout.unref();
  const options = createRestoreOptions();
  pendingRestores.set(code, {
    targetGuildId: guild.id,
    snapshot,
    options,
    timeout,
  });
  const message = await reply(
    `**What should EVIE load from this backup?**\n` +
      `Target: **${guild.name}**\n` +
      "Delete options remove only target items that are not in the backup. " +
      "Load settings also updates matching existing channels.",
    { components: restoreOptionRows(code, options) },
  );
  const collector = message.createMessageComponentCollector({ time: 60_000 });
  collector.on("collect", async (component) => {
    if (component.user.id !== OWNER_ID) {
      await component.reply({
        content: "Only the configured bot owner can use these restore options.",
        ephemeral: true,
      });
      return;
    }

    const action = component.customId.slice(`evie:${code}:`.length);
    const operation = pendingRestores.get(code);
    if (operation?.busy) {
      await component.deferUpdate();
      return;
    }
    if (operation) {
      operation.busy = true;
    }
    try {
      await component.deferUpdate();
      if (!operation) {
        await message.edit({
          content: "This restore preview expired. Run the restore command again.",
          components: [],
        });
        collector.stop("expired");
        return;
      }

      if (action === "cancel") {
        clearTimeout(operation.timeout);
        pendingRestores.delete(code);
        await message.edit({ content: "Restore cancelled.", components: [] });
        collector.stop("cancelled");
        return;
      }
      if (action === "continue") {
        collector.resetTimer({ time: 60_000 });
        clearTimeout(operation.timeout);
        operation.timeout = setTimeout(() => pendingRestores.delete(code), 60_000);
        operation.timeout.unref();
        const targetGuild = await getGuild(operation.targetGuildId);
        operation.plan = await buildRestorePlan(
          targetGuild,
          operation.snapshot,
          operation.options,
        );
        const report = formatRestorePlan(
          targetGuild,
          description,
          operation.plan,
          confirmCommand(code),
        );
        clearTimeout(operation.timeout);
        operation.timeout = setTimeout(() => pendingRestores.delete(code), 60_000);
        operation.timeout.unref();
        await message.edit({
          ...report,
          components: restoreConfirmationRows(code),
        });
        return;
      }
      if (action === "apply") {
        collector.resetTimer({ time: 60_000 });
        const result = await applyPendingRestore(code);
        await message.edit({
          content:
            `**Restore complete.** Added ${result.rolesAdded} roles and ${result.channelsAdded} channels; ` +
            `updated ${result.rolesUpdated} roles and ${result.channelsUpdated} channels; ` +
            `deleted ${result.rolesDeleted} roles and ${result.channelsDeleted} channels; ` +
            `applied ${result.permissionOverwrites} role permission changes.` +
            (result.announcementChannelsConverted
              ? ` ${result.announcementChannelsConverted} announcement channels were created as regular text channels.`
              : ""),
          components: [],
        });
        collector.stop("applied");
        return;
      }
      if (Object.hasOwn(operation.options, action)) {
        operation.options[action] = !operation.options[action];
        collector.resetTimer({ time: 60_000 });
        clearTimeout(operation.timeout);
        operation.timeout = setTimeout(() => pendingRestores.delete(code), 60_000);
        operation.timeout.unref();
        await message.edit({
          content:
            `**What should EVIE load from this backup?**\n` +
            `Target: **${guild.name}**\n` +
            "Delete options remove only target items that are not in the backup. " +
            "Load settings also updates matching existing channels.",
          components: restoreOptionRows(code, operation.options),
        });
      }
    } catch (error) {
      console.error(`EVIE restore preview ${action} failed:`, error);
      const currentOperation = pendingRestores.get(code);
      if (currentOperation && action === "apply") {
        collector.resetTimer({ time: 60_000 });
        await message.edit({
          content: `Restore failed: ${error.message}\nYou can retry or cancel this preview.`,
          components: restoreConfirmationRows(code),
        });
      } else {
        clearTimeout(operation?.timeout);
        pendingRestores.delete(code);
        await message.edit({
          content: `Could not prepare restore preview: ${error.message}`,
          components: [],
        });
        collector.stop("failed");
      }
    } finally {
      const currentOperation = pendingRestores.get(code);
      if (currentOperation) {
        currentOperation.busy = false;
      }
    }
  });
  collector.on("end", async (_collected, reason) => {
    if (reason === "time") {
      const operation = pendingRestores.get(code);
      clearTimeout(operation?.timeout);
      pendingRestores.delete(code);
      await message.edit({
        content: "This restore preview expired. Run the restore command again.",
        components: [],
      }).catch((error) =>
        console.error("EVIE could not close an expired restore preview:", error),
      );
    }
  });
}

async function applyPendingRestore(code) {
  const operation = pendingRestores.get(code);
  if (!operation || operation.applying) {
    throw new Error(
      "That preview expired, is already being applied, or the code is invalid.",
    );
  }

  operation.applying = true;
  clearTimeout(operation.timeout);
  try {
    const targetGuild = await getGuild(operation.targetGuildId);
    if (!operation.plan) {
      throw new Error("Continue through the restore preview before confirming.");
    }
    const result = await restoreSnapshot(
      targetGuild,
      operation.snapshot,
      operation.options,
      operation.plan,
    );
    pendingRestores.delete(code);
    return result;
  } catch (error) {
    operation.applying = false;
    operation.timeout = setTimeout(() => pendingRestores.delete(code), 60_000);
    operation.timeout.unref();
    throw error;
  }
}

const slashCommands = [
  new SlashCommandBuilder()
    .setName("help")
    .setDescription("Show EVIE commands"),
  new SlashCommandBuilder()
    .setName("ping")
    .setDescription("Check EVIE latency"),
  new SlashCommandBuilder()
    .setName("backup")
    .setDescription("Back up this server"),
  new SlashCommandBuilder()
    .setName("backups")
    .setDescription("List saved backups")
    .addStringOption((option) =>
      option
        .setName("server_id")
        .setDescription("Server ID (defaults to this server)"),
    ),
  new SlashCommandBuilder()
    .setName("restore")
    .setDescription("Restore a backup into this server")
    .addStringOption((option) =>
      option
        .setName("source_server_id")
        .setDescription("Server ID where the backup was made (defaults to this server)"),
    )
    .addStringOption((option) =>
      option
        .setName("backup_id")
        .setDescription("Backup ID (defaults to the latest backup)"),
    ),
  new SlashCommandBuilder()
    .setName("sync")
    .setDescription("Preview adding another server's structure here")
    .addStringOption((option) =>
      option
        .setName("source_server_id")
        .setDescription("Server ID to copy from")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("confirm")
    .setDescription("Apply the restore preview")
    .addStringOption((option) =>
      option
        .setName("code")
        .setDescription("The short code shown in the preview")
        .setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("template")
    .setDescription("Save or apply reusable server templates")
    .addSubcommand((subcommand) =>
      subcommand
        .setName("save")
        .setDescription("Save this server as a template")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("Template name")
            .setRequired(true),
        ),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("list")
        .setDescription("List saved templates"),
    )
    .addSubcommand((subcommand) =>
      subcommand
        .setName("apply")
        .setDescription("Preview applying a template to this server")
        .addStringOption((option) =>
          option
            .setName("name")
            .setDescription("Template name")
            .setRequired(true),
        ),
    ),
].map((command) => command.toJSON());

function requireInteractionGuild(interaction) {
  if (!interaction.guildId) {
    throw new Error("Use this command inside a server.");
  }
}

async function handleSlashCommand(interaction) {
  if (interaction.user.id !== OWNER_ID) {
    await interaction.reply({
      content: "Only the configured bot owner can use EVIE commands.",
      ephemeral: true,
    });
    return;
  }

  if (interaction.commandName === "help") {
    await interaction.reply({ content: explainCommands(), ephemeral: true });
    return;
  }
  if (interaction.commandName === "ping") {
    await interaction.reply({
      content: `Pong · ${client.ws.ping} ms`,
      ephemeral: true,
    });
    return;
  }

  await interaction.deferReply({ ephemeral: true });
  const reply = (content, options = {}) =>
    interaction.editReply({ content, ...options });

  try {
    if (interaction.commandName === "backup") {
      requireInteractionGuild(interaction);
      const guild = await getGuild(interaction.guildId);
      const { backupId, snapshot } = await saveBackup(guild);
      await reply(
        `Backup saved for **${guild.name}** · ID: \`${backupId}\` · ${snapshot.roles.length} roles · ${snapshot.channels.length} supported channels.`,
      );
    } else if (interaction.commandName === "backups") {
      const guildId =
        interaction.options.getString("server_id") || interaction.guildId;
      if (!guildId) {
        throw new Error("Use this command in a server or provide a server ID.");
      }
      const backups = await listBackups(guildId);
      await reply(
        backups.length
          ? `**Backups for server \`${guildId}\`**\n${backups
              .slice(0, 10)
              .map((backup) => `· \`${backup.backupId}\` — ${backup.createdAt}`)
              .join("\n")}`
          : "No backups found for that server.",
      );
    } else if (interaction.commandName === "restore") {
      requireInteractionGuild(interaction);
      const sourceGuildId =
        interaction.options.getString("source_server_id") ||
        interaction.guildId;
      const requestedBackupId = interaction.options.getString("backup_id");
      const backups = requestedBackupId
        ? null
        : await listBackups(sourceGuildId);
      const backupId = requestedBackupId || backups[0]?.backupId;
      if (!backupId) {
        throw new Error(
          "No backups found. Run /backup in the source server first.",
        );
      }
      const [snapshot, targetGuild] = await Promise.all([
        readBackup(sourceGuildId, backupId),
        getGuild(interaction.guildId),
      ]);
      await previewRestore(
        reply,
        targetGuild,
        snapshot,
        "backup restore",
        (code) => `\`/confirm code:${code}\``,
      );
    } else if (interaction.commandName === "sync") {
      requireInteractionGuild(interaction);
      const sourceId = interaction.options.getString("source_server_id");
      const [sourceGuild, targetGuild] = await Promise.all([
        getGuild(sourceId),
        getGuild(interaction.guildId),
      ]);
      const { snapshot } = await saveBackup(sourceGuild);
      await previewRestore(
        reply,
        targetGuild,
        snapshot,
        "server sync",
        (code) => `\`/confirm code:${code}\``,
      );
    } else if (interaction.commandName === "confirm") {
      const code = interaction.options.getString("code").toLowerCase();
      const result = await applyPendingRestore(code);
      await reply(
        `Restore complete · Added ${result.rolesAdded} roles and ${result.channelsAdded} channels; ` +
          `updated ${result.rolesUpdated} roles and ${result.channelsUpdated} channels; ` +
          `deleted ${result.rolesDeleted} roles and ${result.channelsDeleted} channels; ` +
          `applied ${result.permissionOverwrites} role permission changes.` +
          (result.announcementChannelsConverted
            ? ` ${result.announcementChannelsConverted} announcement channels were created as regular text channels.`
            : ""),
      );
    } else if (interaction.commandName === "template") {
      const action = interaction.options.getSubcommand();
      if (action === "list") {
        const templates = await listTemplates();
        await reply(
          templates.length
            ? `**EVIE templates**\n${templates.map((name) => `· \`${name}\``).join("\n")}`
            : "No templates saved yet.",
        );
      } else if (action === "save") {
        requireInteractionGuild(interaction);
        const name = interaction.options.getString("name");
        const snapshot = await saveTemplate(
          name,
          await getGuild(interaction.guildId),
        );
        await reply(
          `Template \`${name}\` saved · ${snapshot.roles.length} roles · ${snapshot.channels.length} supported channels.`,
        );
      } else if (action === "apply") {
        requireInteractionGuild(interaction);
        const name = interaction.options.getString("name");
        const [snapshot, targetGuild] = await Promise.all([
          readTemplate(name),
          getGuild(interaction.guildId),
        ]);
        await previewRestore(
          reply,
          targetGuild,
          snapshot,
          `template \`${name}\``,
          (code) => `\`/confirm code:${code}\``,
        );
      }
    }
  } catch (error) {
    console.error(`EVIE /${interaction.commandName} failed:`, error);
    await reply(`Command failed: ${error.message}`);
  }
}

client.on("interactionCreate", async (interaction) => {
  if (interaction.isChatInputCommand()) {
    await handleSlashCommand(interaction);
  }
});

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
      await previewRestore(
        (content, options = {}) => message.reply({ content, ...options }),
        targetGuild,
        snapshot,
        "backup restore",
        (code) => `\`=confirm ${code}\``,
      );
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
      await previewRestore(
        (content, options = {}) => message.reply({ content, ...options }),
        targetGuild,
        snapshot,
        "server sync",
        (code) => `\`=confirm ${code}\``,
      );
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
        await previewRestore(
          (content, options = {}) => message.reply({ content, ...options }),
          targetGuild,
          snapshot,
          `template \`${name}\``,
          (code) => `\`=confirm ${code}\``,
        );
      } else {
        await message.reply(
          "Usage: `=template save <name> [server-id]`, `=template list`, or `=template apply <name> <target-server-id>`",
        );
      }
    } else if (normalizedCommand === "confirm") {
      const code = args[0]?.toLowerCase();
      const result = await applyPendingRestore(code);
      await message.reply(
        `Restore complete · Added ${result.rolesAdded} roles and ${result.channelsAdded} channels; ` +
          `updated ${result.rolesUpdated} roles and ${result.channelsUpdated} channels; ` +
          `deleted ${result.rolesDeleted} roles and ${result.channelsDeleted} channels; ` +
          `applied ${result.permissionOverwrites} role permission changes.` +
          (result.announcementChannelsConverted
            ? ` ${result.announcementChannelsConverted} announcement channels were created as regular text channels.`
            : ""),
      );
    }
  } catch (error) {
    console.error(`EVIE ${normalizedCommand} failed:`, error);
    await message.reply(`Command failed: ${error.message}`);
  }
});

client.once("ready", async () => {
  console.log(`EVIE is online as ${client.user.tag}. Prefix: ${PREFIX}`);
  try {
    await client.application.commands.set(slashCommands);
    console.log("EVIE slash commands registered.");
  } catch (error) {
    console.error("EVIE slash command registration failed:", error);
  }
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
