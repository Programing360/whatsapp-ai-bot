require('dotenv').config();
const express = require('express');
const axios = require('axios');
const Groq = require('groq-sdk');
const mongoose = require('mongoose');
const Conversation = require('./models/Conversation');
const BotConfig = require('./models/BotConfig');

// ── Global Error Handlers ───────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
    console.error('[UNCAUGHT EXCEPTION] Process caught error:', err.stack || err);
});

process.on('unhandledRejection', (reason, promise) => {
    console.error('[UNHANDLED REJECTION] Unhandled Promise Rejection:', reason);
});
// ─────────────────────────────────────────────────────────────────────────────

// ── Startup Env Validation ───────────────────────────────────────────────────
const REQUIRED_ENV = ['PAGE_ACCESS_TOKEN', 'VERIFY_TOKEN', 'GROQ_API_KEY', 'MONGODB_URI'];
const missingEnv = REQUIRED_ENV.filter(k => !process.env[k]);
if (missingEnv.length > 0) {
    console.warn(`[STARTUP] ⚠️  Missing environment variables: ${missingEnv.join(', ')}`);
    console.warn('[STARTUP]    Please set them in your environment / Railway dashboard.');
}
console.log('[STARTUP] PAGE_ACCESS_TOKEN present:', !!process.env.PAGE_ACCESS_TOKEN);
console.log('[STARTUP] VERIFY_TOKEN present:', !!process.env.VERIFY_TOKEN);
console.log('[STARTUP] GROQ_API_KEY present:', !!process.env.GROQ_API_KEY);
console.log('[STARTUP] MONGODB_URI present:', !!process.env.MONGODB_URI);
console.log('[STARTUP] GROQ_MODEL:', process.env.GROQ_MODEL || 'llama-3.3-70b-versatile (default)');
// ─────────────────────────────────────────────────────────────────────────────

// Initialize Express server
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Initialize Groq AI client
const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

// Connect to MongoDB
let mongoURI = (process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/facebook-messenger-bot').trim();
if (mongoURI.startsWith('MONGODB_URI=')) {
    mongoURI = mongoURI.replace(/^MONGODB_URI=/, '').trim();
}

mongoose.connect(mongoURI)
    .then(() => console.log('[MongoDB] Connected successfully!'))
    .catch((err) => console.error('[MongoDB Error]', err.message));

// ── AI Toggle Helpers ────────────────────────────────────────────────────────
async function getAIToggleStatus() {
    if (mongoose.connection.readyState !== 1) return true;
    try {
        let config = await BotConfig.findOne({ key: 'ai_enabled' });
        if (!config) {
            config = await BotConfig.create({ key: 'ai_enabled', value: true });
        }
        return config.value;
    } catch (err) {
        console.error('[BotConfig Error] Failed to get toggle status:', err.message);
        return true;
    }
}

async function setAIToggleStatus(status) {
    if (mongoose.connection.readyState !== 1) {
        throw new Error('Database connection unavailable');
    }
    const config = await BotConfig.findOneAndUpdate(
        { key: 'ai_enabled' },
        { value: status },
        { upsert: true, returnDocument: 'after' }
    );
    return config.value;
}
// ─────────────────────────────────────────────────────────────────────────────

// Health Check Route
app.get('/', (req, res) => {
    res.status(200).send('Facebook Messenger AI Bot is running!');
});

// Toggle Status Route (GET)
app.get('/toggle-status', async (req, res) => {
    try {
        const enabled = await getAIToggleStatus();
        res.json({ ai_enabled: enabled });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// Toggle Action Route (POST)
app.post('/toggle', async (req, res) => {
    try {
        let targetState;
        if (typeof req.body.enabled === 'boolean') {
            targetState = req.body.enabled;
        } else {
            const currentState = await getAIToggleStatus();
            targetState = !currentState;
        }
        const newState = await setAIToggleStatus(targetState);
        console.log(`[AI Toggle] State changed to: ${newState ? 'ENABLED' : 'DISABLED'}`);
        res.json({ ai_enabled: newState });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ── Facebook Webhook Verification (GET) ──────────────────────────────────────
app.get('/webhook', (req, res) => {
    const mode = req.query['hub.mode'];
    const token = req.query['hub.verify_token'];
    const challenge = req.query['hub.challenge'];

    if (mode && token) {
        if (mode === 'subscribe' && token === process.env.VERIFY_TOKEN) {
            console.log('[Webhook Verified] Meta webhook challenge accepted!');
            return res.status(200).send(challenge);
        } else {
            console.warn('[Webhook Auth Failed] Verify token mismatch.');
            return res.sendStatus(403);
        }
    }
    return res.sendStatus(400);
});

// ── Facebook Messenger Incoming Webhook (POST) ──────────────────────────────
app.post('/webhook', (req, res) => {
    const body = req.body;

    if (body.object === 'page') {
        // Return 200 OK immediately to Meta
        res.status(200).send('EVENT_RECEIVED');

        for (const entry of body.entry || []) {
            const webhookEvent = entry.messaging?.[0];
            if (webhookEvent && webhookEvent.message && !webhookEvent.message.is_echo) {
                const senderId = webhookEvent.sender.id;
                const messageText = webhookEvent.message.text;

                if (messageText && messageText.trim() !== '') {
                    handleIncomingMessage(senderId, messageText.trim());
                }
            }
        }
    } else {
        res.sendStatus(404);
    }
});

// ── Facebook Graph API Send Message Helper ──────────────────────────────────
async function sendMessengerMessage(recipientId, text) {
    const url = `https://graph.facebook.com/v21.0/me/messages?access_token=${process.env.PAGE_ACCESS_TOKEN}`;
    try {
        await axios.post(url, {
            recipient: { id: recipientId },
            messaging_type: 'RESPONSE',
            message: { text }
        });
        console.log(`[Messenger Reply Sent] To PSID: ${recipientId}`);
    } catch (err) {
        console.error('[Messenger API Error] Failed to send message:', err.response?.data || err.message);
    }
}

// ── History & Message Handlers ──────────────────────────────────────────────
async function getHistoryAndSaveUserMsg(userId, userMessageContent) {
    if (mongoose.connection.readyState === 1) {
        try {
            const conversation = await Conversation.findOneAndUpdate(
                { userId },
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
    return [];
}

async function saveAssistantMsg(userId, replyText) {
    if (mongoose.connection.readyState === 1) {
        try {
            await Conversation.updateOne(
                { userId },
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
        } catch (dbErr) {
            console.error('MongoDB error during assistant message save:', dbErr.message);
        }
    }
}

async function handleIncomingMessage(senderId, messageText) {
    console.log(`[Incoming Message] From PSID: ${senderId} | Content: ${messageText}`);

    // Always save user message to history
    const allMessages = await getHistoryAndSaveUserMsg(senderId, messageText);

    // Check AI Toggle Status
    const aiEnabled = await getAIToggleStatus();
    if (!aiEnabled) {
        console.log(`[AI Paused] Saved message from PSID ${senderId}, AI reply skipped.`);
        return;
    }

    try {
        // Fetch last 10 messages for context
        let contextMessages = allMessages.slice(-10).map(m => ({
            role: m.role,
            content: m.content
        }));

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
1. কাস্টমার যা জিজ্ঞেস করেছে শুধু তার সরাসরি উত্তর দাও। অতিরিক্ত কোনো তথ্য (যেমন অন্য প্রোডাক্টের কথা, ডেলিভারি চার্জ, ডিসকাউন্ট অফার) নিজে থেকে জুড়ে দেবে না, যদি না কাস্টমার সেটা জিজ্ঞেস করে।
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

        const messagesForGroq = [
            {
                role: 'system',
                content: systemPrompt
            },
            ...contextMessages
        ];

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

        console.log(`[AI Response] To PSID: ${senderId} | Reply: ${replyText}`);

        // Save assistant reply to MongoDB
        await saveAssistantMsg(senderId, replyText);

        // Send reply back to Facebook Messenger user
        await sendMessengerMessage(senderId, replyText);

    } catch (error) {
        console.error('[Error] Failed to process message with Groq AI:', error);
        await sendMessengerMessage(senderId, 'দুঃখিত, কারিগরি ত্রুটির কারণে এই মুহূর্তে উত্তর দেওয়া সম্ভব হচ্ছে না। অনুগ্রহ করে কিছুক্ষণ পর আবার চেষ্টা করুন।');
    }
}

// ── Start Express Server ─────────────────────────────────────────────────────
app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ Facebook Messenger AI Bot listening on 0.0.0.0:${PORT}`);
    console.log(`   Webhook Verification: GET  /webhook`);
    console.log(`   Webhook Event:        POST /webhook`);
    console.log(`   Toggle Status:        GET  /toggle-status`);
    console.log(`   Toggle Action:        POST /toggle`);
});

// Keep-Alive Heartbeat Logging (Every 5 minutes)
setInterval(() => {
    const rssMB = Math.round(process.memoryUsage().rss / 1024 / 1024);
    const mongoConnected = mongoose.connection.readyState === 1;
    console.log(`[HEARTBEAT] Bot Status | Mongo: ${mongoConnected} | RAM: ${rssMB}MB | Time: ${new Date().toISOString()}`);
}, 5 * 60 * 1000);
