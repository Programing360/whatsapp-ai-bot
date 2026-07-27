# WhatsApp AI Customer Support Bot (Groq AI) 🤖💬

An automated WhatsApp AI customer support bot for **Organic Sunnah Shop**, powered by [`whatsapp-web.js`](https://github.com/pedroslopez/whatsapp-web.js), Groq AI ([`groq-sdk`](https://www.npmjs.com/package/groq-sdk)), and MongoDB (`mongoose`).

---

## 🌟 Features

- **WhatsApp Web Integration**: Uses `whatsapp-web.js` with `LocalAuth` strategy to maintain session state across bot restarts without needing to re-scan the QR code every time.
- **Terminal & Cloud QR Scanner**: Renders a QR code directly in the terminal or deployment log output for initial authentication.
- **Groq AI Engine**: Responds automatically in Bangla using high-performance Groq models (`llama-3.3-70b-versatile`) with friendly customer support answers for Organic Sunnah Shop products.
- **Persistent Conversation Memory**: Stores all incoming user messages and outgoing bot replies in MongoDB. Fetches conversation history to supply context for every AI completion request.
- **Error Resilient**: Handles disconnection events and gracefully replies with fallback error messages if API or database errors occur.

---

## 🛠️ Prerequisites

- **Node.js** (v18 or higher recommended)
- **MongoDB** (MongoDB Atlas URI)
- **Groq API Key** (obtain from [Groq Console](https://console.groq.com/))

---

## 🚀 Local Setup & Development

### 1. Clone & Install Dependencies

```bash
cd whatsapp-ai-bot
npm install
```

### 2. Configure Environment Variables

Create `.env` in the root directory (never commit this file to Git):

```env
# Groq API Key
GROQ_API_KEY=your_groq_api_key_here

# MongoDB Connection URI
MONGODB_URI=mongodb+srv://...

# Optional: Groq Model ID (Default: llama-3.3-70b-versatile)
GROQ_MODEL=llama-3.3-70b-versatile
```

### 3. Run Locally

```bash
npm start
```

---

## 🚆 Railway Deployment Guide

### 1. Push Code to GitHub
Ensure `.gitignore` is present so `node_modules`, `.env`, and `.wwebjs_auth` are excluded.

### 2. Deploy on Railway
1. Go to [Railway.app](https://railway.app) and create a **New Project**.
2. Select **Deploy from GitHub repo** and choose your repository.

### 3. Set Environment Variables in Railway Dashboard
In your Railway project settings under **Variables**, set:
- `GROQ_API_KEY`: `your_groq_api_key`
- `MONGODB_URI`: `mongodb+srv://...`
- `GROQ_MODEL`: `llama-3.3-70b-versatile` (optional)

*Note: Credentials and API keys are read purely via `process.env` and are never hardcoded in the codebase.*

### 4. Scan QR Code from Railway Logs
1. Once the initial build finishes, navigate to **Deploy Logs** in the Railway dashboard.
2. The ASCII QR code will render directly in the Railway deploy logs.
3. Open WhatsApp on your phone (**Settings / Linked Devices** → **Link a Device**) and scan the QR code from your screen.
4. Once scanned, you will see `WhatsApp Web Client is ready!` in the logs.

### 💡 Recommendation: Persistent Volume on Railway
Railway containers use ephemeral filesystems by default. To ensure your WhatsApp session state (`.wwebjs_auth`) persists across redeploys without requiring a QR re-scan:
1. Go to your service on Railway → **Volumes**.
2. Add a Volume with Mount Path: `/usr/src/app/.wwebjs_auth` (or `.wwebjs_auth`).
