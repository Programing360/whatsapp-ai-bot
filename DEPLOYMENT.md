# 🚀 24/7 Deployment Guide: WhatsApp AI Bot

This guide covers deployment instructions for running your WhatsApp AI bot **24/7** using **PM2** on a VPS or cloud service like **Render** or **Fly.io**.

---

## ⚠️ Important Note Regarding Vercel

**Why `whatsapp-web.js` cannot be hosted on Vercel Serverless:**

- **Vercel** is designed for **Serverless Functions** (stateless HTTP requests that terminate after 10–60 seconds).
- `whatsapp-web.js` requires a **persistent Node.js process** with a continuous Chromium browser instance and active WebSocket connection to WhatsApp servers 24/7.
- If you need to deploy to Vercel, you would need to re-architect the bot to use the official **Meta WhatsApp Business Cloud API** via HTTP webhooks instead of `whatsapp-web.js`.

---

## Option 1: VPS Deployment (Recommended for WhatsApp Bots)

A Linux VPS (DigitalOcean, Hetzner, AWS EC2, Linode, Vultr) with Ubuntu 22.04 LTS is the best environment for `whatsapp-web.js` because session files (`.wwebjs_auth`) persist reliably on local disk.

### Step 1: Install Node.js & System Dependencies

Connect to your VPS via SSH:

```bash
# Update system packages
sudo apt update && sudo apt upgrade -y

# Install Node.js 18
curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
sudo apt install -y nodejs

# Install Chromium & Puppeteer dependencies
sudo apt install -y chromium-browser \
  fonts-liberation libasound2 libatk-bridge2.0-0 libatk1.0-0 libc6 libcairo2 \
  libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libgcc1 libglib2.0-0 \
  libgtk-3-0 libnspr4 nss libpango-1.0-0 libpangocairo-1.0-0 stdc++6 libx11-6 \
  libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 \
  libxi6 libxrandr2 libxrender1 libxss1 libxtst6 ca-certificates procps lsb-release \
  xdg-utils wget

# Install PM2 globally
sudo npm install -g pm2
```

### Step 2: Clone/Upload Code & Install Dependencies

```bash
# Navigate to web root or app folder
cd /var/www
sudo git clone <your-repository-url> whatsapp-ai-bot
cd whatsapp-ai-bot

# Install project dependencies
npm install --production
```

### Step 3: Configure Environment Variables

Create `.env` file on your server:

```bash
nano .env
```

Add your configuration:

```env
GROQ_API_KEY=gsk_your_groq_api_key_here
MONGODB_URI=mongodb+srv://...
GROQ_MODEL=llama-3.3-70b-versatile
```

### Step 4: First-Time Initialization & QR Code Scanning

Run the app once interactively to scan the QR code:

```bash
node index.js
```

Scan the QR code in the terminal with WhatsApp. Once you see `WhatsApp Web Client is ready!`, press `CTRL + C` to stop interactive mode.

### Step 5: Start 24/7 Background Process with PM2

Start the bot using `ecosystem.config.js`:

```bash
# Start bot process
pm2 start ecosystem.config.js

# Save process list so it restarts automatically on server reboot
pm2 save

# Generate PM2 startup script
pm2 startup
```

---

## Option 2: Render.com / Koyeb Deployment (Background Worker)

If you prefer a cloud platform, create a **Background Worker** (not a Web Service) on [Render.com](https://render.com) or [Koyeb.com](https://koyeb.com):

1. **Service Type**: Background Worker
2. **Environment**: Node
3. **Build Command**: `npm install`
4. **Start Command**: `npm start`
5. Add Environment Variables (`GROQ_API_KEY`, `MONGODB_URI`) in the platform settings dashboard.
