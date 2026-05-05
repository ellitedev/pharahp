const { Client, Events, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ChannelType } = require('discord.js');
const { joinVoiceChannel, getVoiceConnection, getVoiceConnections, VoiceConnectionStatus } = require('@discordjs/voice');
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

const CONFIG_FILE = path.join(__dirname, 'guild_config.json');

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
const wss = new WebSocket.Server({ port: wsport });
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

const SPEAKING_SILENCE_HOLD_MS = 400;
const speakingTimers = new Map();

function attachSpeakingListeners(vcConn) {
    const spkMap = vcConn.receiver.speaking;
    spkMap.removeAllListeners('start');
    spkMap.removeAllListeners('end');
    spkMap.on('start', (userId) => {
        const pending = speakingTimers.get(userId);
        if (pending) {
            clearTimeout(pending);
            speakingTimers.delete(userId);
            return;
        }
        sendToWs({ type: 'speaking_update', user_id: userId, is_speaking: true });
    });
    spkMap.on('end', (userId) => {
        const pending = speakingTimers.get(userId);
        if (pending) clearTimeout(pending);
        speakingTimers.set(userId, setTimeout(() => {
            speakingTimers.delete(userId);
            sendToWs({ type: 'speaking_update', user_id: userId, is_speaking: false });
        }, SPEAKING_SILENCE_HOLD_MS));
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
});

client.on('interactionCreate', async (interaction) => {
    if (interaction.isChatInputCommand()) {
        if (interaction.commandName === 'join') {
            const voiceChannel = interaction.options.getChannel('channel');
            if (voiceChannel.type !== ChannelType.GuildVoice) {
                await interaction.reply({ content: '❌ Please select a voice channel.', ephemeral: true });
                return;
            }
            try {
                const existingConn = getVoiceConnection(interaction.guildId);
                if (existingConn && existingConn.joinConfig.channelId === voiceChannel.id) {
                    await interaction.reply({ content: `Already in **${voiceChannel.name}**.`, flags: 64 });
                    return;
                }

                // Defer reply first since we're going to wait
                await interaction.deferReply({ flags: 64 });

                let vcConn = joinVoiceChannel({
                    channelId: voiceChannel.id,
                    guildId: interaction.guildId,
                    adapterCreator: interaction.guild.voiceAdapterCreator,
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

                await interaction.editReply(`✅ Joined voice channel: **${voiceChannel.name}**`);
                console.log(`Joined voice channel: ${voiceChannel.name}`);

                // Send initial members update
                sendMembersUpdate(voiceChannel);
            } catch (error) {
                console.error(error);
                if (interaction.deferred) {
                    await interaction.editReply('❌ Failed to join the voice channel.');
                } else {
                    await interaction.reply({ content: '❌ Failed to join the voice channel.', flags: 64 });
                }
            }
        } else if (interaction.commandName === 'disconnect') {
            // ... rest stays the same
            const connection = getVoiceConnection(interaction.guildId);
            if (connection) {
                try {
                    connection.destroy();
                    vcMembers = [];
                    sendToWs({ type: 'members_update', members: [] });
                    await interaction.reply({ content: '✅ Disconnected from voice channel.', flags: 64 });
                    console.log(`Disconnected from voice channel in guild: ${interaction.guild.name}`);
                } catch (error) {
                    console.error(error);
                    await interaction.reply({ content: '❌ Failed to disconnect from voice channel.', flags: 64 });
                }
            } else {
                await interaction.reply({ content: '❌ Not currently connected to a voice channel.', flags: 64 });
            }
        } else if (interaction.commandName === 'setchannel') {
            const channel = interaction.options.getChannel('channel');
            if (channel.type !== ChannelType.GuildText) {
                await interaction.reply({ content: '❌ Please select a text channel.', ephemeral: true });
                return;
            }
            if (!guildConfig[interaction.guildId]) {
                guildConfig[interaction.guildId] = {};
            }
            guildConfig[interaction.guildId].refChannel = channel.id;
            saveConfig();
            await interaction.reply({ content: `✅ Now monitoring **#${channel.name}** for messages.`, flags: 64 });
            console.log(`[CONFIG] Set monitored channel to #${channel.name} (${channel.id}) in guild ${interaction.guild.name}`);
        } else if (interaction.commandName === 'clearchannel') {
            if (guildConfig[interaction.guildId]) {
                delete guildConfig[interaction.guildId].refChannel;
                if (Object.keys(guildConfig[interaction.guildId]).length === 0) {
                    delete guildConfig[interaction.guildId];
                }
                saveConfig();
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
    .catch(console.error);

process.on('SIGINT', function () {
    console.log("Exiting PharahP - closing active connections.");
    const connections = getVoiceConnections();
    connections.forEach(connection => connection.destroy());
    wss.close();
    client.destroy();
    process.exit();
});