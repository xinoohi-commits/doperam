const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const fs = require('fs');
const path = require('path');

const app = express();
app.use(cors());

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

// --- Utility: Timeout wrapper for Puppeteer calls ---
function withTimeout(promise, ms, label = 'Operation') {
    return Promise.race([
        promise,
        new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`${label} timed out after ${ms / 1000}s`)), ms)
        )
    ]);
}

// --- Utility: Retry with exponential backoff ---
async function retryWithBackoff(fn, { maxRetries = 3, baseDelayMs = 5000, label = 'Operation' } = {}) {
    let lastError;
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
            return await fn();
        } catch (err) {
            lastError = err;
            if (attempt < maxRetries) {
                const delay = baseDelayMs * Math.pow(3, attempt - 1); // 5s, 15s, 45s
                console.log(`[RETRY] ${label} attempt ${attempt}/${maxRetries} failed: ${err.message}. Retrying in ${delay / 1000}s...`);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }
    throw lastError;
}

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
            minIntervalActive: 15,
            maxIntervalActive: 20,
            nextTimeoutId: null,
            // --- New stability fields ---
            cachedGroupId: null,       // cached group chat ID to avoid getChats() every cycle
            consecutiveFailures: 0,    // track failures for auto-restart
            pendingBotConfig: null,    // preserve bot config across auto-restarts
        };
    }

    const session = sessions[sessionId];

    if (session.client) {
        try { session.client.destroy(); } catch (e) { /* ignore */ }
    }

    session.clientStatus = 'CONNECTING';
    session.currentQR = null;
    session.cachedGroupId = null;
    session.consecutiveFailures = 0;
    broadcastState(sessionId);

    console.log(`[WHATSAPP - ${sessionId}] Initializing client...`);
    session.client = new Client({
        authStrategy: new LocalAuth({ clientId: sessionId }),
        puppeteer: {
            executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
            headless: true,
            protocolTimeout: 300000, // 5 minutes (up from 3 minutes)
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
                '--js-flags=--max-old-space-size=512',
                '--disable-web-security',
                '--no-zygote',
                '--disable-features=IsolateOrigins,site-per-process',
                '--disable-component-update',
                '--disable-background-timer-throttling',
                '--disable-backgrounding-occluded-windows',
                '--disable-renderer-backgrounding',
                '--disable-logging',
                '--disable-breakpad',
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
        session.consecutiveFailures = 0;
        sendLog(sessionId, 'Client is ready and connected to WhatsApp!');
        broadcastState(sessionId);

        // If there's a pending bot config (from auto-restart), resume the bot
        if (session.pendingBotConfig) {
            const config = session.pendingBotConfig;
            session.pendingBotConfig = null;
            console.log(`[WHATSAPP - ${sessionId}] Resuming bot after auto-restart...`);
            sendLog(sessionId, '🔄 Auto-resuming bot after browser restart...');
            
            session.autoMessageSendMode = config.sendMode;
            session.autoMessageTargetGroup = config.groupName;
            session.autoMessageTargetNumbers = config.targetNumbers;
            session.autoMessageText = config.message;
            session.autoMessageMedia = config.media;
            session.minIntervalActive = config.minMinutes;
            session.maxIntervalActive = config.maxMinutes;
            
            // Small delay to let WhatsApp Web fully load
            setTimeout(() => startAutoBotFlow(sessionId), 10000);
        }
    });

    session.client.on('authenticated', () => {
        console.log(`[WHATSAPP - ${sessionId}] Authenticated successfully`);
    });

    session.client.on('auth_failure', (msg) => {
        console.error(`[WHATSAPP - ${sessionId}] Authentication failure:`, msg);
        sendLog(sessionId, `Auth failure: ${msg}`);
    });

    session.client.on('error', (err) => {
        console.error(`[WHATSAPP - ${sessionId}] Client error:`, err);
        sendLog(sessionId, `⚠️ Browser error: ${err.message}`);
        // If it's a fatal error, handle it as a failure
        if (err.message.includes('Session closed') || err.message.includes('Target closed') || err.message.includes('Protocol error')) {
            handleRepeatedFailure(sessionId);
        }
    });

    session.client.on('disconnected', (reason) => {
        console.log(`[WHATSAPP - ${sessionId}] Client disconnected:`, reason);
        session.clientStatus = 'DISCONNECTED';
        session.currentQR = null;
        session.isBotRunning = false;
        session.cachedGroupId = null;
        clearTimeout(session.nextTimeoutId);
        sendLog(sessionId, `Client was logged out: ${reason}`);
        broadcastState(sessionId);
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

// --- Auto-restart browser on repeated failures ---
async function handleRepeatedFailure(sessionId) {
    const session = sessions[sessionId];
    if (!session) return;

    session.consecutiveFailures++;
    console.log(`[STABILITY - ${sessionId}] Consecutive failures: ${session.consecutiveFailures}/3`);

    if (session.consecutiveFailures >= 3) {
        sendLog(sessionId, '⚠️ 3 consecutive failures detected. Auto-restarting browser...');
        
        // Save current bot config to resume after restart
        session.pendingBotConfig = {
            sendMode: session.autoMessageSendMode,
            groupName: session.autoMessageTargetGroup,
            targetNumbers: session.autoMessageTargetNumbers,
            message: session.autoMessageText,
            media: session.autoMessageMedia,
            minMinutes: session.minIntervalActive,
            maxMinutes: session.maxIntervalActive,
        };

        // Stop the bot loop
        session.isBotRunning = false;
        clearTimeout(session.nextTimeoutId);
        session.cachedGroupId = null;
        broadcastState(sessionId);

        // Destroy and re-initialize (auth is preserved via LocalAuth)
        try {
            if (session.client) {
                await session.client.destroy();
                session.client = null;
            }
        } catch (e) {
            console.error(`[STABILITY - ${sessionId}] Error destroying client:`, e.message);
        }

        // Wait a moment before re-initializing
        await new Promise(resolve => setTimeout(resolve, 5000));
        sendLog(sessionId, '🔄 Re-initializing WhatsApp client...');
        initializeClient(sessionId);
    }
}

// --- Bot auto-messaging logic (OPTIMIZED) ---
async function executeSendTask(sessionId) {
    const session = sessions[sessionId];
    if (!session || !session.client) {
        console.error(`[EXECUTE - ${sessionId}] Session or client not found`);
        return;
    }

    try {
        await retryWithBackoff(async () => {
            let mediaObj = null;
            if (session.autoMessageMedia) {
                mediaObj = new MessageMedia(
                    session.autoMessageMedia.mimetype,
                    session.autoMessageMedia.data,
                    session.autoMessageMedia.filename
                );
            }

            if (session.autoMessageSendMode === 'group') {
                // Use cached group ID instead of fetching all chats every time
                if (!session.cachedGroupId) {
                    console.log(`[EXECUTE - ${sessionId}] No cached group ID, looking up group...`);
                    const chats = await withTimeout(
                        session.client.getChats(),
                        120000,
                        'getChats'
                    );
                    const group = chats.find(chat => chat.isGroup && chat.name === session.autoMessageTargetGroup);
                    if (group) {
                        session.cachedGroupId = group.id._serialized;
                        console.log(`[EXECUTE - ${sessionId}] Cached group ID: ${session.cachedGroupId}`);
                    } else {
                        throw new Error(`Group "${session.autoMessageTargetGroup}" not found`);
                    }
                }

                // Use getChatById with cached ID (much lighter than getChats)
                console.log(`[EXECUTE - ${sessionId}] Sending to cached group: ${session.cachedGroupId}`);
                const chat = await withTimeout(
                    session.client.getChatById(session.cachedGroupId),
                    60000,
                    'getChatById'
                );

                if (mediaObj) {
                    await withTimeout(
                        chat.sendMessage(mediaObj, { caption: session.autoMessageText || undefined }),
                        60000,
                        'sendMessage(media)'
                    );
                } else if (session.autoMessageText) {
                    await withTimeout(
                        chat.sendMessage(session.autoMessageText),
                        60000,
                        'sendMessage(text)'
                    );
                }
                sendLog(sessionId, `✅ [${new Date().toLocaleTimeString()}] Sent auto-message to group`);

            } else if (session.autoMessageSendMode === 'numbers') {
                const numbers = session.autoMessageTargetNumbers.split(',').map(n => n.trim()).filter(n => n);
                for (const num of numbers) {
                    const chatId = num.includes('@c.us') ? num : `${num}@c.us`;
                    
                    try {
                        console.log(`[EXECUTE - ${sessionId}] Preparing to send to ${num} with presence simulation...`);
                        const chat = await withTimeout(
                            session.client.getChatById(chatId),
                            30000,
                            `getChatById(${num})`
                        );

                        // 1. Mark as seen
                        try {
                            await chat.sendSeen();
                        } catch (e) {
                            console.warn(`[EXECUTE - ${sessionId}] sendSeen failed for ${num}: ${e.message}`);
                        }
                        
                        // 2. Random delay before typing (1-3s)
                        await new Promise(resolve => setTimeout(resolve, 1000 + Math.random() * 2000));
                        
                        // 3. Simulate typing
                        try {
                            await chat.sendStateTyping();
                        } catch (e) {
                            console.warn(`[EXECUTE - ${sessionId}] sendStateTyping failed for ${num}: ${e.message}`);
                        }
                        
                        // 4. Randomized "typing" duration (3-7s)
                        const typingDuration = 3000 + Math.random() * 4000;
                        await new Promise(resolve => setTimeout(resolve, typingDuration));

                        if (mediaObj) {
                            await withTimeout(
                                session.client.sendMessage(chatId, mediaObj, { caption: session.autoMessageText || undefined }),
                                60000,
                                `sendMessage(media to ${num})`
                            );
                        } else if (session.autoMessageText) {
                            await withTimeout(
                                session.client.sendMessage(chatId, session.autoMessageText),
                                60000,
                                `sendMessage(text to ${num})`
                            );
                        }
                        
                        // 5. Explicitly clear typing state (though sending usually does this)
                        try { await chat.clearState(); } catch (e) {}

                        sendLog(sessionId, `✅ [${new Date().toLocaleTimeString()}] Sent auto-message to ${num}`);
                    } catch (numErr) {
                        console.error(`[EXECUTE - ${sessionId}] Failed to send to ${num}:`, numErr.message);
                        sendLog(sessionId, `⚠️ Failed to send to ${num}: ${numErr.message}`);
                    }

                    // Randomized delay between DIFFERENT numbers (10-25s) to avoid bot-like pattern
                    const interNumberDelay = 10000 + Math.random() * 15000;
                    if (numbers.indexOf(num) < numbers.length - 1) {
                        console.log(`[EXECUTE - ${sessionId}] Waiting ${Math.round(interNumberDelay/1000)}s before next number...`);
                        await new Promise(resolve => setTimeout(resolve, interNumberDelay));
                    }
                }
            }
        }, {
            maxRetries: 3,
            baseDelayMs: 5000,
            label: `SendTask(${sessionId})`
        });

        // Reset failure count on success
        session.consecutiveFailures = 0;

    } catch (err) {
        console.error(`[EXECUTE - ${sessionId}] All retries exhausted:`, err.message);
        sendLog(sessionId, `❌ Send failed after 3 retries: ${err.message}`);

        // If it's a timeout/protocol error, invalidate the cached group ID
        if (err.message.includes('timeout') || err.message.includes('Runtime') || err.message.includes('Protocol')) {
            session.cachedGroupId = null;
            sendLog(sessionId, '🔧 Cleared cached group ID due to browser issue.');
        }

        // Track failure and potentially auto-restart
        await handleRepeatedFailure(sessionId);
    }
}

function scheduleNextMessage(sessionId) {
    const session = sessions[sessionId];
    if (!session || !session.isBotRunning) return;

    const minMs = session.minIntervalActive * 1000;
    const maxMs = session.maxIntervalActive * 1000;

    const randomTimeMs = Math.floor(Math.random() * (maxMs - minMs + 1) + minMs);
    const secs = (randomTimeMs / 1000).toFixed(1);

    sendLog(sessionId, `⏳ Next message in ${secs} seconds...`);

    session.nextTimeoutId = setTimeout(async () => {
        if (!session.isBotRunning) return;
        await executeSendTask(sessionId);

        // Only schedule next if bot is still running (might have been stopped by auto-restart)
        if (session.isBotRunning) {
            scheduleNextMessage(sessionId);
        }
    }, randomTimeMs);
}

async function startAutoBotFlow(sessionId) {
    const session = sessions[sessionId];
    if (!session || !session.client) return;

    try {
        if (session.autoMessageSendMode === 'group') {
            sendLog(sessionId, `🔍 Looking up group: "${session.autoMessageTargetGroup}"...`);
            const chats = await withTimeout(
                session.client.getChats(),
                120000,
                'getChats(startup)'
            );
            const group = chats.find(chat => chat.isGroup && chat.name === session.autoMessageTargetGroup);

            if (group) {
                // Cache the group ID for all future sends
                session.cachedGroupId = group.id._serialized;
                sendLog(sessionId, `✅ Group found! Cached ID: ${session.cachedGroupId}`);
                sendLog(sessionId, `🚀 Starting auto-message loop for: ${group.name}`);
            } else {
                sendLog(sessionId, `❌ Group "${session.autoMessageTargetGroup}" not found.`);
                session.isBotRunning = false;
                broadcastState(sessionId);
                return;
            }
        } else {
            sendLog(sessionId, `🚀 Starting auto-message loop for numbers: ${session.autoMessageTargetNumbers}`);
        }

        session.isBotRunning = true;
        session.consecutiveFailures = 0;
        broadcastState(sessionId);

        // Send the first message immediately
        await executeSendTask(sessionId);

        // Schedule next (only if bot is still running)
        if (session.isBotRunning) {
            scheduleNextMessage(sessionId);
        }
    } catch (error) {
        sendLog(sessionId, `❌ Error starting bot: ${error.message}`);
        session.isBotRunning = false;
        broadcastState(sessionId);
    }
}


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
        const chats = await withTimeout(
            session.client.getChats(),
            120000,
            'getChats(API)'
        );
        const groups = chats.filter(c => c.isGroup).map(c => ({ id: c.id._serialized, name: c.name }));
        res.json({ groups });
    } catch (err) {
        console.error(`[API - ${sessionId}] Error fetching chats:`, err);
        res.status(500).json({ error: 'Failed to fetch groups', details: err.message });
    }
});

app.post('/api/start', async (req, res) => {
    const { sessionId, sendMode, groupName, targetNumbers, message, minSeconds, maxSeconds, media } = req.body;
    const session = sessions[sessionId];

    if (!session || session.clientStatus !== 'CONNECTED') {
        return res.status(400).json({ error: 'Client not connected for this session' });
    }

    if (!sendMode || (!message && !media) || minSeconds === undefined || maxSeconds === undefined) {
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
    session.minIntervalActive = minSeconds;
    session.maxIntervalActive = maxSeconds;
    session.cachedGroupId = null; // Clear cache on new start

    await startAutoBotFlow(sessionId);

    res.json({ success: true, message: 'Bot started' });
});

app.post('/api/stop', (req, res) => {
    const { sessionId } = req.body;
    const session = sessions[sessionId];

    if (!session) return res.status(400).json({ error: 'Session not found' });

    session.isBotRunning = false;
    session.pendingBotConfig = null; // Cancel any pending auto-restart resume
    clearTimeout(session.nextTimeoutId);
    session.cachedGroupId = null;
    sendLog(sessionId, 'Bot stopped by user.');
    broadcastState(sessionId);
    res.json({ success: true, message: 'Bot stopped' });
});

app.post('/api/logout', async (req, res) => {
    const { sessionId } = req.body;
    const session = sessions[sessionId];

    if (!session) return res.status(400).json({ error: 'Session not found' });

    try {
        console.log(`[API - ${sessionId}] Processing Logout Request...`);
        session.isBotRunning = false;
        session.pendingBotConfig = null;
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

        initializeClient(sessionId);

        res.json({ success: true, message: 'Logged out successfully!' });
    } catch (err) {
        console.error(`[API - ${sessionId}] Error during logout:`, err);
        res.status(500).json({ error: 'Failed to complete logout', details: err.message });
    }
});

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
