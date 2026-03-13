const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');

const app = express();
app.use(cors()); // Allow all origins and methods

app.use(express.json({ limit: '60mb' }));
app.use(express.urlencoded({ limit: '60mb', extended: true }));

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: '*',
        methods: ['GET', 'POST']
    }
});

const sessions = {};

function broadcastState(sessionId) {
    const session = sessions[sessionId];
    if (!session) {
        console.log(`[BROADCAST - ${sessionId}] Session not found, skipping.`);
        return;
    }

    console.log(`[BROADCAST - ${sessionId}] Status: ${session.clientStatus}, QR present: ${!!session.currentQR}`);

    io.to(sessionId).emit('state-update', {
        sessionId,
        clientStatus: session.clientStatus,
        qr: session.currentQR,
        isBotRunning: session.isBotRunning,
        autoMessageSendMode: session.autoMessageSendMode,
        autoMessageTargetGroup: session.autoMessageTargetGroup,
        autoMessageTargetNumbers: session.autoMessageTargetNumbers,
        autoMessageText: session.autoMessageText,
        autoMessageMedia: !!session.autoMessageMedia,
        minIntervalActive: session.minIntervalActive,
    });
}

function sendLog(sessionId, message) {
    console.log(`[LOG - ${sessionId}] ${message}`);
    io.to(sessionId).emit('log', {
        sessionId,
        text: message,
        timestamp: new Date().toISOString()
    });
}

function initializeClient(sessionId) {
    if (!sessions[sessionId]) {
        sessions[sessionId] = {
            client: null,
            currentQR: null,
            clientStatus: 'DISCONNECTED',
            isBotRunning: false,
            autoMessageSendMode: 'group',
            autoMessageTargetGroup: '',
            autoMessageTargetNumbers: '',
            autoMessageText: '',
            autoMessageMedia: null,
            minIntervalActive: 1,
            maxIntervalActive: 2,
            nextTimeoutId: null
        };
    }

    const session = sessions[sessionId];

    if (session.client) {
        session.client.destroy();
    }

    session.clientStatus = 'CONNECTING';
    session.currentQR = null;
    broadcastState(sessionId);

    console.log(`[WHATSAPP - ${sessionId}] Initializing client...`);
    session.client = new Client({
        authStrategy: new LocalAuth({ clientId: sessionId }),
        puppeteer: {
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
            headless: 'new',
            protocolTimeout: 180000,
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
                '--js-flags=--max-old-space-size=256',
                '--disable-web-security',
                '--no-zygote',
                '--disable-features=IsolateOrigins,site-per-process'
            ],
        }
    });

    session.client.on('qr', (qr) => {
        console.log(`[WHATSAPP - ${sessionId}] QR Code received`);
        session.currentQR = qr;
        session.clientStatus = 'DISCONNECTED';
        broadcastState(sessionId);
    });

    session.client.on('ready', () => {
        console.log(`[WHATSAPP - ${sessionId}] Client is ready!`);
        session.currentQR = null;
        session.clientStatus = 'CONNECTED';
        sendLog(sessionId, 'Client is ready and connected to WhatsApp!');
        broadcastState(sessionId);
    });

    session.client.on('authenticated', () => {
        console.log(`[WHATSAPP - ${sessionId}] Authenticated successfully`);
    });

    session.client.on('auth_failure', (msg) => {
        console.error(`[WHATSAPP - ${sessionId}] Authentication failure:`, msg);
        sendLog(sessionId, `Auth failure: ${msg}`);
    });

    session.client.on('disconnected', (reason) => {
        console.log(`[WHATSAPP - ${sessionId}] Client disconnected:`, reason);
        session.clientStatus = 'DISCONNECTED';
        session.currentQR = null;
        session.isBotRunning = false;
        clearTimeout(session.nextTimeoutId);
        sendLog(sessionId, `Client was logged out: ${reason}`);
        broadcastState(sessionId);
        // Restart client to get new QR
        console.log(`[WHATSAPP - ${sessionId}] Restarting client...`);
        initializeClient(sessionId);
    });

    session.client.initialize().catch(err => {
        console.error(`[WHATSAPP - ${sessionId}] Failed to initialize client:`, err);
        session.clientStatus = 'DISCONNECTED';
        sendLog(sessionId, `Initialization Error: ${err.message}`);
        broadcastState(sessionId);
    });
}

// Bot auto-messaging logic
async function executeSendTask(sessionId) {
    const session = sessions[sessionId];
    if (!session || !session.client) {
        console.error(`[EXECUTE - ${sessionId}] Session or client not found`);
        return;
    }

    try {
        let mediaObj = null;
        if (session.autoMessageMedia) {
            mediaObj = new MessageMedia(session.autoMessageMedia.mimetype, session.autoMessageMedia.data, session.autoMessageMedia.filename);
        }

        if (session.autoMessageSendMode === 'group') {
            console.log(`[EXECUTE - ${sessionId}] Getting chats for group mode...`);
            const chats = await session.client.getChats().catch(e => {
                throw new Error(`Failed to get chats: ${e.message}`);
            });
            
            const group = chats.find(chat => chat.isGroup && chat.name === session.autoMessageTargetGroup);
            if (group) {
                if (mediaObj) {
                    await group.sendMessage(mediaObj, { caption: session.autoMessageText || undefined });
                } else if (session.autoMessageText) {
                    await group.sendMessage(session.autoMessageText);
                }
                sendLog(sessionId, `[${new Date().toLocaleTimeString()}] Sent auto-message to group ${group.name}`);
            } else {
                sendLog(sessionId, `[${new Date().toLocaleTimeString()}] Group "${session.autoMessageTargetGroup}" not found.`);
            }
        } else if (session.autoMessageSendMode === 'numbers') {
            const numbers = session.autoMessageTargetNumbers.split(',').map(n => n.trim()).filter(n => n);
            for (const num of numbers) {
                const chatId = num.includes('@c.us') ? num : `${num}@c.us`;
                try {
                    if (mediaObj) {
                        await session.client.sendMessage(chatId, mediaObj, { caption: session.autoMessageText || undefined });
                    } else if (session.autoMessageText) {
                        await session.client.sendMessage(chatId, session.autoMessageText);
                    }
                    sendLog(sessionId, `[${new Date().toLocaleTimeString()}] Sent auto-message to number ${num}`);
                } catch (numErr) {
                    console.error(`[EXECUTE - ${sessionId}] Error sending to ${num}:`, numErr.message);
                    sendLog(sessionId, `[${new Date().toLocaleTimeString()}] Error sending to ${num}: ${numErr.message}`);
                    if (numErr.message.includes('timeout') || numErr.message.includes('Runtime')) {
                        sendLog(sessionId, `[CRITICAL] Browser timeout detected. You might need to refresh the session.`);
                    }
                }
                await new Promise(resolve => setTimeout(resolve, 2000));
            }
        }
    } catch (err) {
        console.error(`[EXECUTE - ${sessionId}] General task error:`, err);
        sendLog(sessionId, `Error executing send task: ${err.message}`);
        if (err.message.includes('timeout') || err.message.includes('Runtime')) {
            sendLog(sessionId, `[CRITICAL] Browser responsiveness issue detected. Applied timeout fix. Monitoring...`);
        }
    }
}

function scheduleNextMessage(sessionId) {
    const session = sessions[sessionId];
    if (!session || !session.isBotRunning) return;

    const minMs = session.minIntervalActive * 60000;
    const maxMs = session.maxIntervalActive * 60000;

    // Random time between minMs and maxMs
    const randomTimeMs = Math.floor(Math.random() * (maxMs - minMs + 1) + minMs);
    const secs = (randomTimeMs / 1000).toFixed(1);

    sendLog(sessionId, `Next message scheduled in ${secs} seconds...`);

    session.nextTimeoutId = setTimeout(async () => {
        if (!session.isBotRunning) return;
        await executeSendTask(sessionId);

        // Schedule the next one recursively
        scheduleNextMessage(sessionId);
    }, randomTimeMs);
}

async function startAutoBotFlow(sessionId) {
    const session = sessions[sessionId];
    if (!session || !session.client) return;

    try {
        if (session.autoMessageSendMode === 'group') {
            const chats = await session.client.getChats();
            const group = chats.find(chat => chat.isGroup && chat.name === session.autoMessageTargetGroup);

            if (group) {
                sendLog(sessionId, `Group found! Starting auto-message loop for: ${group.name}`);
            } else {
                sendLog(sessionId, `Group "${session.autoMessageTargetGroup}" not found.`);
                session.isBotRunning = false;
                broadcastState(sessionId);
                return;
            }
        } else {
            sendLog(sessionId, `Starting auto-message loop for numbers: ${session.autoMessageTargetNumbers}`);
        }

        session.isBotRunning = true;
        broadcastState(sessionId);

        // Send the first message immediately
        await executeSendTask(sessionId);

        // Schedule next
        scheduleNextMessage(sessionId);
    } catch (error) {
        sendLog(sessionId, `Error starting bot: ${error.message}`);
        session.isBotRunning = false;
        broadcastState(sessionId);
    }
}


// --- API Endpoints ---

// --- API Endpoints ---

app.get('/health', (req, res) => {
    res.json({ 
        status: 'UP', 
        activeSessions: Object.keys(sessions).length,
        time: new Date().toISOString()
    });
});

app.get('/api/sessions', (req, res) => {
    const sessionList = Object.keys(sessions).map(id => ({
        id,
        status: sessions[id].clientStatus,
        isBotRunning: sessions[id].isBotRunning
    }));
    res.json({ sessions: sessionList });
});

app.post('/api/sessions', (req, res) => {
    const { sessionId } = req.body;
    if (!sessionId) return res.status(400).json({ error: 'sessionId is required' });
    
    // Sanitize sessionId to avoid path traversal if used in file paths
    const sanitizedId = sessionId.replace(/[^a-zA-Z0-9_-]/g, '');
    
    if (sessions[sanitizedId]) {
        return res.json({ success: true, message: 'Session already exists', sessionId: sanitizedId });
    }
    
    initializeClient(sanitizedId);
    res.json({ success: true, message: 'Session initialized', sessionId: sanitizedId });
});

app.delete('/api/sessions/:sessionId', async (req, res) => {
    const { sessionId } = req.params;
    console.log(`[SERVER] Deleting session: ${sessionId}`);

    if (sessions[sessionId]) {
        if (sessions[sessionId].client) {
            try {
                await sessions[sessionId].client.destroy();
            } catch (err) {
                console.error(`Error destroying client for ${sessionId}:`, err);
            }
        }
        delete sessions[sessionId];
    }

    // Delete session data from disk
    const sessionPath = path.join(__dirname, '.wwebjs_auth', `session-${sessionId}`);
    if (fs.existsSync(sessionPath)) {
        try {
            fs.rmSync(sessionPath, { recursive: true, force: true });
            console.log(`[SERVER] Deleted session data at ${sessionPath}`);
        } catch (err) {
            console.error(`Error deleting session directory for ${sessionId}:`, err);
        }
    }

    res.json({ success: true, message: `Session ${sessionId} deleted` });
});

// Get all groups
app.get('/api/groups', async (req, res) => {
    const { sessionId } = req.query;
    const session = sessions[sessionId];

    if (!session || session.clientStatus !== 'CONNECTED' || !session.client) {
        return res.status(400).json({ error: 'Client not connected for this session' });
    }

    try {
        console.log(`[API - ${sessionId}] Fetching chats...`);
        const chats = await session.client.getChats();
        const groups = chats.filter(c => c.isGroup).map(c => ({ id: c.id._serialized, name: c.name }));
        res.json({ groups });
    } catch (err) {
        console.error(`[API - ${sessionId}] Error fetching chats:`, err);
        res.status(500).json({ error: 'Failed to fetch groups', details: err.message });
    }
});

app.post('/api/start', async (req, res) => {
    const { sessionId, sendMode, groupName, targetNumbers, message, minMinutes, maxMinutes, media } = req.body;
    const session = sessions[sessionId];

    if (!session || session.clientStatus !== 'CONNECTED') {
        return res.status(400).json({ error: 'Client not connected for this session' });
    }

    if (!sendMode || (!message && !media) || minMinutes === undefined || maxMinutes === undefined) {
        return res.status(400).json({ error: 'Missing required configuration fields' });
    }

    if (session.isBotRunning) {
        return res.status(400).json({ error: 'Bot is already running for this session' });
    }

    session.autoMessageSendMode = sendMode;
    session.autoMessageTargetGroup = groupName || '';
    session.autoMessageTargetNumbers = targetNumbers || '';
    session.autoMessageText = message || '';
    session.autoMessageMedia = media || null;
    session.minIntervalActive = minMinutes;
    session.maxIntervalActive = maxMinutes;

    // Start flow
    await startAutoBotFlow(sessionId);

    res.json({ success: true, message: 'Bot started' });
});

app.post('/api/stop', (req, res) => {
    const { sessionId } = req.body;
    const session = sessions[sessionId];

    if (!session) return res.status(400).json({ error: 'Session not found' });

    session.isBotRunning = false;
    clearTimeout(session.nextTimeoutId);
    sendLog(sessionId, 'Bot stopped by user.');
    broadcastState(sessionId);
    res.json({ success: true, message: 'Bot stopped' });
});

const fs = require('fs');

app.post('/api/logout', async (req, res) => {
    const { sessionId } = req.body;
    const session = sessions[sessionId];

    if (!session) return res.status(400).json({ error: 'Session not found' });

    try {
        console.log(`[API - ${sessionId}] Processing Logout Request...`);
        session.isBotRunning = false;
        clearTimeout(session.nextTimeoutId);

        if (session.client) {
            console.log(`[API - ${sessionId}] Destroying WhatsApp Client...`);
            await session.client.destroy();
            session.client = null;
        }

        console.log(`[API - ${sessionId}] Deleting session data...`);
        const authDirPath = `./.wwebjs_auth/session-${sessionId}`;
        if (fs.existsSync(authDirPath)) {
            fs.rmSync(authDirPath, { recursive: true, force: true });
        }

        // Re-initialize to get new QR
        initializeClient(sessionId);

        res.json({ success: true, message: 'Logged out successfully!' });
    } catch (err) {
        console.error(`[API - ${sessionId}] Error during logout:`, err);
        res.status(500).json({ error: 'Failed to complete logout', details: err.message });
    }
});

const path = require('path');

// Serve frontend static files
app.use(express.static(path.join(__dirname, 'public')));

// Catch-all: serve index.html for any non-API route (SPA support)
app.use((req, res) => {
    if (req.url.startsWith('/api/') || req.url.startsWith('/socket.io/')) {
        return res.status(404).json({ error: 'Not Found', path: req.url });
    }
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// --- Socket.io Handlers ---
io.on('connection', (socket) => {
    console.log('Frontend connected:', socket.id);

    socket.on('join-session', (sessionId) => {
        console.log(`Socket ${socket.id} joining session ${sessionId}`);
        socket.join(sessionId);
        if (sessions[sessionId]) {
            broadcastState(sessionId);
        }
    });
});


const HOST = '0.0.0.0';
const PORT = process.env.PORT || 3001;

server.listen(PORT, HOST, () => {
    console.log(`[SERVER] Backend server running on http://${HOST}:${PORT}`);
    
    // Auto-discover existing sessions in .wwebjs_auth
    const authDir = './.wwebjs_auth';
    if (fs.existsSync(authDir)) {
        const folders = fs.readdirSync(authDir);
        folders.forEach(folder => {
            if (folder.startsWith('session-')) {
                const sessionId = folder.replace('session-', '');
                console.log(`[SERVER] Auto-restoring session: ${sessionId}`);
                initializeClient(sessionId);
            }
        });
    }

    // Initialize a "default" session if none exist
    if (Object.keys(sessions).length === 0) {
        console.log('[SERVER] Initializing default session...');
        initializeClient('default');
    }
});
