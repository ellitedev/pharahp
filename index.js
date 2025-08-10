require('dotenv').config();
require('discord.js');
require('@discordjs/voice')
const { Client, Events, GatewayIntentBits, REST, Routes, SlashCommandBuilder, ChannelType } = require('discord.js');
const { joinVoiceChannel, getVoiceConnection, getVoiceConnections, VoiceConnectionStatus } = require('@discordjs/voice')
const token = process.env.token;
const GUILD_ID = process.env.guildid;
const refDen = process.env.refden;

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
let wsClients = new Set(); // Store all clients

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
        console.error('No WebSocket clients to send to.');
    }
    return sent;
}

// Helper to generate a random client ID
function generateClientId() {
    return 'client_' + Math.random().toString(36).substr(2, 9);
}

wss.on('connection', (ws) => {
    // Assign a random client ID
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

function sendMembersUpdate(voiceChannel) {
    if (!voiceChannel) return;

    // Format the member data for the client
    const members = voiceChannel.members
        .filter(member => member.id !== client.user.id)
        .map(member => ({
            id: member.id,
            username: member.user.username,
            display_name: member.displayName,
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
                let vcConn = joinVoiceChannel({
                    channelId: voiceChannel.id,
                    guildId: interaction.guildId,
                    adapterCreator: interaction.guild.voiceAdapterCreator,
                    selfDeaf: false
                });

                vcConn.on(VoiceConnectionStatus.Ready, () => {
                    const spkMap = vcConn.receiver.speaking;

                    spkMap.on('start', (userId) => {
                        sendToWs({
                            type: 'speaking_update',
                            user_id: userId,
                            is_speaking: true
                        });
                    });

                    spkMap.on('end', (userId) => {
                        sendToWs({
                            type: 'speaking_update',
                            user_id: userId,
                            is_speaking: false
                        });
                    });
                });

                await interaction.reply(
                    { content: `✅ Joined voice channel: **${voiceChannel.name}**`, flags: 64 },

                );
                console.log(`Joined voice channel: ${voiceChannel.name}`);


            } catch (error) {
                console.error(error);
                await interaction.reply({ content: '❌ Failed to join the voice channel.', flags: 64 });
            }
        } else if (interaction.commandName === 'disconnect') {
            const connection = getVoiceConnection(interaction.guildId);
            if (connection) {
                try {
                    connection.disconnect();
                    await interaction.reply({ content: '✅ Disconnected from voice channel.', flags: 64 });
                    console.log(`Disconnected from voice channel in guild: ${interaction.guild.name}`);
                } catch (error) {
                    console.error(error);
                    await interaction.reply({ content: '❌ Failed to disconnect from voice channel.', flags: 64 });
                }
            } else {
                await interaction.reply({ content: '❌ Not currently connected to a voice channel.', flags: 64 });
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

    currentConnection = connection;

    const botChannelId = connection.joinConfig.channelId;
    botChannel = botChannelId;

    const oldChannelId = oldState.channelId;
    const newChannelId = newState.channelId;

    if (oldChannelId !== newChannelId && (oldChannelId === botChannelId || newChannelId === botChannelId)) {
        let voiceChannel = newState.guild.channels.cache.get(botChannelId);
        if (voiceChannel && voiceChannel.type === ChannelType.GuildVoice) {
            console.log(`[EVENT] Voice state change detected in monitored channel. Updating members.`);
            sendMembersUpdate(voiceChannel);
        }
    }
});

client.on('messageCreate', message => {
    if (message.channelId === refDen) {
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

client.on('messageUpdate', (newMessage) => {
    if (newMessage.channelId === refDen) {
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
    if (message.channelId === refDen) {
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
        await rest.put(Routes.applicationGuildCommands(client.user.id, GUILD_ID), {
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
            ],
        });
        console.log('Successfully registered application commands.');
    } catch (err) {
        console.error('Error registering commands:', err);
    }
}

client.login(token)
    .then(() => registerCommands())
    .catch(console.error);

process.on('SIGINT', function () {
    console.log("Exiting PharahP - closing active connections.");
    const connections = getVoiceConnections();
    connections.forEach(connection => connection.destroy());
    wss.close();
    client.destroy();
    process.exit();
});