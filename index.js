require('dotenv').config();
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const Groq = require('groq-sdk');
const mongoose = require('mongoose');
const Conversation = require('./models/Conversation');

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
const client = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        headless: true,
        args: [
            '--no-sandbox',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--disable-accelerated-2d-canvas',
            '--no-first-run',
            '--no-zygote',
            '--disable-gpu'
        ]
    }
});

client.on('qr', (qr) => {
    console.log('QR Code received, scan it below with WhatsApp:');
    qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
    console.log('Client authenticated successfully!');
});

client.on('auth_failure', (msg) => {
    console.error('Authentication failure:', msg);
});

client.on('ready', () => {
    console.log('WhatsApp Web Client is ready!');
});

client.on('disconnected', (reason) => {
    console.log('Client was disconnected:', reason);
});

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

    console.log(`[Incoming Message] From: ${phoneNumber} | Message: ${userMessageContent}`);

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

কঠোর নিয়ম:
1. উপরের ৪টা প্রোডাক্ট ছাড়া অন্য কোনো প্রোডাক্টের কথা বলবে না।
2. উপরের দাম ছাড়া অন্য কোনো দাম, প্যাকেট সাইজ (যেমন ১০০গ্রাম/২৫০গ্রাম), বা ব্রেকডাউন কখনো বানিয়ে বলবে না।
3. কাস্টমার যদি নির্দিষ্ট গ্রাম (যেমন ২৫০গ্রাম, ৫০০গ্রাম) এর দাম জিজ্ঞেস করে, তাহলে প্রতি কেজির দাম থেকে হিসাব করে বলবে (যেমন লিচু ফুলের মধু ২৫০গ্রাম = ৭০০÷৪ = ১৭৫ টাকা), কিন্তু এটা স্পষ্ট করে বলবে যে এটা প্রতি কেজি দামের ভিত্তিতে হিসাব করা হয়েছে।
4. কাস্টমার ১ কেজি দাম জিজ্ঞেস করলে সরাসরি উপরের কেজি-দাম বলবে, অন্য কোনো সংখ্যা বানাবে না।
5. অনিশ্চিত হলে বলবে 'আমি নিশ্চিত হয়ে জানিয়ে দিচ্ছি' এবং সঠিক তথ্য না দিয়ে অনুমান করবে না।`;

        console.log(`[Active System Prompt]\n${systemPrompt}\n-----------------------------------`);

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
