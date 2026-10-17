const { Client, Events, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ChannelType } = require('discord.js');
const { joinVoiceChannel, getVoiceConnection, getVoiceConnections, VoiceConnectionStatus, EndBehaviorType } = require('@discordjs/voice');
const pjson = require('./package.json');
const fs = require('fs');
const path = require('path');

console.log('[OPUS] Checking opus...');
try {
    require('opusscript');
    console.log('[OPUS] opusscript loaded OK');
} catch (e) {
    console.error('[OPUS] opusscript failed to load:', e.message);
}
const token = process.env.token;

// The panel passes a writable data dir, its install folder may be read only
const dataDir = process.env.datadir || __dirname;
try {
    fs.mkdirSync(dataDir, { recursive: true });
} catch (e) {
    console.error('[CONFIG] Error creating data dir:', e.message);
}
const CONFIG_FILE = path.join(dataDir, 'guild_config.json');

// Load existing config
let guildConfig = {};
try {
    if (fs.existsSync(CONFIG_FILE)) {
        guildConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
        console.log('[CONFIG] Loaded guild configuration from file.');
    }
} catch (e) {
    console.error('[CONFIG] Error loading guild config:', e.message);
}

function saveConfig() {
    try {
        fs.writeFileSync(CONFIG_FILE, JSON.stringify(guildConfig, null, 2));
        console.log('[CONFIG] Saved guild configuration to file.');
    } catch (e) {
        console.error('[CONFIG] Error saving guild config:', e.message);
    }
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});
const rest = new REST({ version: '10' }).setToken(token);

const WebSocket = require('ws');
const wsport = process.env.wssport;
// Unset = all interfaces (docker), the panel only listens on 127.0.0.1
const wss = new WebSocket.Server({ port: wsport, host: process.env.wsshost || undefined });
let wsClients = new Set();

function sendToWs(data) {
    if (!data) {
        console.error('Attempted to send empty data');
        return false;
    }
    const payload = typeof data === 'object' ? JSON.stringify(data) : data;

    let sent = false;
    wsClients.forEach(wsClient => {
        if (wsClient.readyState === WebSocket.OPEN) {
            try {
                wsClient.send(payload);
                sent = true;
            } catch (err) {
                console.error('WebSocket send error:', err, 'Payload:', payload);
            }
        }
    });
    if (!sent) {
        console.log('No WebSocket clients to send to.');
    }
    return sent;
}

function generateClientId() {
    return 'client_' + Math.random().toString(36).substring(2, 11);
}

function attachSpeakingListeners(vcConn) {
    const spkMap = vcConn.receiver.speaking;
    spkMap.removeAllListeners('start');
    spkMap.removeAllListeners('end');
    spkMap.on('start', (userId) => {
        vcConn.receiver.subscribe(userId, {
            end: { behavior: EndBehaviorType.AfterSilence, duration: 100 }
        });
        sendToWs({ type: 'speaking_update', user_id: userId, is_speaking: true });
    });
    spkMap.on('end', (userId) => {
        sendToWs({ type: 'speaking_update', user_id: userId, is_speaking: false });
    });
    console.log('[SPEAKING] Listening for speaking events.');
}

wss.on('connection', (ws) => {
    const clientId = generateClientId();
    ws._clientId = clientId;

    console.log(`WebSocket client connected: ${clientId}`);
    wsClients.add(ws);

    const botReadyMsg = {
        type: 'bot_ready',
        username: client.user ? client.user.tag : null
    };
    ws.send(JSON.stringify(botReadyMsg));

    if (client.isReady()) {
        const botConnectedToDiscordMsg = {
            type: 'channel_monitored',
            success: true
        };
        ws.send(JSON.stringify(botConnectedToDiscordMsg));

        if (vcMembers.length > 0) {
            console.log(`[EVENT] Re-sending members_update`);
            ws.send(JSON.stringify({
                type: 'members_update',
                members: vcMembers
            }));
        }
    }

    ws.on('message', (raw) => {
        let msg;
        try {
            msg = JSON.parse(raw.toString());
        } catch (e) {
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
            return;
        }
        handleWsCommand(ws, msg).catch(err => {
            console.error('[WS] Command error:', err.message);
            ws.send(JSON.stringify({ type: `${msg.type}_result`, request_id: msg.request_id, success: false, error: err.message }));
        });
    });

    ws.on('close', () => {
        console.log(`WebSocket client disconnected: ${ws._clientId}`);
        wsClients.delete(ws);
    });

    ws.on('error', (error) => {
        console.error(`WebSocket error from client ${ws._clientId}:`, error);
        wsClients.delete(ws);
    });
});

let vcMembers = [];

const disconnectTimeouts = new Map();

function scheduleAutoDisconnect(voiceChannel) {
    const guildId = voiceChannel.guild.id;
    if (disconnectTimeouts.has(guildId)) {
        clearTimeout(disconnectTimeouts.get(guildId));
        disconnectTimeouts.delete(guildId);
    }
    const nonBotMembers = voiceChannel.members.filter(m => !m.user.bot);
    if (nonBotMembers.size === 0) {
        const timeout = setTimeout(() => {
            const connection = getVoiceConnection(guildId);
            if (connection) {
                connection.disconnect();
                console.log(`[AUTO-DISCONNECT] Bot was alone for 5 minutes in ${voiceChannel.name}, disconnected.`);
            }
            disconnectTimeouts.delete(guildId);
        }, 5 * 60 * 1000);
        disconnectTimeouts.set(guildId, timeout);
        console.log(`[AUTO-DISCONNECT] Scheduled auto-disconnect in 5 minutes for ${voiceChannel.name}`);
    }
}

function sendMembersUpdate(voiceChannel) {
    if (!voiceChannel) return;

    const members = voiceChannel.members
        .filter(member => !member.user.bot)
        .map(member => ({
            id: member.id,
            username: member.user.username,
            display_name: member.displayName,
            avatar: member.user.displayAvatarURL({ size: 128, extension: 'png' }),
        }));

    vcMembers = members;

    console.log(`[EVENT] Sending members_update for channel ${voiceChannel.name}. Members: ${members.length}`);
    sendToWs({
        type: 'members_update',
        members: members
    });
}


client.once(Events.ClientReady, readyClient => {
    console.log(`Ready! Logged in as ${readyClient.user.tag}`);
    console.log('Running version:' + pjson.version);
    registerCommands();

    // Clients that connected before login finished only got an empty bot_ready
    sendToWs({ type: 'bot_ready', username: readyClient.user.tag });
    sendToWs({ type: 'channel_monitored', success: true });

    // Set by the panel, voice channel id to join right away
    if (process.env.autojoin) {
        readyClient.channels.fetch(process.env.autojoin)
            .then(channel => {
                if (!channel || channel.type !== ChannelType.GuildVoice) throw new Error('Voice channel not found');
                return joinChannel(channel);
            })
            .catch(err => console.error('[AUTOJOIN] Failed to join:', err.message));
    }
});

client.on('interactionCreate', async (interaction) => {
    if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'join') {
            const voiceChannel = interaction.options.getChannel('channel');
            if (voiceChannel.type !== ChannelType.GuildVoice) {
                await interaction.reply({ content: '❌ Please select a voice channel.', ephemeral: true });
                return;
            }
            const existingConn = getVoiceConnection(interaction.guildId);
            if (existingConn && existingConn.joinConfig.channelId === voiceChannel.id) {
                await interaction.reply({ content: `Already in **${voiceChannel.name}**.`, flags: 64 });
                return;
            }

            // Defer reply first since we're going to wait
            await interaction.deferReply({ flags: 64 });
            try {
                await joinChannel(voiceChannel);
                await interaction.editReply(`✅ Joined voice channel: **${voiceChannel.name}**`);
            } catch (error) {
                console.error(error);
                await interaction.editReply('❌ Failed to join the voice channel.');
            }
        } else if (interaction.commandName === 'disconnect') {
            if (leaveChannel(interaction.guildId)) {
                await interaction.reply({ content: '✅ Disconnected from voice channel.', flags: 64 });
                console.log(`Disconnected from voice channel in guild: ${interaction.guild.name}`);
            } else {
                await interaction.reply({ content: '❌ Not currently connected to a voice channel.', flags: 64 });
            }
        } else if (interaction.commandName === 'setchannel') {
            const channel = interaction.options.getChannel('channel');
            if (channel.type !== ChannelType.GuildText) {
                await interaction.reply({ content: '❌ Please select a text channel.', ephemeral: true });
                return;
            }
            setRefChannel(interaction.guildId, channel.id);
            await interaction.reply({ content: `✅ Now monitoring **#${channel.name}** for messages.`, flags: 64 });
            console.log(`[CONFIG] Set monitored channel to #${channel.name} (${channel.id}) in guild ${interaction.guild.name}`);
        } else if (interaction.commandName === 'clearchannel') {
            if (guildConfig[interaction.guildId]?.refChannel) {
                setRefChannel(interaction.guildId, null);
                await interaction.reply({ content: '✅ Stopped monitoring messages in this server.', flags: 64 });
                console.log(`[CONFIG] Cleared monitored channel in guild ${interaction.guild.name}`);
            } else {
                await interaction.reply({ content: '❌ No channel was being monitored in this server.', flags: 64 });
            }
        }
    }
});

client.on(Events.GuildMemberUpdate, (oldMember, newMember) => {
    if (oldMember.displayName !== newMember.displayName) {
        console.log(`User ${oldMember.user.tag} changed their display name from "${oldMember.displayName}" to "${newMember.displayName}"`);

        const currentConnection = getVoiceConnection(newMember.guild.id);
        if (!currentConnection) return;
        const botChannelId = currentConnection.joinConfig.channelId;
        let voiceChannel = newMember.guild.channels.cache.get(botChannelId);

        if (voiceChannel && voiceChannel.type === ChannelType.GuildVoice) {
            console.log(`[EVENT] [Name change] detected in monitored channel. Updating members.`);
            sendMembersUpdate(voiceChannel);
        }
    }
});

client.on(Events.VoiceStateUpdate, (oldState, newState) => {
    const connection = getVoiceConnection(newState.guild.id);

    if (!connection) return;

    const botChannelId = connection.joinConfig.channelId;

    const oldChannelId = oldState.channelId;
    const newChannelId = newState.channelId;

    if (oldChannelId !== newChannelId && (oldChannelId === botChannelId || newChannelId === botChannelId)) {
        let voiceChannel = newState.guild.channels.cache.get(botChannelId);
        if (voiceChannel && voiceChannel.type === ChannelType.GuildVoice) {
            console.log(`[EVENT] Voice state change detected in monitored channel. Updating members.`);
            sendMembersUpdate(voiceChannel);
            scheduleAutoDisconnect(voiceChannel);
        }
    }
});

client.on('messageCreate', message => {
    if (!message.guildId) return;
    const guildRefChannel = guildConfig[message.guildId]?.refChannel;
    if (!guildRefChannel) return;

    if (message.channelId === guildRefChannel) {
        const content = message.content;

        const newMsg = {
            command: 'message-received',
            data: {
                messageId: message.id,
                channelId: message.channelId,
                author: message.member?.displayName || message.author.username,
                role: message.member?.roles.highest.name || 'Bot',
                color: message.member?.roles.highest.hexColor || '#000000',
                content: content,
                timestamp: message.createdTimestamp,
                isBot: message.author.bot
            }
        };
        sendToWs(newMsg);
    }
});

client.on('messageUpdate', (oldMessage, newMessage) => {
    if (newMessage.partial) return;
    if (!newMessage.guildId) return;
    const guildRefChannel = guildConfig[newMessage.guildId]?.refChannel;
    if (!guildRefChannel) return;

    if (newMessage.channelId === guildRefChannel) {
        const updMsg = {
            command: 'message-updated',
            data: {
                messageId: newMessage.id,
                channelId: newMessage.channelId,
                author: newMessage.member?.displayName || newMessage.author.username,
                content: newMessage.content,
                timestamp: newMessage.editedTimestamp,
                isBot: newMessage.author.bot
            }
        };
        sendToWs(updMsg);
    }
});

client.on('messageDelete', message => {
    if (message.partial) return;
    if (!message.guildId) return;
    const guildRefChannel = guildConfig[message.guildId]?.refChannel;
    if (!guildRefChannel) return;

    if (message.channelId === guildRefChannel) {
        const delMsg = {
            command: 'message-deleted',
            data: {
                messageId: message.id,
                author: message.member?.displayName || message.author.username,
                isBot: message.author.bot
            }
        };
        sendToWs(delMsg);
    }
});

async function joinChannel(voiceChannel) {
    const guildId = voiceChannel.guild.id;
    const existingConn = getVoiceConnection(guildId);
    if (existingConn && existingConn.joinConfig.channelId === voiceChannel.id) {
        sendMembersUpdate(voiceChannel);
        return;
    }

    let vcConn = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId: guildId,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: false,
    });

    console.log('[SPEAKING] Connection state on join:', vcConn.state.status);

    vcConn.removeAllListeners(VoiceConnectionStatus.Signalling);
    vcConn.removeAllListeners(VoiceConnectionStatus.Connecting);
    vcConn.removeAllListeners(VoiceConnectionStatus.Ready);
    vcConn.removeAllListeners(VoiceConnectionStatus.Disconnected);
    vcConn.removeAllListeners(VoiceConnectionStatus.Destroyed);
    vcConn.removeAllListeners('error');

    vcConn.on(VoiceConnectionStatus.Signalling, () => {
        console.log('[SPEAKING] VoiceConnection Signalling...');
    });
    vcConn.on(VoiceConnectionStatus.Connecting, () => {
        console.log('[SPEAKING] VoiceConnection Connecting...');
    });
    vcConn.on(VoiceConnectionStatus.Ready, () => {
        console.log('[SPEAKING] VoiceConnection Ready event fired.');
        attachSpeakingListeners(vcConn);
    });
    vcConn.on(VoiceConnectionStatus.Disconnected, () => {
        console.log('[SPEAKING] VoiceConnection Disconnected!');
    });
    vcConn.on(VoiceConnectionStatus.Destroyed, () => {
        console.log('[SPEAKING] VoiceConnection Destroyed!');
    });
    vcConn.on('error', (error) => {
        console.error('[SPEAKING] VoiceConnection error:', error);
        vcConn.destroy();
        vcMembers = [];
        sendToWs({ type: 'members_update', members: [] });
    });

    // Wait for the connection to be ready
    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            reject(new Error('Voice connection timed out'));
        }, 10000);

        vcConn.once(VoiceConnectionStatus.Ready, () => {
            clearTimeout(timeout);
            resolve();
        });

        vcConn.once('error', (error) => {
            clearTimeout(timeout);
            reject(error);
        });

        // If it's already ready, resolve immediately
        if (vcConn.state.status === VoiceConnectionStatus.Ready) {
            clearTimeout(timeout);
            resolve();
        }
    });

    console.log(`Joined voice channel: ${voiceChannel.name}`);

    // Send initial members update
    sendMembersUpdate(voiceChannel);
}

function leaveChannel(guildId) {
    const connection = getVoiceConnection(guildId);
    if (!connection) return false;

    connection.destroy();
    vcMembers = [];
    sendToWs({ type: 'members_update', members: [] });
    return true;
}

function setRefChannel(guildId, channelId) {
    if (channelId) {
        if (!guildConfig[guildId]) {
            guildConfig[guildId] = {};
        }
        guildConfig[guildId].refChannel = channelId;
    } else if (guildConfig[guildId]) {
        delete guildConfig[guildId].refChannel;
        if (Object.keys(guildConfig[guildId]).length === 0) {
            delete guildConfig[guildId];
        }
    }
    saveConfig();
}

function getStatus() {
    const voice = [];
    getVoiceConnections().forEach(connection => {
        voice.push({ guild_id: connection.joinConfig.guildId, channel_id: connection.joinConfig.channelId });
    });
    return {
        ready: client.isReady(),
        username: client.user ? client.user.tag : null,
        voice,
        ref_channels: Object.fromEntries(
            Object.entries(guildConfig).map(([guildId, config]) => [guildId, config.refChannel || null])
        ),
    };
}

// Commands need this key, without one the websocket stays read only (hosted bot)
const wssKey = process.env.wsskey;

// Commands from websocket clients (the panel), answered with `<type>_result`
async function handleWsCommand(ws, msg) {
    const reply = (data) => ws.send(JSON.stringify({ type: `${msg.type}_result`, request_id: msg.request_id, success: true, ...data }));

    // VoiceBotService sends these on connect, the bot only ever watches the channel it's in
    if (msg.type === 'monitor_channel' || msg.type === 'stop_monitoring') return;

    if (!wssKey || msg.key !== wssKey) throw new Error('Not allowed');

    switch (msg.type) {
        case 'status':
            reply(getStatus());
            break;

        case 'list_channels': {
            if (!client.isReady()) throw new Error('Bot is not logged in');
            const guilds = client.guilds.cache.map(guild => ({
                id: guild.id,
                name: guild.name,
                voice: guild.channels.cache
                    .filter(channel => channel.type === ChannelType.GuildVoice)
                    .sort((a, b) => a.rawPosition - b.rawPosition)
                    .map(channel => ({ id: channel.id, name: channel.name })),
                text: guild.channels.cache
                    .filter(channel => channel.type === ChannelType.GuildText)
                    .sort((a, b) => a.rawPosition - b.rawPosition)
                    .map(channel => ({ id: channel.id, name: channel.name })),
            }));
            reply({ guilds });
            break;
        }

        case 'join': {
            if (!client.isReady()) throw new Error('Bot is not logged in');
            const channel = await client.channels.fetch(msg.channel_id).catch(() => null);
            if (!channel || channel.type !== ChannelType.GuildVoice) throw new Error('Voice channel not found');
            await joinChannel(channel);
            reply(getStatus());
            break;
        }

        case 'leave':
            if (msg.guild_id) {
                leaveChannel(msg.guild_id);
            } else {
                getVoiceConnections().forEach(connection => leaveChannel(connection.joinConfig.guildId));
            }
            reply(getStatus());
            break;

        case 'set_ref_channel':
            if (!msg.guild_id) throw new Error('Missing guild_id');
            setRefChannel(msg.guild_id, msg.channel_id || null);
            reply(getStatus());
            break;

        case 'shutdown':
            reply({});
            shutdown();
            break;

        default:
            throw new Error(`Unknown command: ${msg.type}`);
    }
}

async function registerCommands() {
    try {
        await rest.put(Routes.applicationCommands(client.user.id), {
            body: [
                new SlashCommandBuilder()
                    .setName('join')
                    .setDescription('Join a voice channel')
                    .addChannelOption(option =>
                        option.setName('channel')
                            .setDescription('The channel to join')
                            .setRequired(true)
                            .addChannelTypes(ChannelType.GuildVoice)
                    ).toJSON(),
                new SlashCommandBuilder()
                    .setName('disconnect')
                    .setDescription('Disconnect from current voice channel')
                    .toJSON(),
                new SlashCommandBuilder()
                    .setName('setchannel')
                    .setDescription('Set the text channel to monitor for messages')
                    .addChannelOption(option =>
                        option.setName('channel')
                            .setDescription('The text channel to monitor')
                            .setRequired(true)
                            .addChannelTypes(ChannelType.GuildText)
                    ).toJSON(),
                new SlashCommandBuilder()
                    .setName('clearchannel')
                    .setDescription('Stop monitoring messages in this server')
                    .toJSON(),
            ],
        });
        console.log('Successfully registered global application commands.');
    } catch (err) {
        console.error('Error registering commands:', err);
    }
}

client.login(token)
    .catch(err => {
        // Missing privileged intents (Server Members, Message Content) ends up here too
        console.error('[LOGIN] Failed to log in:', err.message);
        sendToWs({ type: 'error', message: `Login failed: ${err.message}` });
        // Nothing works without a login, let the panel show it as crashed
        if (process.env.parentwatch) {
            wss.close();
            setTimeout(() => process.exit(1), 500);
        }
    });

let shuttingDown = false;
function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log("Exiting PharahP - closing active connections.");
    const connections = getVoiceConnections();
    connections.forEach(connection => connection.destroy());
    wss.close();
    client.destroy();
    // Give the voice disconnect a moment to reach discord
    setTimeout(() => process.exit(), 500);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

// Started by the panel: stdin closes when the panel goes away, even when it crashed
if (process.env.parentwatch) {
    process.stdin.on('end', shutdown);
    process.stdin.on('error', shutdown);
    process.stdin.resume();
}
