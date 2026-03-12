const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const app = express();
app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json({ limit: '60mb' }));
app.use(express.urlencoded({ limit: '60mb', extended: true }));

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

let client = null;
let currentQR = null;
let clientStatus = 'DISCONNECTED'; // DISCONNECTED, CONNECTING, CONNECTED

// Bot state
let isBotRunning = false;
let autoMessageSendMode = 'group'; // 'group' or 'numbers'
let autoMessageTargetGroup = '';
let autoMessageTargetNumbers = '';
let autoMessageText = '';
let autoMessageMedia = null;
let minIntervalActive = 1; // minutes
let maxIntervalActive = 2; // minutes
let nextTimeoutId = null;

function broadcastState() {
    io.emit('state-update', {
        clientStatus,
        qr: currentQR,
        isBotRunning,
        autoMessageSendMode,
        autoMessageTargetGroup,
        autoMessageTargetNumbers,
        autoMessageText,
        autoMessageMedia: !!autoMessageMedia,
        minIntervalActive,
        maxIntervalActive
    });
}

function initializeClient() {
    if (client) {
        client.destroy();
    }

    clientStatus = 'CONNECTING';
    currentQR = null;
    broadcastState();

    console.log('[WHATSAPP] Initializing client...');
    client = new Client({
        authStrategy: new LocalAuth(),
        puppeteer: {
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
            headless: 'new',
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--disable-gpu',
                '--disable-software-rasterizer',
                '--disable-extensions',
                '--disable-background-networking',
                '--disable-default-apps',
                '--disable-sync',
                '--disable-translate',
                '--disable-domain-reliability',
                '--js-flags=--max-old-space-size=256'
            ],
        }
    });

    client.on('qr', (qr) => {
        console.log('[WHATSAPP] QR Code received');
        currentQR = qr;
        clientStatus = 'DISCONNECTED';
        broadcastState();
    });

    client.on('ready', () => {
        console.log('[WHATSAPP] Client is ready!');
        currentQR = null;
        clientStatus = 'CONNECTED';
        io.emit('log', 'Client is ready and connected to WhatsApp!');
        broadcastState();
    });

    client.on('authenticated', () => {
        console.log('[WHATSAPP] Authenticated successfully');
    });

    client.on('auth_failure', (msg) => {
        console.error('[WHATSAPP] Authentication failure:', msg);
        io.emit('log', `Auth failure: ${msg}`);
    });

    client.on('disconnected', (reason) => {
        console.log('[WHATSAPP] Client disconnected:', reason);
        clientStatus = 'DISCONNECTED';
        currentQR = null;
        isBotRunning = false;
        clearTimeout(nextTimeoutId);
        io.emit('log', `Client was logged out: ${reason}`);
        broadcastState();
        // Restart client to get new QR
        console.log('[WHATSAPP] Restarting client...');
        initializeClient();
    });

    client.initialize().catch(err => {
        console.error('[WHATSAPP] Failed to initialize client:', err);
        clientStatus = 'DISCONNECTED';
        io.emit('log', `Initialization Error: ${err.message}`);
        broadcastState();
    });
}

// Bot auto-messaging logic
async function executeSendTask() {
    try {
        let mediaObj = null;
        if (autoMessageMedia) {
            mediaObj = new MessageMedia(autoMessageMedia.mimetype, autoMessageMedia.data, autoMessageMedia.filename);
        }

        if (autoMessageSendMode === 'group') {
            const chats = await client.getChats();
            const group = chats.find(chat => chat.isGroup && chat.name === autoMessageTargetGroup);
            if (group) {
                if (mediaObj) {
                    await group.sendMessage(mediaObj, { caption: autoMessageText || undefined });
                } else if (autoMessageText) {
                    await group.sendMessage(autoMessageText);
                }
                io.emit('log', `[${new Date().toLocaleTimeString()}] Sent auto-message to group ${group.name}`);
            } else {
                io.emit('log', `[${new Date().toLocaleTimeString()}] Group "${autoMessageTargetGroup}" not found.`);
            }
        } else if (autoMessageSendMode === 'numbers') {
            const numbers = autoMessageTargetNumbers.split(',').map(n => n.trim()).filter(n => n);
            for (const num of numbers) {
                const chatId = num.includes('@c.us') ? num : `${num}@c.us`;
                try {
                    if (mediaObj) {
                        await client.sendMessage(chatId, mediaObj, { caption: autoMessageText || undefined });
                    } else if (autoMessageText) {
                        await client.sendMessage(chatId, autoMessageText);
                    }
                    io.emit('log', `[${new Date().toLocaleTimeString()}] Sent auto-message to number ${num}`);
                } catch (numErr) {
                    io.emit('log', `[${new Date().toLocaleTimeString()}] Error sending to ${num}: ${numErr.message}`);
                }
                // Optional: add a small delay between sending to multiple numbers to avoid spam detection
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
    } catch (err) {
        io.emit('log', `Error executing send task: ${err.message}`);
    }
}

function scheduleNextMessage() {
    if (!isBotRunning) return;

    const minMs = minIntervalActive * 60000;
    const maxMs = maxIntervalActive * 60000;

    // Random time between minMs and maxMs
    const randomTimeMs = Math.floor(Math.random() * (maxMs - minMs + 1) + minMs);
    const secs = (randomTimeMs / 1000).toFixed(1);

    io.emit('log', `Next message scheduled in ${secs} seconds...`);

    nextTimeoutId = setTimeout(async () => {
        if (!isBotRunning) return;
        await executeSendTask();

        // Schedule the next one recursively
        scheduleNextMessage();
    }, randomTimeMs);
}

async function startAutoBotFlow() {
    try {
        if (autoMessageSendMode === 'group') {
            const chats = await client.getChats();
            const group = chats.find(chat => chat.isGroup && chat.name === autoMessageTargetGroup);

            if (group) {
                io.emit('log', `Group found! Starting auto-message loop for: ${group.name}`);
            } else {
                io.emit('log', `Group "${autoMessageTargetGroup}" not found.`);
                isBotRunning = false;
                broadcastState();
                return;
            }
        } else {
            io.emit('log', `Starting auto-message loop for numbers: ${autoMessageTargetNumbers}`);
        }

        isBotRunning = true;
        broadcastState();

        // Send the first message immediately
        await executeSendTask();

        // Schedule next
        scheduleNextMessage();
    } catch (error) {
        io.emit('log', `Error starting bot: ${error.message}`);
        isBotRunning = false;
        broadcastState();
    }
}


// --- API Endpoints ---

app.get('/health', (req, res) => {
    res.json({ 
        status: 'UP', 
        whatsapp: clientStatus, 
        bot: isBotRunning,
        time: new Date().toISOString()
    });
});

// Get all groups
app.get('/api/groups', async (req, res) => {
    console.log('[API] GET /groups requested');
    if (clientStatus !== 'CONNECTED' || !client) {
        return res.status(400).json({ error: 'Client not connected' });
    }

    try {
        console.log('[API] Fetching chats from WhatsApp client...');
        const chats = await client.getChats();
        console.log(`[API] Fetched ${chats.length} total chats.`);
        const groups = chats.filter(c => c.isGroup).map(c => ({ id: c.id._serialized, name: c.name }));
        console.log(`[API] Filtered down to ${groups.length} groups.`);
        res.json({ groups });
    } catch (err) {
        console.error('[API] Error fetching chats:', err);
        res.status(500).json({ error: 'Failed to fetch groups', details: err.message });
    }
});

app.post('/api/start', async (req, res) => {
    const { sendMode, groupName, targetNumbers, message, minMinutes, maxMinutes, media } = req.body;

    if (clientStatus !== 'CONNECTED') {
        return res.status(400).json({ error: 'Client not connected' });
    }

    if (!sendMode || (!message && !media) || minMinutes === undefined || maxMinutes === undefined) {
        return res.status(400).json({ error: 'Missing required configuration fields' });
    }

    if (sendMode === 'group' && !groupName) {
        return res.status(400).json({ error: 'Missing group name for group mode' });
    }

    if (sendMode === 'numbers' && !targetNumbers) {
        return res.status(400).json({ error: 'Missing target numbers for numbers mode' });
    }

    if (isBotRunning) {
        return res.status(400).json({ error: 'Bot is already running' });
    }

    autoMessageSendMode = sendMode;
    autoMessageTargetGroup = groupName || '';
    autoMessageTargetNumbers = targetNumbers || '';
    autoMessageText = message || '';
    autoMessageMedia = media || null;
    minIntervalActive = minMinutes;
    maxIntervalActive = maxMinutes;

    // Start flow
    await startAutoBotFlow();

    res.json({ success: true, message: 'Bot started' });
});

app.post('/api/stop', (req, res) => {
    isBotRunning = false;
    clearTimeout(nextTimeoutId);
    io.emit('log', 'Bot stopped by user.');
    broadcastState();
    res.json({ success: true, message: 'Bot stopped' });
});

const fs = require('fs');



app.post('/api/logout', async (req, res) => {
    try {
        console.log('[API] Processing Logout Request...');
        isBotRunning = false;
        clearTimeout(nextTimeoutId);

        if (client) {
            console.log('[API] Destroying WhatsApp Client...');
            await client.destroy();
            client = null;
        }

        console.log('[API] Deleting LocalAuth session folder...');
        const authDirPath = './.wwebjs_auth';
        if (fs.existsSync(authDirPath)) {
            // Force delete the directory and all locked files inside it
            fs.rmSync(authDirPath, { recursive: true, force: true });
        }

        console.log('[API] LocalAuth cleared. Re-initializing client for new QR code...');
        initializeClient();

        res.json({ success: true, message: 'Logged out successfully! Please scan new QR code.' });
    } catch (err) {
        console.error('[API] Error during hard logout:', err);
        res.status(500).json({ error: 'Failed to complete logout', details: err.message });
    }
});

const path = require('path');

// Serve frontend static files
app.use(express.static(path.join(__dirname, 'public')));

// Catch-all: serve index.html for any non-API route (SPA support)
app.use((req, res) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/socket.io/')) {
        console.log(`[SERVER] 404 - Not Found: ${req.method} ${req.url}`);
        return res.status(404).json({ error: 'Not Found', path: req.url });
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// --- Socket.io Handlers ---
io.on('connection', (socket) => {
    console.log('Frontend connected:', socket.id);
    // Send current state immediately on connect
    socket.emit('state-update', {
        clientStatus,
        qr: currentQR,
        isBotRunning,
        autoMessageSendMode,
        autoMessageTargetGroup,
        autoMessageTargetNumbers,
        autoMessageText,
        minIntervalActive,
        maxIntervalActive
    });
});


const HOST = '0.0.0.0';
const PORT = process.env.PORT || 3001;

server.listen(PORT, HOST, () => {
    console.log(`[SERVER] Backend server running on http://${HOST}:${PORT}`);
    console.log(`[SERVER] CORS allowed for all origins (*)`);
    // Initialize WhatsApp client
    initializeClient();
});
