# Discord setup

One-time setup to run the bot in your server.

## 1. Create the application

1. Open <https://discord.com/developers/applications> → **New Application**.
2. **General Information**: copy the **Application ID** → `DISCORD_APP_ID`.
3. **Bot** → **Reset Token** → copy it → `DISCORD_TOKEN`.
   No privileged intents are needed (the bot only uses the `Guilds` intent).

## 2. Invite the bot

**OAuth2 → URL Generator**:

- Scopes: `bot`, `applications.commands`
- Bot permissions:
  - View Channels
  - Send Messages
  - Send Messages in Threads
  - Embed Links
  - Manage Threads (update forum post tags)
  - Manage Channels (creates the forum tags on first start; can be removed afterwards)

Open the generated URL and add the bot to your server.

## 3. Channels

1. Create a text channel `#create-job`.
2. Create a **Forum** channel `#responses`. Recommended: only the bot may create posts
   (Permissions → @everyone → deny "Create Posts"; allow it for the bot).
3. Enable **Developer Mode** (User Settings → Advanced), then right-click to copy IDs:
   - Server → `DISCORD_GUILD_ID`
   - `#create-job` → `DISCORD_CREATE_JOB_CHANNEL_ID`
   - `#responses` → `DISCORD_RESPONSES_FORUM_ID`
   - Yourself (and teammates) → `ALLOWED_USER_IDS` (comma-separated)
   - Optional roles → `ALLOWED_ROLE_IDS`

## 4. Register commands and run

```bash
openssl rand -hex 32   # paste into INTERNAL_API_TOKEN in .env
pnpm bot:register      # registers /task /bugreport /runtest /status /cancel /jobs
pnpm dev               # api + worker + bot
```

On first start the bot creates these forum tags if they are missing:
`task`, `bugreport`, `runtest`, `queued`, `running`, `passed`, `failed`, `partial`, `cancelled`.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Commands don't appear | Run `pnpm bot:register` again; check `DISCORD_GUILD_ID` |
| "You are not allowed to use this bot" | Add your user ID to `ALLOWED_USER_IDS` |
| "could not create forum tags" in logs | Grant Manage Channels, or create the tags manually |
| "Repository not found…" | Add the bot GitHub account as a collaborator on the repo |
| "GitHub returned 401" | `GITHUB_BOT_TOKEN` is invalid or expired |
