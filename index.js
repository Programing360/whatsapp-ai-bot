require('dotenv').config();
const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const Groq = require('groq-sdk');
const mongoose = require('mongoose');
const Conversation = require('./models/Conversation');

// ── Global Error & Promise Rejection Handlers ──────────────────────────────
process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT EXCEPTION] Process caught error:', err.stack || err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[UNHANDLED REJECTION] Unhandled Promise Rejection:', reason);
});
// ─────────────────────────────────────────────────────────────────────────────

// ── Startup env validation ───────────────────────────────────────────────────
const REQUIRED_ENV = ['GROQ_API_KEY', 'MONGODB_URI'];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length > 0) {
    console.error(`[STARTUP] ⚠️  Missing required environment variables: ${missingEnv.join(', ')}`);
    console.error('[STARTUP]    Set them in Railway dashboard → Variables tab.');
    // Don't exit — Express server still starts so health check passes;
    // WhatsApp client will fail gracefully when it tries to use them.
}
console.log('[STARTUP] GROQ_API_KEY present:', !!process.env.GROQ_API_KEY);
console.log('[STARTUP] MONGODB_URI present:', !!process.env.MONGODB_URI);
console.log('[STARTUP] GROQ_MODEL:', process.env.GROQ_MODEL || 'llama-3.3-70b-versatile (default)');
console.log('[STARTUP] PUPPETEER_EXECUTABLE_PATH:', process.env.PUPPETEER_EXECUTABLE_PATH || '(not set — will use bundled Chromium)');
// ─────────────────────────────────────────────────────────────────────────────
const fs = require('fs');
const { execSync } = require('child_process');

// Probe common Chromium binary locations — path varies by distro/install method
function findChromium() {
    const candidates = [
        process.env.PUPPETEER_EXECUTABLE_PATH,
        '/root/.nix-profile/bin/chromium',
        '/nix/var/nix/profiles/default/bin/chromium',
        '/usr/bin/google-chrome-stable',
        '/usr/bin/google-chrome',
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/local/bin/chromium',
    ].filter(Boolean);

    for (const p of candidates) {
        try {
            fs.accessSync(p, fs.constants.X_OK);
            // Validate that it actually runs and isn't an Ubuntu snap stub script
            const output = execSync(`"${p}" --version`, {
                timeout: 3000,
                stdio: ['ignore', 'pipe', 'pipe']
            }).toString();

            if (output.includes('Chromium') || output.includes('Chrome')) {
                console.log(`[CHROMIUM] Validated executable at: ${p} (${output.trim()})`);
                return p;
            }
        } catch { /* not executable, timed out, or snap stub error */ }
    }
    console.warn('[CHROMIUM] ⚠️  No working system Chromium binary found — Puppeteer will try to use its bundled version.');
    return undefined;
}

const CHROMIUM_PATH = findChromium();


// WhatsApp connection state
let currentQRDataURL = null;   // base64 PNG data URL of the latest QR code
let isClientReady = false;     // true once whatsapp-web.js fires 'ready'

// Initialize Express server for Railway health check + QR viewer
const app = express();
const PORT = process.env.PORT || 3000;

// Health check
app.get('/', (req, res) => {
    res.status(200).send('WhatsApp AI Bot is running!');
});

// QR Code viewer — displays a scannable QR image in the browser
app.get('/qr', async (req, res) => {
    if (isClientReady) {
        return res.status(200).send(`
            <!DOCTYPE html>
            <html><head><title>WhatsApp Bot Status</title>
            <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f0f0f0;}
            .box{background:#fff;padding:2rem 3rem;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.1);text-align:center;}
            h2{color:#25d366;margin:0 0 .5rem} p{color:#555;margin:0}</style></head>
            <body><div class='box'><h2>✅ Already Connected</h2><p>WhatsApp client is active and ready.</p></div></body></html>
        `);
    }

    if (!currentQRDataURL) {
        return res.status(202).send(`
            <!DOCTYPE html>
            <html><head><title>WhatsApp Bot — Waiting for QR</title>
            <meta http-equiv='refresh' content='5'>
            <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#f0f0f0;}
            .box{background:#fff;padding:2rem 3rem;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.1);text-align:center;}
            h2{color:#888;margin:0 0 .5rem} p{color:#777;margin:0 0 1rem} small{color:#aaa}</style></head>
            <body><div class='box'><h2>⏳ Waiting for QR Code…</h2>
            <p>The WhatsApp client is still initialising. This page refreshes every 5 seconds.</p>
            <small>If it takes more than 30 seconds, check the container logs.</small></div></body></html>
        `);
    }

    res.status(200).send(`
        <!DOCTYPE html>
        <html><head><title>Scan WhatsApp QR</title>
        <meta http-equiv='refresh' content='30'>
        <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#f0f0f0;}
        .box{background:#fff;padding:2rem 2.5rem;border-radius:12px;box-shadow:0 4px 20px rgba(0,0,0,.1);text-align:center;max-width:380px;}
        h2{color:#128c7e;margin:0 0 .25rem} p{color:#555;margin:0 0 1.25rem;font-size:.9rem}
        img{width:280px;height:280px;border:1px solid #eee;border-radius:8px}
        small{display:block;margin-top:1rem;color:#aaa;font-size:.8rem}</style></head>
        <body><div class='box'>
        <h2>📱 Scan with WhatsApp</h2>
        <p>Open WhatsApp → Linked Devices → Link a Device</p>
        <img src='${currentQRDataURL}' alt='WhatsApp QR Code' />
        <small>Page auto-refreshes every 30 s. Reload if QR expires.</small>
        </div></body></html>
    `);
});

// Status endpoint — JSON
app.get('/status', (req, res) => {
    res.json({
        status: isClientReady ? 'connected' : 'waiting_for_qr',
        hasQR: !!currentQRDataURL,
        message: isClientReady
            ? 'WhatsApp client is connected and ready.'
            : 'Waiting for QR code scan.'
    });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Express HTTP server listening on 0.0.0.0:${PORT}`);
    console.log(`   Routes: GET /  GET /qr  GET /status`);
    console.log(`   PORT env value: ${process.env.PORT || '(not set, using 3000)'}`);
});

// Initialize Groq AI client
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Parse and sanitize MongoDB URI
let mongoURI = (process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/whatsapp-ai-bot').trim();
if (mongoURI.startsWith('MONGODB_URI=')) {
    mongoURI = mongoURI.replace(/^MONGODB_URI=/, '').trim();
}

// In-memory fallback store for active sessions if DB is offline
const inMemoryHistory = new Map();

// Connect to MongoDB
mongoose.connect(mongoURI)
    .then(() => console.log('Connected to MongoDB successfully!'))
    .catch((err) => console.error('MongoDB connection error:', err.message));

// Initialize WhatsApp Web client
const SESSION_PATH = process.env.SESSION_DATA_PATH || './.wwebjs_auth';
console.log('[AUTH] Session storage directory:', SESSION_PATH);
console.log('[PUPPETEER] Launching with executablePath:', CHROMIUM_PATH || '(bundled)');

const client = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_PATH }),
    puppeteer: {
        headless: true,
        executablePath: CHROMIUM_PATH,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--single-process',
            '--disable-gpu',
            '--disable-extensions',
            '--disable-background-networking',
            '--disable-default-apps',
            '--mute-audio',
            '--no-default-browser-check'
        ]
    }
});

client.on('qr', async (qr) => {
    console.log('[QR] New QR code received — scan via /qr route or ASCII below:');
    // ASCII fallback for local terminal
    qrcode.generate(qr, { small: true });
    // Generate browser-viewable PNG data URL
    try {
        currentQRDataURL = await QRCode.toDataURL(qr, { margin: 2, width: 300 });
        isClientReady = false;
        console.log('[QR] Data URL generated — open /qr in your browser to scan.');
    } catch (err) {
        console.error('[QR] Failed to generate QR data URL:', err.message);
    }
});

client.on('authenticated', () => {
    console.log('[AUTH] WhatsApp client authenticated successfully!');
    currentQRDataURL = null; // QR no longer needed after auth
});

client.on('auth_failure', (msg) => {
    console.error('[AUTH] Authentication failure:', msg);
    isClientReady = false;
});

client.on('ready', () => {
    console.log('[READY] WhatsApp Web Client is ready and connected!');
    isClientReady = true;
    currentQRDataURL = null; // clear QR — no longer needed
});

let isReconnecting = false;

function scheduleAutoReconnect(delayMs = 10000) {
    if (isReconnecting) return;
    isReconnecting = true;
    console.log(`[AUTO-RECONNECT] Scheduling client re-initialization in ${delayMs / 1000} seconds...`);
    setTimeout(async () => {
        try {
            console.log('[AUTO-RECONNECT] Re-initializing WhatsApp client...');
            await client.initialize();
            console.log('[AUTO-RECONNECT] Client initialize call finished.');
        } catch (err) {
            console.error('[AUTO-RECONNECT ERROR] Failed to re-initialize client:', err.message);
        } finally {
            isReconnecting = false;
        }
    }, delayMs);
}

client.on('disconnected', (reason) => {
    console.warn('[DISCONNECTED] WhatsApp client disconnected:', reason);
    isClientReady = false;
    currentQRDataURL = null;
    scheduleAutoReconnect(10000);
});

// ── Keep-Alive Heartbeat Logging (Every 5 minutes) ─────────────────────────
setInterval(() => {
    const rssMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
    const mongoConnected = mongoose.connection.readyState === 1;
    console.log(`[HEARTBEAT] Bot Status | Ready: ${isClientReady} | Mongo: ${mongoConnected} | RAM: ${rssMB}MB | Time: ${new Date().toISOString()}`);
}, 5 * 60 * 1000);
// ─────────────────────────────────────────────────────────────────────────────

// Helper: Save user message and fetch history from MongoDB (or fallback to memory)
async function getHistoryAndSaveUserMsg(phoneNumber, userMessageContent) {
    if (mongoose.connection.readyState === 1) {
        try {
            const conversation = await Conversation.findOneAndUpdate(
                { phoneNumber },
                {
                    $push: {
                        messages: {
                            role: 'user',
                            content: userMessageContent,
                            timestamp: new Date()
                        }
                    }
                },
                { upsert: true, returnDocument: 'after' }
            );
            return conversation ? conversation.messages : [];
        } catch (dbErr) {
            console.error('MongoDB error during user message save:', dbErr.message);
        }
    }

    // Fallback: In-memory store
    if (!inMemoryHistory.has(phoneNumber)) {
        inMemoryHistory.set(phoneNumber, []);
    }
    const userHistory = inMemoryHistory.get(phoneNumber);
    userHistory.push({ role: 'user', content: userMessageContent, timestamp: new Date() });
    return userHistory;
}

// Helper: Save assistant reply to MongoDB (or fallback to memory)
async function saveAssistantMsg(phoneNumber, replyText) {
    if (mongoose.connection.readyState === 1) {
        try {
            await Conversation.updateOne(
                { phoneNumber },
                {
                    $push: {
                        messages: {
                            role: 'assistant',
                            content: replyText,
                            timestamp: new Date()
                        }
                    }
                }
            );
            return;
        } catch (dbErr) {
            console.error('MongoDB error during assistant message save:', dbErr.message);
        }
    }

    // Fallback: In-memory store
    if (inMemoryHistory.has(phoneNumber)) {
        inMemoryHistory.get(phoneNumber).push({
            role: 'assistant',
            content: replyText,
            timestamp: new Date()
        });
    }
}

// Handle incoming messages
client.on('message', async (msg) => {
    // Ignore messages sent by the bot itself
    if (msg.fromMe) return;

    // Ignore empty messages
    if (!msg.body || msg.body.trim() === '') return;

    const phoneNumber = msg.from;
    const userMessageContent = msg.body.trim();

    // console.log(`[Incoming Message] From: ${phoneNumber} | Message: ${userMessageContent}`);

    try {
        // Save user message and retrieve history
        const allMessages = await getHistoryAndSaveUserMsg(phoneNumber, userMessageContent);

        // Fetch last 10 messages for context
        let contextMessages = allMessages.slice(-10).map(m => ({
            role: m.role,
            content: m.content
        }));

        // Format payload for Groq OpenAI Chat Completions standard
        const systemPrompt = `তুমি Organic Sunnah Shop এর কাস্টমার সাপোর্ট বট। শুধুমাত্র বাংলায় সংক্ষিপ্ত ও বন্ধুত্বপূর্ণভাবে উত্তর দাও।

আমাদের প্রোডাক্ট ও দাম শুধুমাত্র নিচেরগুলোই (প্রতি কেজি):
- লিচু ফুলের মধু: ৭০০ টাকা/কেজি
- কালোজিরা ফুলের মধু: ১১০০ টাকা/কেজি
- সরিষা ফুলের মধু: ৬০০ টাকা/কেজি
- সুন্দরবন ফুলের মধু: ১২০০ টাকা/কেজি
ডেলিভারি চার্জ : প্রতিকেজিতে ১২০ টাকা এবং পরের কেজিতে ২০ টাকা করে যোগ হবে।

ফেসবুক পেজ লিংক : https://www.facebook.com/organicsunnahshop
অর্ডার প্রসেস : 
১. নাম:
২. ঠিকানা:
৩. ফোন নম্বর:
৪. প্রোডাক্টের নাম:
৫. পরিমাণ (কেজি/গ্রাম): 

উত্তর দেওয়ার নিয়ম:
1. কাস্টমার যা জিজ্ঞেস করেছে শুধু তার সরাসরি উত্তর দাও। অতিরিক্ত কোনো তথ্য (যেমন অন্য প্রোডাক্টের কথা, ডেলিভারি চার্জ, ডিসকাウント অফার) নিজে থেকে জুড়ে দেবে না, যদি না কাস্টমার সেটা জিজ্ঞেস করে।
2. উত্তর সংক্ষিপ্ত রাখো — ১-৩ লাইনের বেশি না, যদি না কাস্টমার বিস্তারিত ব্যাখ্যা চায়।
3. প্রশ্নের বাইরে গিয়ে নিজে থেকে 'আপনি কি অর্ডার করতে চান?', 'আমাদের আরও প্রোডাক্ট আছে' এই ধরনের বাড়তি বাক্য যোগ করবে না, যদি না কথোপকথনের প্রসঙ্গে এটা স্বাভাবিকভাবে আসে বা কাস্টমার নিজে আগ্রহ দেখায়।
4. একই তথ্য বারবার পুনরাবৃত্তি করবে না।
5. কাস্টমার যদি শুধু একটা নির্দিষ্ট প্রোডাক্টের কথা জিজ্ঞেস করে, শুধু সেই প্রোডাক্টের তথ্যই দাও, বাকিগুলোর কথা বলবে না।

কঠোর নিয়ম:
1. উপরের ৪টা প্রোডাক্ট ছাড়া অন্য কোনো প্রোডাক্টের কথা বলবে না।
2. উপরের দাম ছাড়া অন্য কোনো দাম, প্যাকেট সাইজ (যেমন ১০০গ্রাম/২৫০গ্রাম), বা ব্রেকডাউন কখনো বানিয়ে বলবে না।
3. কাস্টমার যদি নির্দিষ্ট গ্রাম (যেমন ২৫০গ্রাম, ৫০০গ্রাম) এর দাম জিজ্ঞেস করে, তাহলে প্রতি কেজির দাম থেকে হিসাব করে বলবে (যেমন লিচু ফুলের মধু ২৫০গ্রাম = ৭০০÷৪ = ১৭৫ টাকা), কিন্তু এটা স্পষ্ট করে বলবে যে এটা প্রতি কেজি দামের ভিত্তিতে হিসাব করা হয়েছে।
4. কাস্টমার ১ কেজি দাম জিজ্ঞেস করলে সরাসরি উপরের কেজি-দাম বলবে, অন্য কোনো সংখ্যা বানাবে না।
5. অনিশ্চিত হলে বলবে 'আমি নিশ্চিত হয়ে জানিয়ে দিচ্ছি' এবং সঠিক তথ্য না দিয়ে অনুমান করবে না।`;

        // console.log(`[Active System Prompt]\n${systemPrompt}\n-----------------------------------`); 

        const messagesForGroq = [
            {
                role: 'system',
                content: systemPrompt
            },
            ...contextMessages
        ];

        // Call Groq API with model and context
        const modelName = process.env.GROQ_MODEL || 'llama-3.3-70b-versatile';
        const response = await groq.chat.completions.create({
            messages: messagesForGroq,
            model: modelName,
            max_tokens: 600,
            temperature: 0.1
        });

        const replyText = response.choices[0]?.message?.content;

        if (!replyText) {
            throw new Error('Empty response received from Groq AI API.');
        }

        console.log(`[AI Response] To: ${phoneNumber} | Reply: ${replyText}`);

        // Save assistant reply to history
        await saveAssistantMsg(phoneNumber, replyText);

        // Wait 2 seconds before sending reply to simulate natural typing and avoid spam triggers
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Send reply back to user on WhatsApp
        await msg.reply(replyText);

    } catch (error) {
        console.error('[Error] Failed to process message with Groq AI:', error);
        await msg.reply('দুঃখিত, কারিগরি ত্রুটির কারণে এই মুহূর্তে উত্তর দেওয়া সম্ভব হচ্ছে না। অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন।');
    }
});

client.initialize();
