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

## Prefix commands

EVIE registers no slash commands. The bot owner can issue commands in a server
or DM; a server ID is required when the command is used in a DM.

| Command | Description |
| --- | --- |
| `=help` | Show the command menu |
| `=ping` | Check bot latency |
| `=backup [server-id]` | Save a local structure backup |
| `=backups [server-id]` | List backups for a server |
| `=restore <source-id> <backup-id> <target-id>` | Preview an additive restore |
| `=sync <source-id> <target-id>` | Back up and preview an additive sync |
| `=template save <name> [server-id]` | Save a reusable local template |
| `=template list` | List templates |
| `=template apply <name> <target-id>` | Preview applying a template |
| `=confirm <code>` | Apply the displayed restore/sync preview |

Use Discord's **Copy Server ID** option to get a server ID. The bot must be a
member of source and target servers. Its own Discord permissions and role
position still limit which structures it can read or create.

Backups are local files in `data/backups/`; templates are in
`data/templates/`. On Render, the included `render.yaml` configures a paid
always-on web service, a `/healthz` endpoint, and a persistent disk for these
files. Set `BOT_TOKEN` in the Render dashboard; never put the token in source
control. A paid always-on service avoids Render's free-tier idle spin-down, but
no hosting provider guarantees zero downtime.
