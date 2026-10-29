# PharahP
(read as Therapy)

Companion bot to https://github.com/SpinShare/sssopanel-next

## running

```
npm ci --omit=dev
token=<bot token> wssport=8765 node index.js
```

the bot app needs the **Server Members** and **Message Content** privileged intents enabled in the discord developer portal.

| env | what |
| --- | --- |
| `token` | discord bot token |
| `wssport` | websocket port |
| `wsshost` | host to listen on, unset = all interfaces (the panel uses `127.0.0.1`) |
| `datadir` | where `guild_config.json` goes, default next to `index.js` |
| `parentwatch` | when set, exit once stdin closes or login fails (the panel sets this so the bot goes away with it) |
| `wsskey` | key the websocket commands below need, unset = commands are disabled (read only, like the hosted bot) |
| `autojoin` | voice channel id to join once logged in |

sssopanel can run the bot itself (settings > voice bot), don't run the same token in two places at once.

## websocket commands

send `{ "type": "<command>", "key": "<wsskey>", "request_id": "<optional>", ... }`, the answer is `{ "type": "<command>_result", "request_id", "success", "error"? }`.

| command | fields | answer |
| --- | --- | --- |
| `status` | | `ready`, `username`, `voice: [{guild_id, channel_id}]`, `ref_channels: {guildId: channelId}`, `spotlight_roles: {guildId: roleId}` |
| `list_channels` | | `guilds: [{id, name, voice: [{id, name}], text: [{id, name}], roles: [{id, name, color}]}]` |
| `join` | `channel_id` | status |
| `leave` | `guild_id` (optional, leaves all) | status |
| `set_ref_channel` | `guild_id`, `channel_id` (null clears) | status |
| `set_spotlight_role` | `guild_id`, `role_id` (null clears), ref channel messages from it get `spotlight: true` | status |
| `shutdown` | | leaves vc and exits |
