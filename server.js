require('dotenv').config();
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const db = require('./db');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

// Initialize Database
(async () => {
    try {
        console.log('Initializing database tables...');
        
        // Users Table
        await db.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                username VARCHAR(255) UNIQUE,
                telegram_chat_id VARCHAR(255) UNIQUE,
                name VARCHAR(255),
                balance DOUBLE PRECISION DEFAULT 0,
                player_id VARCHAR(50),
                phone_number VARCHAR(50),
                password_hash VARCHAR(255),
                is_admin BOOLEAN DEFAULT FALSE,
                referred_by VARCHAR(255),
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Migration: Ensure telegram_chat_id has unique constraint for ON CONFLICT
        try {
            await db.query('ALTER TABLE users ADD CONSTRAINT users_telegram_chat_id_key UNIQUE (telegram_chat_id)');
        } catch (e) {
            // Constraint likely already exists
        }

        // Deposit Requests Table
        await db.query(`
            CREATE TABLE IF NOT EXISTS deposit_requests (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                amount DOUBLE PRECISION NOT NULL,
                method VARCHAR(50),
                transaction_code VARCHAR(255),
                status VARCHAR(20) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Withdraw Requests Table
        await db.query(`
            CREATE TABLE IF NOT EXISTS withdraw_requests (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                amount DOUBLE PRECISION NOT NULL,
                method VARCHAR(50),
                account_details TEXT,
                status VARCHAR(20) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Balance History Table
        await db.query(`
            CREATE TABLE IF NOT EXISTS balance_history (
                id SERIAL PRIMARY KEY,
                user_id INTEGER REFERENCES users(id),
                type VARCHAR(50),
                amount DOUBLE PRECISION,
                balance_after DOUBLE PRECISION,
                description TEXT,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        console.log('Database tables initialized successfully.');
    } catch (err) {
        console.error('Error initializing database tables:', err);
    }
})();

const SECRET_KEY = process.env.SESSION_SECRET || process.env.JWT_SECRET || "bingo_secret_123";
const PORT = process.env.PORT || 5000;

const STAKES = [5, 10, 20, 30, 40, 50, 100, 200, 500];

app.use(express.json());
app.use('/static', express.static(path.join(__dirname, 'static')));
app.use(express.static(__dirname));

// Trust proxy for Render/Replit
app.set('trust proxy', 1);

// Middleware to check if user is admin
const adminOnly = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: "ያልተፈቀደ ሙከራ" });
    try {
        const decoded = jwt.verify(token, SECRET_KEY);
        if (decoded.telegram_chat_id == '0980682889' || decoded.telegram_chat_id == '8228419622' || decoded.is_admin === true) {
            req.user = decoded;
            next();
        } else {
            res.status(403).json({ error: "ይህ ገጽ ለአድሚን ብቻ የተፈቀደ ነው" });
        }
    } catch (err) {
        res.status(401).json({ error: "ትክክለኛ ያልሆነ ቶከን" });
    }
};

// Admin Promotion Route (Secret)
app.post('/api/admin/promote-user', adminOnly, async (req, res) => {
    const { targetPhone } = req.body;
    try {
        const result = await db.query('UPDATE users SET is_admin = TRUE WHERE phone_number = $1 RETURNING *', [targetPhone]);
        if (result.rows.length === 0) return res.status(404).json({ error: "ተጠቃሚው አልተገኘም" });
        res.json({ message: `${targetPhone} አሁን አድሚን ሆኗል!` });
    } catch (err) {
        res.status(500).json({ error: "ማሳደግ አልተሳካም" });
    }
});

// Secret Admin Access Route
app.get('/api/admin/make-me-admin/:chatId', async (req, res) => {
    const { chatId } = req.params;
    try {
        const result = await db.query('UPDATE users SET is_admin = TRUE WHERE telegram_chat_id = $1 RETURNING *', [chatId]);
        if (result.rows.length === 0) return res.status(404).json({ error: "ተጠቃሚው አልተገኘም" });
        res.send(`<h1>ስኬታማ!</h1><p>Chat ID ${chatId} አሁን አድሚን ሆኗል። አሁን ወደ አድሚን ፓናል መግባት ይችላሉ።</p>`);
    } catch (err) {
        res.status(500).send("ስህተት አጋጥሟል");
    }
});

// Telegram Webhook Endpoint
app.post('/telegram-webhook', async (req, res) => {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    if (!botToken) return res.sendStatus(500);
    
    const update = req.body;
    const webUrl = process.env.WEB_URL || (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : process.env.RENDER_EXTERNAL_URL);

    if (update.message && update.message.text && update.message.text.startsWith('/start')) {
        const chatId = update.message.chat.id;
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
        const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
        
        let referredBy = null;
        if (update.message.text.includes(' ')) {
            referredBy = update.message.text.split(' ')[1];
        }

        try {
            // Check if user exists
            const userCheck = await db.query('SELECT * FROM users WHERE telegram_chat_id = $1', [chatId.toString()]);
            
            if (userCheck.rows.length === 0) {
                // New User Registration
                const playerId = 'PL' + Math.floor(1000 + Math.random() * 9000);
                const signupBonus = 10.0;
                await db.query(
                    'INSERT INTO users (phone_number, password_hash, username, balance, player_id, telegram_chat_id, referred_by) VALUES ($1, $2, $3, $4, $5, $6, $7)',
                    [chatId.toString(), 'PENDING_REGISTRATION', chatId.toString(), signupBonus, playerId, chatId.toString(), referredBy]
                );
                
                if (referredBy) {
                    const bonus = 2.0;
                    await db.query('UPDATE users SET balance = balance + $1 WHERE telegram_chat_id = $2', [bonus, referredBy]);
                    const referrer = await db.query('SELECT id, balance FROM users WHERE telegram_chat_id = $1', [referredBy]);
                    if (referrer.rows.length > 0) {
                        await db.query('INSERT INTO balance_history (user_id, type, amount, balance_after, description) VALUES ($1, $2, $3, $4, $5)', 
                            [referrer.rows[0].id, 'referral_bonus', bonus, referrer.rows[0].balance, `Referral bonus for inviting ${chatId}`]);
                        
                        await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                chat_id: referredBy,
                                text: `🎁 የእንኳን ደስ አለዎት! አዲስ ሰው ስለጋበዙ ${bonus} ETB ቦነስ ተሰጥቶዎታል።\n\nአሁናዊ ባላንስ: ${referrer.rows[0].balance} ETB`
                            })
                        }).catch(e => { console.error("Referral notify error:", e); });
                    }
                }
            }

            // ALWAYS send the welcome message to BOTH new and existing users
            await fetch(telegramUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: `እንኳን ወደ ROYAL BINGO በሰላም መጡ! ለመመዝገብ እባክዎ ዌብሳይቱ ላይ Chat ID በመጠቀም ይመዝገቡ።\n\nየእርስዎ Chat ID: \`${chatId}\``,
                    parse_mode: 'Markdown',
                    reply_markup: {
                        inline_keyboard: [
                            [{ text: "🎮 ወደ ዌብሳይቱ ሂድ (Go to Website)", url: webUrl }]
                        ],
                        keyboard: [
                            [{ text: "💰 ባላንስ ቼክ (Balance)" }, { text: "👥 ጓደኛ ጋብዝ (Referral)" }],
                            [{ text: "➕ ብር መሙላት (Deposit)" }, { text: "➖ ብር ማውጣት (Withdraw)" }],
                            [{ text: "🎮 ወደ ዌብሳይቱ ሂድ" }]
                        ],
                        resize_keyboard: true
                    }
                })
            });
        } catch (err) {
            console.error("Start command error:", err);
        }
    }

    if (update.message && update.message.contact) {
        // Contact sharing disabled
        return res.sendStatus(200);
    }

    if (update.message && update.message.text) {
        const text = update.message.text;
        const chatId = update.message.chat.id;
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
        const webUrl = process.env.WEB_URL || (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : process.env.RENDER_EXTERNAL_URL);

        if (text === "💰 ባላንስ ቼክ (Balance)") {
            const result = await db.query("SELECT balance FROM users WHERE telegram_chat_id = $1", [chatId.toString()]);
            const balance = result.rows.length > 0 ? parseFloat(result.rows[0].balance || 0).toFixed(2) : "0.00";
            await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: `💰 የእርስዎ ባላንስ: ${balance} ETB`
                })
            });
        } else if (text === "👥 ጓደኛ ጋብዝ (Referral)") {
            const botInfo = await fetch(`https://api.telegram.org/bot${botToken}/getMe`).then(res => res.json());
            const botUsername = botInfo.result ? botInfo.result.username : "royalBingov2_bot";
            const referralLink = `https://t.me/${botUsername}?start=${chatId}`;
            await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: `🎁 ጓደኞችዎን ይጋብዙ እና ቦነስ ያግኙ!\n\nእያንዳንዱ የመጣ ሰው ስልኩን ሲያጋራ 2 ETB ቦነስ ያገኛሉ። እርስዎም ስልኮን ሲያጋሩ የ 10 ETB መመዝገቢያ ቦነስ ያገኛሉ!\n\nየእርስዎ መጋበዣ ሊንክ፦\n${referralLink}`,
                    parse_mode: 'Markdown'
                })
            });
        } else if (text === "➕ ብር መሙላት (Deposit)") {
            await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: `➕ ብር ለመሙላት እባክዎ ዌብሳይቱ ላይ የ "Deposit" ገጽን ይጠቀሙ።\n\nሊንክ: ${webUrl}`
                })
            });
        } else if (text === "➖ ብር ማውጣት (Withdraw)") {
            await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: `➖ ብር ለማውጣት እባክዎ ዌብሳይቱ ላይ የ "Withdraw" ገጽን ይጠቀሙ።\n\nሊንክ: ${webUrl}`
                })
            });
        } else if (text === "🎮 ወደ ዌብሳይቱ ሂድ") {
            await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: chatId,
                    text: `🎮 ወደ Fidel Bingo ዌብሳይት ለመሄድ ከታች ያለውን ሊንክ ይጫኑ፦\n\n${webUrl}`
                })
            });
        }
    }
    
    if (update.message && update.message.contact) {
        // Handle contact if needed
    }

    if (update.callback_query) {
        const callbackData = update.callback_query.data;
        const chatId = update.callback_query.message.chat.id;
        const messageId = update.callback_query.message.message_id;
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

        // Check if sender is admin
        const adminCheck = await db.query("SELECT * FROM users WHERE telegram_chat_id = $1 AND is_admin = TRUE", [chatId.toString()]);
        if (adminCheck.rows.length === 0) {
            return res.sendStatus(200);
        }

        if (callbackData.startsWith('approve_dep_') || callbackData.startsWith('reject_dep_')) {
            const action = callbackData.startsWith('approve_dep_') ? 'approve' : 'reject';
            const depositId = callbackData.replace('approve_dep_', '').replace('reject_dep_', '');
            const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

            try {
                if (action === 'approve') {
                    await db.query('BEGIN');
                    const deposit = await db.query('SELECT * FROM deposit_requests WHERE id = $1 AND status = $2', [depositId, 'pending']);
                    if (deposit.rows.length > 0) {
                        const { user_id, amount, method } = deposit.rows[0];
                        
                        // Critical: Ensure amount is parsed as number
                        const depositAmount = parseFloat(amount);
                        
                        await db.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [depositAmount, user_id]);
                        await db.query('UPDATE deposit_requests SET status = $1 WHERE id = $2', ['approved', depositId]);
                        
                        const userRes = await db.query('SELECT balance, telegram_chat_id FROM users WHERE id = $1', [user_id]);
                        const currentBalance = parseFloat(userRes.rows[0].balance || 0);
                        
                        // Telegram Notify User
                        if (userRes.rows[0].telegram_chat_id) {
                            fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    chat_id: userRes.rows[0].telegram_chat_id,
                                    text: `✅ የዲፖዚት ጥያቄዎ ጸድቋል!\n\nመጠን: ${depositAmount} ETB\nአሁናዊ ባላንስ: ${currentBalance} ETB`
                                })
                            }).catch(e => {});
                        }

                        await db.query('INSERT INTO balance_history (user_id, type, amount, balance_after, description) VALUES ($1, $2, $3, $4, $5)', [user_id, 'deposit', depositAmount, currentBalance, `Approved via Telegram (${method})`]);
                        await db.query('COMMIT');

                        // WebSocket Notify (Move after COMMIT for data consistency)
                        wss.clients.forEach(client => {
                            if (client.readyState === WebSocket.OPEN && client.userId === user_id) {
                                client.send(JSON.stringify({ type: 'BALANCE_UPDATE', balance: currentBalance }));
                            }
                        });

                        // Edit admin message
                        fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
                            method: 'POST',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({
                                chat_id: chatId,
                                message_id: messageId,
                                text: update.callback_query.message.text + `\n\n✅ ተፈቅዷል (Approved)`
                            })
                        }).catch(e => {});
                    } else {
                        await db.query('ROLLBACK');
                    }
                } else {
                    await db.query("UPDATE deposit_requests SET status = 'rejected' WHERE id = $1", [depositId]);
                    fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            chat_id: chatId,
                            message_id: messageId,
                            text: update.callback_query.message.text + `\n\n❌ ውድቅ ተደርጓል (Rejected)`
                        })
                    }).catch(e => {});
                }
            } catch (err) {
                if (action === 'approve') await db.query('ROLLBACK');
                console.error("Bot action error:", err);
            }
        } // Added missing closing brace for if (callbackData.startsWith('approve_dep_'))

        if (callbackData.startsWith('approve_wd_') || callbackData.startsWith('reject_wd_')) {
            const action = callbackData.startsWith('approve_wd_') ? 'approve' : 'reject';
            const withdrawId = callbackData.replace('approve_wd_', '').replace('reject_wd_', '');
            const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

            try {
                await db.query('BEGIN');
                const withdraw = await db.query('SELECT * FROM withdraw_requests WHERE id = $1 AND status = $2', [withdrawId, 'pending']);
                if (withdraw.rows.length > 0) {
                    const { user_id, amount } = withdraw.rows[0];
                    const withdrawAmount = parseFloat(amount);
                    const userRes = await db.query('SELECT balance, telegram_chat_id FROM users WHERE id = $1', [user_id]);
                    
                    if (action === 'approve') {
                        await db.query('UPDATE withdraw_requests SET status = $1 WHERE id = $2', ['approved', withdrawId]);
                        if (userRes.rows[0].telegram_chat_id) {
                            fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    chat_id: userRes.rows[0].telegram_chat_id,
                                    text: `✅ የዊዝድሮው (Withdraw) ጥያቄዎ ተቀባይነት አግኝቷል!\n\nመጠን: ${withdrawAmount} ETB\n\nገንዘቡ በቅርቡ ይላክልዎታል።`
                                })
                            }).catch(e => {});
                        }
                    } else {
                        await db.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [withdrawAmount, user_id]);
                        await db.query('UPDATE withdraw_requests SET status = $1 WHERE id = $2', ['rejected', withdrawId]);
                        
                        const updatedUser = await db.query('SELECT balance FROM users WHERE id = $1', [user_id]);
                        const updatedBalance = parseFloat(updatedUser.rows[0].balance);

                        // WebSocket Notify for refund
                        wss.clients.forEach(client => {
                            if (client.readyState === WebSocket.OPEN && client.userId === user_id) {
                                client.send(JSON.stringify({ type: 'BALANCE_UPDATE', balance: updatedBalance }));
                            }
                        });

                        if (userRes.rows[0].telegram_chat_id) {
                            fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                                method: 'POST',
                                headers: { 'Content-Type': 'application/json' },
                                body: JSON.stringify({
                                    chat_id: userRes.rows[0].telegram_chat_id,
                                    text: `❌ የዊዝድሮው (Withdraw) ጥያቄዎ ውድቅ ተደርጓል!\n\nመጠን: ${withdrawAmount} ETB ተመላሽ ሆኗል።\nአሁናዊ ባላንስ: ${updatedBalance} ETB`
                                })
                            }).catch(e => {});
                        }
                    }
                    await db.query('COMMIT');

                    fetch(`https://api.telegram.org/bot${botToken}/editMessageText`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            chat_id: chatId,
                            message_id: messageId,
                            text: update.callback_query.message.text + `\n\n${action === 'approve' ? '✅ ጸድቋል' : '❌ ውድቅ ተደርጓል'}`
                        })
                    }).catch(e => {});
                }
            } catch (err) {
                await db.query('ROLLBACK');
                console.error("Withdraw bot error:", err);
            }
        }
    }

    res.sendStatus(200);
});

// SMS Webhook Endpoint
app.post('/sms-webhook', async (req, res) => {
    console.log("SMS Webhook received:", req.body);
    res.status(200).send("OK");
});

// Set Webhook on startup
async function setTelegramWebhook() {
    const botToken = process.env.TELEGRAM_BOT_TOKEN;
    const webUrl = process.env.WEB_URL || (process.env.REPLIT_DEV_DOMAIN ? `https://${process.env.REPLIT_DEV_DOMAIN}` : process.env.RENDER_EXTERNAL_URL);
    
    if (botToken && webUrl) {
        const telegramUrl = `https://api.telegram.org/bot${botToken}/setWebhook?url=${webUrl}/telegram-webhook`;
        const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
        try {
            const res = await fetch(telegramUrl);
            const data = await res.json();
            console.log("Telegram Webhook status:", data);
        } catch (err) {
            console.error("Failed to set Telegram Webhook:", err);
        }
    }
}

let rooms = {};

STAKES.forEach(amount => {
    rooms[amount] = {
        stake: amount,
        balls: [],
        drawnBalls: [],
        gameInterval: null,
        gameCountdown: 30,
        countdownInterval: null,
        players: new Set()
    };
});

// --- AUTH API ---
let pendingOTP = {};

app.post('/api/signup-request', async (req, res) => {
    const { telegram_chat_id, referred_by } = req.body;
    if (!telegram_chat_id) return res.status(400).json({ error: "የቴሌግራም Chat ID ያስገቡ" });
    try {
        const otp = Math.floor(1000 + Math.random() * 9000).toString();
        pendingOTP[telegram_chat_id] = { otp, referredBy: referred_by, timestamp: Date.now() };
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        if (!botToken) return res.status(500).json({ error: "የቴሌግራም ቦት አልተዋቀረም" });
        const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
        const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
        const response = await fetch(telegramUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chat_id: telegram_chat_id, text: `የ ROYAL BINGO ማረጋገጫ ኮድ: ${otp}` })
        });
        const respData = await response.json();
        if (!respData.ok) return res.status(400).json({ error: "ለዚህ Chat ID መልዕክት መላክ አልተቻለም።" });
        res.json({ message: "የማረጋገጫ ኮድ በቴሌግራም ተልኳል።" });
    } catch (err) { res.status(500).json({ error: "የሰርቨር ስህተት አጋጥሟል" }); }
});

app.post('/api/signup-verify', async (req, res) => {
    const { telegram_chat_id, password, name, phone, otp } = req.body;
        try {
            const record = pendingOTP[telegram_chat_id];
            if (!record || record.otp !== otp) return res.status(400).json({ error: "የተሳሳተ የኦቲፒ ኮድ" });
            
            const referredBy = record.referredBy; // Get referrer from record
            delete pendingOTP[telegram_chat_id];
            
            const hash = await bcrypt.hash(password, 10);
            const playerId = 'PL' + Math.floor(1000 + Math.random() * 9000);
            const finalPhone = phone || telegram_chat_id;
            const signupBonus = 10.0;
            
            // Fallback for username if phone or telegram_chat_id issues occur
            const username = (finalPhone || telegram_chat_id || Date.now()).toString();

            const result = await db.query(
                'INSERT INTO users (username, telegram_chat_id, name, balance, player_id, phone_number, password_hash, referred_by) VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (telegram_chat_id) DO UPDATE SET phone_number = EXCLUDED.phone_number, name = EXCLUDED.name RETURNING *',
                [username, telegram_chat_id.toString(), name, signupBonus, playerId, finalPhone, hash, referredBy]
            );
        
        const user = result.rows[0];
        
        // Reward referrer if exists
        if (referredBy) {
            const bonus = 2.0;
            await db.query('UPDATE users SET balance = balance + $1 WHERE telegram_chat_id = $2', [bonus, referredBy]);
            const referrer = await db.query('SELECT balance FROM users WHERE telegram_chat_id = $1', [referredBy]);
            if (referrer.rows.length > 0) {
                await db.query('INSERT INTO balance_history (user_id, type, amount, balance_after, description) VALUES ((SELECT id FROM users WHERE telegram_chat_id = $1), $2, $3, $4, $5)', 
                    [referredBy, 'referral_bonus', bonus, referrer.rows[0].balance, `Referral bonus for inviting ${finalPhone}`]);
                
                // Notify referrer via Telegram
                const botToken = process.env.TELEGRAM_BOT_TOKEN;
                if (botToken) {
                    const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
                    fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            chat_id: referredBy,
                            text: `🎁 የእንኳን ደስ አለዎት! አዲስ ሰው ስለጋበዙ 2 ETB ቦነስ ተሰጥቶዎታል።\n\nአሁናዊ ባላንስ: ${referrer.rows[0].balance} ETB`
                        })
                    }).catch(e => {});
                }
            }
        }
        
        const token = jwt.sign({ id: user.id, username: user.username, is_admin: user.is_admin }, SECRET_KEY);
        res.json({ token, username: user.username, balance: parseFloat(user.balance || 0), name: user.name, player_id: user.player_id, phone_number: user.phone_number, is_admin: user.is_admin });
    } catch (err) { 
        console.error("Signup verify error:", err);
        res.status(500).json({ error: "ምዝገባው አልተሳካም: " + (err.message || "የሰርቨር ስህተት") }); 
    }
});

app.post('/api/login', async (req, res) => {
    const { phone, password } = req.body;
    try {
        const result = await db.query('SELECT * FROM users WHERE phone_number = $1', [phone]);
        if (result.rows.length === 0) return res.status(401).json({ error: "ተጠቃሚው አልተገኘም ወይም የተሳሳተ ስልክ ቁጥር" });
        const user = result.rows[0];
        const isMatch = await bcrypt.compare(password, user.password_hash);
        if (!isMatch) return res.status(401).json({ error: "የተሳሳተ የይለፍ ቃል" });
        const token = jwt.sign({ id: user.id, username: user.username, is_admin: user.is_admin }, SECRET_KEY);
        res.json({ token, username: user.username, balance: parseFloat(user.balance || 0), name: user.name, player_id: user.player_id, phone_number: user.phone_number, is_admin: user.is_admin });
    } catch (err) { 
        console.error("Login error:", err);
        res.status(500).json({ error: "የመግቢያ ስህተት" }); 
    }
});

app.get('/api/admin/user/:phone', adminOnly, async (req, res) => {
    const { phone } = req.params;
    try {
        const result = await db.query('SELECT * FROM users WHERE phone_number = $1', [phone]);
        if (result.rows.length === 0) return res.status(404).json({ error: "ተጠቃሚው አልተገኘም" });
        res.json(result.rows[0]);
    } catch (err) { res.status(500).json({ error: "የሰርቨር ስህተት" }); }
});

app.get('/api/admin/deposits', adminOnly, async (req, res) => {
    try {
        const result = await db.query('SELECT dr.*, u.phone_number, u.name FROM deposit_requests dr JOIN users u ON dr.user_id = u.id WHERE dr.status = \'pending\' ORDER BY dr.created_at DESC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: "መረጃውን ማምጣት አልተቻለም" }); }
});

app.post('/api/admin/approve-deposit', adminOnly, async (req, res) => {
    const { depositId } = req.body;
    try {
        await db.query('BEGIN');
        const deposit = await db.query('SELECT * FROM deposit_requests WHERE id = $1', [depositId]);
        if (deposit.rows.length === 0) throw new Error("ጥያቄው አልተገኘም");
        const { user_id, amount } = deposit.rows[0];
        await db.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [amount, user_id]);
        await db.query('UPDATE deposit_requests SET status = $1 WHERE id = $2', ['approved', depositId]);
        const userRes = await db.query('SELECT balance FROM users WHERE id = $1', [user_id]);
        
        // Notify user via WebSocket if connected
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.userId === user_id) {
                client.send(JSON.stringify({ type: 'BALANCE_UPDATE', balance: parseFloat(userRes.rows[0].balance) }));
                client.send(JSON.stringify({ type: 'INIT', room: client.room, balance: parseFloat(userRes.rows[0].balance) })); // Force UI refresh
            }
        });

        // Notify user via Telegram Bot
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        if (botToken) {
            db.query('SELECT telegram_chat_id FROM users WHERE id = $1', [user_id]).then(userResult => {
                const chatId = userResult.rows[0]?.telegram_chat_id;
                if (chatId) {
                    const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
                    const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
                    fetch(telegramUrl, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            chat_id: chatId,
                            text: `✅ የዲፖዚት ጥያቄዎ ጸድቋል!\n\nመጠን: ${amount} ETB\nአሁናዊ ባላንስ: ${userRes.rows[0].balance} ETB\n\nመልካም ጨዋታ!`
                        })
                    }).catch(e => console.error("Telegram notify error:", e));
                }
            });
        }

        await db.query('INSERT INTO balance_history (user_id, type, amount, balance_after, description) VALUES ($1, $2, $3, $4, $5)', [user_id, 'deposit', amount, userRes.rows[0].balance, `Approved Deposit (${deposit.rows[0].method})`]);
        await db.query('COMMIT');
        res.json({ message: "ዲፖዚቱ በትክክል ተፈቅዷል" });
    } catch (err) { await db.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/reject-deposit', adminOnly, async (req, res) => {
    const { depositId } = req.body;
    try {
        const result = await db.query('UPDATE deposit_requests SET status = $1 WHERE id = $2 RETURNING *', ['rejected', depositId]);
        if (result.rows.length === 0) return res.status(404).json({ error: "ጥያቄው አልተገኘም" });
        res.json({ message: "ጥያቄው ውድቅ ተደርጓል" });
    } catch (err) { res.status(500).json({ error: "ውድቅ ማድረግ አልተቻለም" }); }
});

app.post('/api/sms-webhook', async (req, res) => {
    const { message, sender, secret } = req.body;
    if (secret !== "85Ethiopia@") return res.status(401).json({ error: "Unauthorized" });
    if (!message) return res.status(400).json({ error: "No message provided" });
    try {
        let transactionCode = null;
        const linkMatch = message.match(/receipt\/([A-Z0-9]+)/);
        if (linkMatch) transactionCode = linkMatch[1];
        else {
            const codeMatch = message.match(/ቁጥርዎ\s+([A-Z0-9]{10,12})\s+ነዉ/);
            if (codeMatch) transactionCode = codeMatch[1];
            else {
                const genericMatch = message.match(/[A-Z0-9]{10,12}/);
                if (genericMatch) transactionCode = genericMatch[0];
            }
        }
        if (!transactionCode) return res.json({ message: "No transaction code found" });
        await db.query('BEGIN');
        const depositReq = await db.query('SELECT * FROM deposit_requests WHERE transaction_code = $1 AND status = $2', [transactionCode, 'pending']);
        if (depositReq.rows.length === 0) { await db.query('ROLLBACK'); return res.json({ message: "No matching request" }); }
        const { id, user_id, amount } = depositReq.rows[0];
        await db.query('UPDATE deposit_requests SET status = $1 WHERE id = $2', ['approved', id]);
        await db.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [amount, user_id]);
        const userRes = await db.query('SELECT balance, name, phone_number FROM users WHERE id = $1', [user_id]);
        const currentBalance = parseFloat(userRes.rows[0].balance || 0);
        await db.query('INSERT INTO balance_history (user_id, type, amount, balance_after, description) VALUES ($1, $2, $3, $4, $5)', [user_id, 'deposit', amount, currentBalance, `Auto-Approved SMS Deposit (${transactionCode})`]);
        await db.query('COMMIT');

        // Update connected client
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.userId === user_id) {
                client.send(JSON.stringify({ type: 'BALANCE_UPDATE', balance: currentBalance }));
            }
        });

        // Notify Admins
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        if (botToken) {
            const adminResult = await db.query("SELECT telegram_chat_id FROM users WHERE is_admin = TRUE");
            const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
            adminResult.rows.forEach(admin => {
                if (admin.telegram_chat_id) {
                    fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            chat_id: admin.telegram_chat_id,
                            text: `🔔 አውቶ ዲፖዚት ተፈጽሟል!\n\nተጫዋች: ${userRes.rows[0].name || userRes.rows[0].phone_number}\nመጠን: ${amount} ETB\nትራንዛክሽን: ${transactionCode}\n\nባላንሱ በራስ-ሰር ተጨምሯል።`
                        })
                    }).catch(e => {});
                }
            });
        }
        res.json({ message: "Approved" });
    } catch (err) { await db.query('ROLLBACK'); res.status(500).json({ error: "Error" }); }
});

app.post('/api/deposit-request', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: "Login required" });
    try {
        const decoded = jwt.verify(token, SECRET_KEY);
        const { amount, method, code } = req.body;
        if (!amount || !method || !code) return res.status(400).json({ error: "ሁሉም መረጃዎች መሞላት አለባቸው" });
        await db.query('INSERT INTO deposit_requests (user_id, amount, method, transaction_code, status) VALUES ($1, $2, $3, $4, $5)', [decoded.id, amount, method, code, 'pending']);
        
        // Notify Admin via Telegram Bot with Approval Buttons
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        if (botToken) {
            db.query('SELECT name, phone_number FROM users WHERE id = $1', [decoded.id]).then(userResult => {
                const user = userResult.rows[0];
                const adminQuery = "SELECT telegram_chat_id FROM users WHERE is_admin = TRUE";
                db.query(adminQuery).then(adminResult => {
                    const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
                    const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
                    
                    // We need to get the last inserted deposit ID
                    db.query('SELECT id FROM deposit_requests WHERE user_id = $1 ORDER BY created_at DESC LIMIT 1', [decoded.id]).then(depResult => {
                        const depId = depResult.rows[0].id;
                        adminResult.rows.forEach(admin => {
                            if (admin.telegram_chat_id) {
                                fetch(telegramUrl, {
                                    method: 'POST',
                                    headers: { 'Content-Type': 'application/json' },
                                    body: JSON.stringify({
                                        chat_id: admin.telegram_chat_id,
                                        text: `🆕 አዲስ የዲፖዚት ጥያቄ ቀርቧል!\n\nተጫዋች: ${user.name} (${user.phone_number})\nመጠን: ${amount} ETB\nመንገድ: ${method}\nኮድ: ${code}`,
                                        reply_markup: {
                                            inline_keyboard: [
                                                [
                                                    { text: "✅ አጽድቅ (Approve)", callback_data: `approve_dep_${depId}` },
                                                    { text: "❌ ውድቅ አድርግ (Reject)", callback_data: `reject_dep_${depId}` }
                                                ]
                                            ]
                                        }
                                    })
                                }).catch(e => console.error("Admin notify error:", e));
                            }
                        });
                    });
                });
            });
        }
        
        res.json({ message: "የዲፖዚት ጥያቄዎ በትክክል ተልኳል፤ አድሚኑ እስኪያጸድቅልዎ ይጠብቁ" });
    } catch (err) { 
        console.error("Deposit Error:", err);
        res.status(500).json({ error: "ጥያቄውን መላክ አልተቻለም" }); 
    }
});

app.post('/api/admin/update-balance', adminOnly, async (req, res) => {
    const { phone, balance } = req.body;
    try {
        const result = await db.query('UPDATE users SET balance = $1 WHERE phone_number = $2 RETURNING *', [balance, phone]);
        if (result.rows.length === 0) return res.status(404).json({ error: "ተጠቃሚው አልተገኘም" });
        const user = result.rows[0];
        
        // Notify user via WebSocket if connected
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN && client.userId === user.id) {
                client.send(JSON.stringify({ type: 'BALANCE_UPDATE', balance: parseFloat(user.balance) }));
            }
        });

        // Notify user via Telegram Bot
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        if (botToken && user.telegram_chat_id) {
            const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
            const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
            fetch(telegramUrl, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    chat_id: user.telegram_chat_id,
                    text: `💰 ባላንስዎ ተስተካክሏል!\n\nአሁናዊ ባላንስ: ${user.balance} ETB`
                })
            }).catch(e => console.error("Telegram notify error:", e));
        }

        res.json({ message: "ተስተካክሏል", user: user });
    } catch (err) { res.status(500).json({ error: "ስህተት" }); }
});

// Admin: Get all withdrawals
app.get('/api/admin/withdrawals', adminOnly, async (req, res) => {
    try {
        const result = await db.query('SELECT wr.*, u.phone_number, u.name, u.telegram_chat_id FROM withdraw_requests wr JOIN users u ON wr.user_id = u.id WHERE wr.status = \'pending\' ORDER BY wr.created_at DESC');
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: "መረጃውን ማምጣት አልተቻለም" }); }
});

// Admin: Handle withdrawal (Approve/Reject)
app.post('/api/admin/handle-withdraw', adminOnly, async (req, res) => {
    const { withdrawId, action, reason } = req.body;
    try {
        await db.query('BEGIN');
        const withdraw = await db.query('SELECT * FROM withdraw_requests WHERE id = $1 AND status = $2', [withdrawId, 'pending']);
        if (withdraw.rows.length === 0) throw new Error("ጥያቄው አልተገኘም ወይም ቀደም ብሎ ተስተናግዷል");
        
        const { user_id, amount, method } = withdraw.rows[0];
        const userRes = await db.query('SELECT balance, name, telegram_chat_id FROM users WHERE id = $1', [user_id]);
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));

        if (action === 'approve') {
            await db.query('UPDATE withdraw_requests SET status = $1 WHERE id = $2', ['approved', withdrawId]);
            await db.query('INSERT INTO balance_history (user_id, type, amount, balance_after, description) VALUES ($1, $2, $3, $4, $5)', [user_id, 'withdrawal_approved', amount, userRes.rows[0].balance, `Approved Withdrawal ID: ${withdrawId}`]);
            
            if (botToken && userRes.rows[0].telegram_chat_id) {
                fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: userRes.rows[0].telegram_chat_id,
                        text: `✅ የዊዝድሮው (Withdraw) ጥያቄዎ ተቀባይነት አግኝቷል!\n\nመጠን: ${amount} ETB\n\nገንዘቡ በቅርቡ ይላክልዎታል።`
                    })
                }).catch(e => {});
            }
        } else {
            // Refund the balance
            await db.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [amount, user_id]);
            await db.query('UPDATE withdraw_requests SET status = $1, admin_note = $2 WHERE id = $3', ['rejected', reason || "ውድቅ ተደርጓል", withdrawId]);
            const newBal = parseFloat(userRes.rows[0].balance) + parseFloat(amount);
            await db.query('INSERT INTO balance_history (user_id, type, amount, balance_after, description) VALUES ($1, $2, $3, $4, $5)', [user_id, 'withdrawal_refund', amount, newBal, `Rejected Withdrawal ID: ${withdrawId}. Reason: ${reason}`]);
            
            if (botToken && userRes.rows[0].telegram_chat_id) {
                fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        chat_id: userRes.rows[0].telegram_chat_id,
                        text: `❌ የዊዝድሮው (Withdraw) ጥያቄዎ ውድቅ ተደርጓል!\n\nምክንያት: ${reason || "አልተገለጸም"}\nመጠን: ${amount} ETB ተመላሽ ሆኗል።`
                    })
                }).catch(e => {});
            }
        }
        await db.query('COMMIT');
        res.json({ message: "ተጠናቋል" });
    } catch (err) { await db.query('ROLLBACK'); res.status(500).json({ error: err.message }); }
});

app.post('/api/withdraw-request', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: "Login required" });
    try {
        const decoded = jwt.verify(token, SECRET_KEY);
        const { amount, method, account } = req.body;
        if (!amount || !method || !account) return res.status(400).json({ error: "ሁሉም መረጃዎች መሞላት አለባቸው" });
        
        const MIN_WITHDRAW = 100;
        if (amount < MIN_WITHDRAW) return res.status(400).json({ error: `ዝቅተኛው የዊዝድሮው መጠን ${MIN_WITHDRAW} ብር ነው` });
        
        await db.query('BEGIN');
        const userResult = await db.query('SELECT balance, name FROM users WHERE id = $1', [decoded.id]);
        if (userResult.rows[0].balance < amount) {
            await db.query('ROLLBACK');
            return res.status(400).json({ error: "በቂ ባላንስ የልዎትም" });
        }

        // ALL USERS must meet these requirements
        // Check deposit history for 100 ETB
        const depositHistory = await db.query('SELECT SUM(amount) as total_dep FROM deposit_requests WHERE user_id = $1 AND status = \'approved\'', [decoded.id]);
        const totalDeposited = parseFloat(depositHistory.rows[0].total_dep || 0);

        // Check win count
        const winCount = await db.query('SELECT COUNT(*) as wins FROM balance_history WHERE user_id = $1 AND type = \'win\'', [decoded.id]);
        const totalWins = parseInt(winCount.rows[0].wins || 0);

        if (totalDeposited < 100 || totalWins < 2) {
            await db.query('ROLLBACK');
            return res.status(400).json({ 
                error: "መስፈርቱን አላሟሉም! ገንዘብ ለማውጣት ቢያንስ 100 ብር ዲፖዚት ማድረግ እና ቢያንስ 2 ጊዜ በጨዋታ ማሸነፍ (ሁለቱንም በአንድላይ) ይጠበቅብዎታል" 
            });
        }
        
        await db.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [amount, decoded.id]);
        const insertRes = await db.query('INSERT INTO withdraw_requests (user_id, amount, method, account_details, status) VALUES ($1, $2, $3, $4, $5) RETURNING id', [decoded.id, amount, method, account, 'pending']);
        const withdrawId = insertRes.rows[0].id;
        
        const finalBalRes = await db.query('SELECT balance FROM users WHERE id = $1', [decoded.id]);
        await db.query('INSERT INTO balance_history (user_id, type, amount, balance_after, description) VALUES ($1, $2, $3, $4, $5)', [decoded.id, 'withdrawal_request', -amount, finalBalRes.rows[0].balance, `Withdrawal Request (${method})`]);
        
        await db.query('COMMIT');

        // Notify Admins via Telegram
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        if (botToken) {
            const adminResult = await db.query("SELECT telegram_chat_id FROM users WHERE is_admin = TRUE");
            const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
            adminResult.rows.forEach(admin => {
                if (admin.telegram_chat_id) {
                    fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({
                            chat_id: admin.telegram_chat_id,
                            text: `💸 አዲስ የዊዝድሮው (Withdraw) ጥያቄ!\n\nተጫዋች: ${userResult.rows[0].name || decoded.username}\nመጠን: ${amount} ETB\nዘዴ: ${method}\nዝርዝር: ${account}\n\nእባክዎ ወደ አድሚን ፓናል በመግባት ያጽድቁ።`,
                            reply_markup: {
                                inline_keyboard: [
                                    [{ text: "✅ አጽድቅ (Approve)", callback_data: `approve_wd_${withdrawId}` }, { text: "❌ ውድቅ አድርግ (Reject)", callback_data: `reject_wd_${withdrawId}` }]
                                ]
                            }
                        })
                    }).catch(e => {});
                }
            });
        }

        res.json({ message: "የዊዝድሮው ጥያቄዎ በትክክል ተልኳል፤ አድሚኑ እስኪያጸድቅልዎ ይጠብቁ", balance: finalBalRes.rows[0].balance });
    } catch (err) { 
        await db.query('ROLLBACK'); 
        console.error("Withdraw Error:", err);
        res.status(500).json({ error: "ጥያቄውን መላክ አልተቻለም" }); 
    }
});

app.get('/api/user/balance-history', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: "Login required" });
    try {
        const decoded = jwt.verify(token, SECRET_KEY);
        const result = await db.query('SELECT * FROM balance_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [decoded.id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: "ስህተት" });
    }
});

app.get('/api/user/profile', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: "Login required" });
    try {
        const decoded = jwt.verify(token, SECRET_KEY);
        const userRes = await db.query('SELECT * FROM users WHERE id = $1', [decoded.id]);
        if (userRes.rows.length === 0) return res.status(404).json({ error: "ተጠቃሚው አልተገኘም" });
        const user = userRes.rows[0];
        
        const gamesRes = await db.query('SELECT COUNT(*) as total_games FROM balance_history WHERE user_id = $1 AND type = \'stake\'', [user.id]);
        const winsRes = await db.query('SELECT COUNT(*) as total_wins FROM balance_history WHERE user_id = $1 AND type = \'win\'', [user.id]);
        
        res.json({
            id: user.id,
            username: user.username,
            name: user.name,
            phone: user.phone_number,
            player_id: user.player_id,
            balance: parseFloat(user.balance),
            total_games: parseInt(gamesRes.rows[0].total_games || 0),
            total_wins: parseInt(winsRes.rows[0].total_wins || 0)
        });
    } catch (err) {
        res.status(500).json({ error: "ስህተት" });
    }
});

app.get('/api/user/balance-history', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: "Login required" });
    try {
        const decoded = jwt.verify(token, SECRET_KEY);
        const result = await db.query('SELECT * FROM balance_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [decoded.id]);
        res.json(result.rows);
    } catch (err) {
        res.status(500).json({ error: "ስህተት" });
    }
});

app.get('/api/user/profile', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: "Login required" });
    try {
        const decoded = jwt.verify(token, SECRET_KEY);
        const userRes = await db.query('SELECT * FROM users WHERE id = $1', [decoded.id]);
        if (userRes.rows.length === 0) return res.status(404).json({ error: "ተጠቃሚው አልተገኘም" });
        const user = userRes.rows[0];
        
        const gamesRes = await db.query('SELECT COUNT(*) as total_games FROM balance_history WHERE user_id = $1 AND type = \'stake\'', [user.id]);
        const winsRes = await db.query('SELECT COUNT(*) as total_wins FROM balance_history WHERE user_id = $1 AND type = \'win\'', [user.id]);
        
        res.json({
            id: user.id,
            username: user.username,
            name: user.name,
            phone: user.phone_number,
            player_id: user.player_id,
            balance: parseFloat(user.balance),
            total_games: parseInt(gamesRes.rows[0].total_games || 0),
            total_wins: parseInt(winsRes.rows[0].total_wins || 0)
        });
    } catch (err) {
        res.status(500).json({ error: "ስህተት" });
    }
});

app.get('/api/user/balance', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: "Login required" });
    try {
        const decoded = jwt.verify(token, SECRET_KEY);
        const result = await db.query('SELECT balance FROM users WHERE id = $1', [decoded.id]);
        if (result.rows.length === 0) return res.status(404).json({ error: "ተጠቃሚው አልተገኘም" });
        res.json({ balance: parseFloat(result.rows[0].balance) });
    } catch (err) {
        res.status(500).json({ error: "ስህተት" });
    }
});

app.get('/api/balance-history', async (req, res) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: "Login required" });
    try {
        const decoded = jwt.verify(token, SECRET_KEY);
        const result = await db.query('SELECT * FROM balance_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50', [decoded.id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json({ error: "ስህተት" }); }
});

app.post('/api/admin/broadcast', adminOnly, async (req, res) => {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: "መልዕክት ያስገቡ" });
    try {
        const result = await db.query('SELECT telegram_chat_id FROM users WHERE telegram_chat_id IS NOT NULL');
        const botToken = process.env.TELEGRAM_BOT_TOKEN;
        const telegramUrl = `https://api.telegram.org/bot${botToken}/sendMessage`;
        const fetch = (...args) => import('node-fetch').then(({default: fetch}) => fetch(...args));
        let sc = 0;
        for (const user of result.rows) {
            try { await fetch(telegramUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: user.telegram_chat_id, text: message }) }); sc++; } catch (e) {}
        }
        res.json({ message: `ለ ${sc} ተልኳል` });
    } catch (err) { res.status(500).json({ error: "ስህተት" }); }
});

function startRoomCountdown(amount) {
    const room = rooms[amount]; if (!room) return;
    room.gameCountdown = 30; if (room.countdownInterval) clearInterval(room.countdownInterval);
    room.countdownInterval = setInterval(() => {
        if (room.gameInterval) return;
        room.gameCountdown--;
        broadcastToRoom(amount, { type: 'COUNTDOWN', value: room.gameCountdown, room: amount });
        updateGlobalStats();
        if (room.gameCountdown <= 0) {
            clearInterval(room.countdownInterval); room.countdownInterval = null;
            if (Array.from(room.players).filter(p => p.cardNumber).length > 0) startRoomGame(amount);
            else startRoomCountdown(amount);
        }
    }, 1000);
}

function startRoomGame(amount) {
    const room = rooms[amount]; if (!room) return;
    room.balls = Array.from({length: 75}, (_, i) => i + 1); room.drawnBalls = [];
    broadcastToRoom(amount, { type: 'GAME_START', message: `ተጀምሯል`, room: amount });
    updateGlobalStats();
    if (room.gameInterval) clearInterval(room.gameInterval);
    room.gameInterval = setInterval(() => {
        if (room.balls.length > 0) {
            const ball = room.balls.splice(Math.floor(Math.random() * room.balls.length), 1)[0];
            room.drawnBalls.push(ball);
            broadcastToRoom(amount, { type: 'NEW_BALL', ball, history: room.drawnBalls, room: amount });
        } else {
            clearInterval(room.gameInterval); room.gameInterval = null;
            room.players.forEach(p => { p.cardNumber = null; p.cardData = null; });
            updateGlobalStats(); setTimeout(() => startRoomCountdown(amount), 5000);
        }
    }, 3000);
}

function broadcastToRoom(amount, data) { wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN && c.room == amount) c.send(JSON.stringify(data)); }); }
function broadcastAll(data) { wss.clients.forEach(c => { if (c.readyState === WebSocket.OPEN) c.send(JSON.stringify(data)); }); }

function updateGlobalStats() {
    const stats = {}; const timers = {}; const takenCards = {}; const prizes = {};
    STAKES.forEach(amount => {
        if (rooms[amount]) {
            const playersWithCards = Array.from(rooms[amount].players).filter(p => p.cardNumber || (p.roomData && p.roomData[amount] && p.roomData[amount].cardNumber));
            stats[amount] = playersWithCards.length;
            timers[amount] = rooms[amount].gameInterval ? 'PLAYING' : rooms[amount].gameCountdown;
            const totalPool = amount * playersWithCards.length;
            prizes[amount] = amount === 5 ? totalPool * 0.9 : totalPool * 0.8;
            const roomTaken = []; rooms[amount].players.forEach(p => { const cNum = (p.roomData && p.roomData[amount]) ? p.roomData[amount].cardNumber : p.cardNumber; if (cNum) roomTaken.push(cNum); });
            takenCards[amount] = roomTaken;
        }
    });
    broadcastAll({ type: 'ROOM_STATS', stats, timers, takenCards, prizes });
}

function checkWin(cardData, drawnBalls) {
    if (!cardData) return null; const drawnSet = new Set(drawnBalls); drawnSet.add('FREE');
    const letters = ['B', 'I', 'N', 'G', 'O']; const grid = letters.map(l => cardData[l]);
    for (let r = 0; r < 5; r++) { let win = true; for (let c = 0; c < 5; c++) { if (!drawnSet.has(grid[c][r])) { win = false; break; } } if (win) return { type: 'ROW' }; }
    for (let c = 0; c < 5; c++) { let win = true; for (let r = 0; r < 5; r++) { if (!drawnSet.has(grid[c][r])) { win = false; break; } } if (win) return { type: 'COLUMN' }; }
    let diag1 = true; let diag2 = true;
    for (let i = 0; i < 5; i++) { if (!drawnSet.has(grid[i][i])) diag1 = false; if (!drawnSet.has(grid[i][4-i])) diag2 = false; }
    if (diag1 || diag2) return { type: 'DIAGONAL' };
    if (drawnSet.has(grid[0][0]) && drawnSet.has(grid[4][0]) && drawnSet.has(grid[0][4]) && drawnSet.has(grid[4][4])) return { type: 'CORNERS' };
    return null;
}

wss.on('connection', (ws) => {
    ws.on('message', async (msg) => {
        const data = JSON.parse(msg);
        if (data.type === 'BINGO_CLAIM') {
            const room = rooms[data.room]; if (!room || !room.gameInterval) {
                ws.send(JSON.stringify({ type: 'ERROR', message: "ጨዋታው ገና አልተጀመረም ወይም ተጠናቋል" }));
                return;
            }
            
            // Support both direct cardNumber and cardData in request
            const cardNum = data.cardNumber;
            const cardData = data.cardData || (ws.roomData && ws.roomData[data.room] ? ws.roomData[data.room].cardData : ws.cardData);
            
            if (!cardData) {
                ws.send(JSON.stringify({ type: 'ERROR', message: "የእርስዎ ካርድ መረጃ አልተገኘም" }));
                return;
            }

            const win = checkWin(cardData, room.drawnBalls);
            if (win) {
                clearInterval(room.gameInterval); room.gameInterval = null;
                const pc = Array.from(room.players).filter(p => p.cardNumber || (p.roomData && p.roomData[data.room])).length;
                const wa = room.stake === 5 ? (room.stake * pc) * 0.9 : (room.stake * pc) * 0.8;
                try {
                    await db.query('UPDATE users SET balance = balance + $1 WHERE id = $2', [wa, ws.userId]);
                    const ur = await db.query('SELECT balance FROM users WHERE id = $1', [ws.userId]);
                    await db.query('INSERT INTO balance_history (user_id, type, amount, balance_after, description) VALUES ($1, $2, $3, $4, $5)', [ws.userId, 'win', wa, ur.rows[0].balance, `Win Room ${data.room}`]);
                    broadcastToRoom(data.room, { 
                        type: 'GAME_OVER', 
                        winner: ws.username, 
                        amount: wa, 
                        pattern: win.type, 
                        room: data.room,
                        winCard: cardData,
                        winPattern: room.drawnBalls
                    });
                    updateGlobalStats(); setTimeout(() => startRoomCountdown(data.room), 5000);
                } catch (e) {
                    console.error("Bingo win processing error:", e);
                }
            } else {
                ws.send(JSON.stringify({ type: 'ERROR', message: "ቢንጎ አልሞላም! እባክዎ በትክክል ያረጋግጡ" }));
            }
        }
        if (data.type === 'JOIN_ROOM') {
            try {
                const decoded = jwt.verify(data.token, SECRET_KEY);
                ws.userId = decoded.id; ws.username = decoded.username; ws.room = data.room;
                if (rooms[ws.room]) { rooms[ws.room].players.add(ws); updateGlobalStats(); }
            } catch (e) {}
        }
        if (data.type === 'BUY_CARD') {
            const room = rooms[data.room]; if (!room) return;
            try {
                const ur = await db.query('SELECT balance FROM users WHERE id = $1', [ws.userId]);
                if (ur.rows[0].balance < room.stake) return;
                let taken = false; room.players.forEach(p => { if (p.cardNumber == data.cardNumber || (p.roomData && p.roomData[data.room] && p.roomData[data.room].cardNumber == data.cardNumber)) taken = true; });
                if (taken) return;
                await db.query('UPDATE users SET balance = balance - $1 WHERE id = $2', [room.stake, ws.userId]);
                const nb = ur.rows[0].balance - room.stake;
                await db.query('INSERT INTO balance_history (user_id, type, amount, balance_after, description) VALUES ($1, $2, $3, $4, $5)', [ws.userId, 'stake', -room.stake, nb, `Buy Room ${data.room}`]);
                ws.cardNumber = data.cardNumber; ws.cardData = data.cardData;
                if (!ws.roomData) ws.roomData = {}; ws.roomData[data.room] = { cardNumber: data.cardNumber, cardData: data.cardData };
                ws.send(JSON.stringify({ type: 'BUY_SUCCESS', balance: nb })); updateGlobalStats();
            } catch (e) {}
        }
    });
    ws.on('close', () => { STAKES.forEach(a => { if (rooms[a]) rooms[a].players.delete(ws); }); updateGlobalStats(); });
});

async function initDatabase() {
    try {
        await db.query(`
            CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, phone_number VARCHAR(20) UNIQUE NOT NULL, password_hash TEXT NOT NULL, username VARCHAR(50) UNIQUE, name VARCHAR(100), balance DECIMAL(10, 2) DEFAULT 0, is_admin BOOLEAN DEFAULT FALSE, player_id VARCHAR(20), telegram_chat_id VARCHAR(50), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS balance_history (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id), type VARCHAR(50), amount DECIMAL(10, 2) NOT NULL, balance_after DECIMAL(10, 2) NOT NULL, description TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS deposit_requests (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id), amount DECIMAL(10, 2) NOT NULL, method VARCHAR(50), transaction_code VARCHAR(100), status VARCHAR(20) DEFAULT 'pending', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
            CREATE TABLE IF NOT EXISTS withdraw_requests (id SERIAL PRIMARY KEY, user_id INTEGER REFERENCES users(id), amount DECIMAL(10, 2) NOT NULL, method VARCHAR(50), account_details TEXT, status VARCHAR(20) DEFAULT 'pending', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
            DO $$ BEGIN 
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='player_id') THEN ALTER TABLE users ADD COLUMN player_id VARCHAR(20); END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='is_admin') THEN ALTER TABLE users ADD COLUMN is_admin BOOLEAN DEFAULT FALSE; END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='telegram_chat_id') THEN ALTER TABLE users ADD COLUMN telegram_chat_id VARCHAR(50); END IF;
                IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='users' AND column_name='created_at') THEN ALTER TABLE users ADD COLUMN created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP; END IF;
            END $$;
        `);
    } catch (e) {}
}

server.listen(PORT, '0.0.0.0', async () => {
    STAKES.forEach(a => startRoomCountdown(a));
    await initDatabase();
    await setTelegramWebhook();
});
