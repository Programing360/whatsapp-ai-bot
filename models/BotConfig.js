const mongoose = require('mongoose');

const botConfigSchema = new mongoose.Schema({
    key: {
        type: String,
        required: true,
        unique: true,
        default: 'ai_enabled'
    },
    value: {
        type: Boolean,
        default: true
    }
}, { timestamps: true });

module.exports = mongoose.model('BotConfig', botConfigSchema);
