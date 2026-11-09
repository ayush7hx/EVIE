# EVIE

EVIE is an original, prefix-only Discord bot for local backups and additive
server-structure restore. It is not a copy of Xenon.

## Current features

- Only the configured bot-owner ID can run commands.
- Backups, templates, restore, and sync work across servers where the bot is
  installed.
- Backups contain non-managed roles and supported categories, text,
  announcement, and voice channels, including basic settings and role-based
  channel permission overwrites. Saved role-specific allow/deny permissions
  are recreated on new categories and channels during restore/sync.
- Restore and sync first show a preview and require `=confirm <code>` within
  60 seconds.
- Apply is additive only: missing roles and channels are created; existing
  roles/channels are not edited, and extra target items are not deleted.
  Consequently, permission overwrites are applied to newly created items;
  matching existing target channels are left untouched.
- Backups and templates are stored locally under `data/`.

Messages, members, member-specific permission overwrites, emoji/sticker
assets, and server settings are not included in this implementation. It does
not reproduce Xenon's branding, code, premium implementation, or complete
feature set.

## Setup

1. Create a Discord application and bot in the Discord Developer Portal.
2. Enable **Message Content Intent**.
3. Invite EVIE to every source and target server it should manage. Grant
   permissions to view server structure and, for restore/sync targets, manage
   roles and channels. Keep EVIE's role below roles it should not manage.
4. Copy `.env.example` to `.env` and set `BOT_TOKEN`. The default owner ID is
   `1255716509443948648`; set `BOT_OWNER_ID` only if you need to change it.
5. Install dependencies and start the bot:

   ```sh
   npm install
   npm start
   ```

Use Node.js 20 or newer. Do not share or commit your bot token.

## Commands

EVIE provides Discord slash commands. They are registered when the bot starts;
the configured bot owner is the only person who can use them. Prefix commands
remain available as a fallback.

| Command | Description |
| --- | --- |
| `/help` | Show the command menu |
| `/ping` | Check bot latency |
| `/backup` | Back up the server where the command is used |
| `/backups [server_id]` | List backups for this server or a specified server |
| `/restore [source_server_id] [backup_id]` | Preview restoring into this server; defaults to the latest backup |
| `/sync <source_server_id>` | Back up a source server and preview adding its structure here |
| `/confirm <code>` | Apply the displayed restore/sync preview |
| `/template save <name>` | Save this server as a reusable template |
| `/template list` | List templates |
| `/template apply <name>` | Preview applying a template to this server |

### Back up and restore to another server

1. In the **source server**, run `/backup`. EVIE replies with a backup ID.
2. In the **target server**, run `/restore`, set `source_server_id` to the
   source server's ID, and optionally set `backup_id`. Leave `backup_id` empty
   to use the newest backup from that source.
3. Check EVIE's preview. If it looks right, run `/confirm` with the code shown
   in the preview within 60 seconds.

You can get a server ID by enabling Discord Developer Mode, then right-clicking
the server and choosing **Copy Server ID**. The bot must be in both servers.
Its permissions and role position still limit which structures it can read or
create.

Backups are local files in `data/backups/`; templates are in
`data/templates/`. On Render, the included `render.yaml` configures a paid
always-on web service, a `/healthz` endpoint, and a persistent disk for these
files. Set `BOT_TOKEN` in the Render dashboard; never put the token in source
control. A paid always-on service avoids Render's free-tier idle spin-down, but
no hosting provider guarantees zero downtime.
