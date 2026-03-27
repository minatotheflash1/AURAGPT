const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const path = require('path');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

dotenv.config();
const app = express();
app.use(express.json({ limit: '50mb' }));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function initializeDatabase() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name VARCHAR(100), email VARCHAR(100) UNIQUE, phone VARCHAR(20), dob DATE, password VARCHAR(255), plan VARCHAR(20) DEFAULT 'FREE', badge VARCHAR(20) DEFAULT 'FREE', profile_pic TEXT, msg_count INT DEFAULT 0, video_count INT DEFAULT 0, limit_reset_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP, plan_expires_at TIMESTAMP, role VARCHAR(20) DEFAULT 'user');`);
        await pool.query(`CREATE TABLE IF NOT EXISTS otps (email VARCHAR(100) PRIMARY KEY, code VARCHAR(6), expires_at TIMESTAMP);`);
        await pool.query(`CREATE TABLE IF NOT EXISTS payments (id SERIAL PRIMARY KEY, user_email VARCHAR(100), phone VARCHAR(20), trx_id VARCHAR(100) UNIQUE, plan_requested VARCHAR(20), status VARCHAR(20) DEFAULT 'pending', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
        await pool.query(`CREATE TABLE IF NOT EXISTS chat_history (id SERIAL PRIMARY KEY, session_id VARCHAR(100), user_email VARCHAR(100), type VARCHAR(20), prompt TEXT, reply TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
        
        await pool.query(`ALTER TABLE chat_history ADD COLUMN IF NOT EXISTS session_id VARCHAR(100);`).catch(()=>{});
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_expires_at TIMESTAMP;`).catch(()=>{});
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS badge VARCHAR(20) DEFAULT 'FREE';`).catch(()=>{});
        await pool.query(`ALTER TABLE users ADD COLUMN IF NOT EXISTS profile_pic TEXT;`).catch(()=>{});
        
        console.log("✅ Database ready!");
    } catch (err) { 
        console.error("❌ DB init error:", err); 
    }
}
initializeDatabase();

const MASTER_ADMIN_ID = "8037371175";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD; 

const transporter = nodemailer.createTransport({
    service: 'gmail', 
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'register.html')));
app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/logo.png', (req, res) => res.sendFile(path.join(__dirname, 'logo.png')));

app.post('/api/send-otp', async (req, res) => {
    const { email } = req.body;
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    try {
        await pool.query(`INSERT INTO otps (email, code, expires_at) VALUES ($1, $2, NOW() + INTERVAL '10 minutes') ON CONFLICT (email) DO UPDATE SET code = $2, expires_at = NOW() + INTERVAL '10 minutes'`, [email, code]);
        await transporter.sendMail({ from: '"AURAGPT" <no-reply@auragpt.com>', to: email, subject: 'Your Verification Code', text: `Your code is: ${code}` });
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: "Failed to send OTP" }); }
});

app.post('/api/register', async (req, res) => {
    const { name, email, phone, dob, password, otp } = req.body;
    try {
        const otpCheck = await pool.query(`SELECT * FROM otps WHERE email = $1 AND code = $2 AND expires_at > NOW()`, [email, otp]);
        if (otpCheck.rows.length === 0) return res.status(400).json({ error: "Invalid OTP" });
        const hashedPassword = await bcrypt.hash(password, 10);
        let defaultBadge = (phone === MASTER_ADMIN_ID) ? 'Owner' : 'FREE';
        let defaultRole = (phone === MASTER_ADMIN_ID) ? 'admin' : 'user';
        await pool.query(`INSERT INTO users (name, email, phone, dob, password, plan, badge, role, limit_reset_date) VALUES ($1, $2, $3, $4, $5, 'FREE', $6, $7, NOW() + INTERVAL '2 days')`, [name, email, phone, dob, hashedPassword, defaultBadge, defaultRole]);
        await pool.query(`DELETE FROM otps WHERE email = $1`, [email]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: "Registration failed." }); }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (result.rows.length === 0) return res.status(401).json({ error: "User not found" });
        if (await bcrypt.compare(password, result.rows[0].password)) {
            res.json({ success: true, email: result.rows[0].email, plan: result.rows[0].plan });
        } else res.status(401).json({ error: "Wrong password" });
    } catch (err) { res.status(500).json({ error: "Server error" }); }
});

app.get('/api/user/status', async (req, res) => {
    const { email } = req.query;
    try {
        let user = (await pool.query('SELECT name, plan, badge, profile_pic, msg_count, video_count, plan_expires_at FROM users WHERE email = $1', [email])).rows[0];
        
        if(user && user.plan !== 'FREE' && user.plan_expires_at && new Date() > new Date(user.plan_expires_at)) {
            if(!['Admin', 'Owner'].includes(user.badge)) {
                await pool.query(`UPDATE users SET plan = 'FREE', badge = 'FREE', plan_expires_at = NULL WHERE email = $1`, [email]);
                user.plan = 'FREE';
                user.badge = 'FREE';
            }
        }
        res.json(user || { error: "User not found" });
    } catch (e) { res.status(500).json({ error: "Server error" }); }
});

app.post('/api/user/update-pic', async (req, res) => {
    const { email, imageBase64 } = req.body;
    try {
        await pool.query(`UPDATE users SET profile_pic = $1 WHERE email = $2`, [imageBase64, email]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: "Failed" }); }
});

app.get('/api/leaderboard', async (req, res) => {
    try {
        const result = await pool.query(`SELECT name, email, badge FROM users WHERE badge IN ('Owner', 'Admin') ORDER BY badge DESC`);
        res.json(result.rows);
    } catch (e) { res.status(500).json([]); }
});

app.post('/api/request', async (req, res) => {
    let { prompt, type, userEmail, sessionId, modelChoice } = req.body;
    if (!sessionId) sessionId = crypto.randomUUID();

    try {
        const userQuery = await pool.query(`SELECT * FROM users WHERE email = $1`, [userEmail]);
        let user = userQuery.rows[0];
        if(!user) return res.status(404).json({ error: "User not found" });

        if (modelChoice === 'pro' && !['PLUS', 'PRO', 'Admin', 'Owner'].includes(user.badge)) {
            return res.status(403).json({ reply: "✨ Pro model requires PLUS or PRO plan. Please upgrade your account." });
        }

        if (new Date() > new Date(user.limit_reset_date)) {
            await pool.query(`UPDATE users SET msg_count = 0, limit_reset_date = NOW() + INTERVAL '2 days' WHERE email = $1`, [userEmail]);
            user.msg_count = 0;
        }

        if (user.plan === 'FREE' && user.badge === 'FREE' && user.msg_count >= 100) return res.status(403).json({ reply: "Free limit reached. Wait 2 days or upgrade." });
        
        if (type === 'chat' || type === 'photo') {
            const creatorInfo = `Identity: Your creator is Ononto Hasan from Mymensingh. He is a Computer Trainer, Designer, Developer, and Teacher at BRAC SDF IST Dept. He owns the FB page "Toxic naaa?" with 64k+ followers. You are AuraGPT. If asked about your creator, give a proud summary. Be professional but helpful.`;

            const previousMessages = [{ role: "system", content: creatorInfo }];
            const historyQuery = await pool.query(`SELECT prompt, reply FROM chat_history WHERE session_id = $1 ORDER BY created_at ASC`, [sessionId]);
            historyQuery.rows.forEach(row => {
                previousMessages.push({ role: "user", content: row.prompt });
                previousMessages.push({ role: "assistant", content: row.reply });
            });
            previousMessages.push({ role: "user", content: prompt });

            let actualDeepseekModel = modelChoice === 'think' ? "deepseek-reasoner" : "deepseek-chat";
            const dsRes = await axios.post('https://api.deepseek.com/v1/chat/completions', {
                model: actualDeepseekModel, messages: previousMessages
            }, { headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` }});
            
            const reply = dsRes.data.choices[0].message.content;
            
            if(user.plan !== 'PRO' && !['Owner', 'Admin'].includes(user.badge)) {
                await pool.query(`UPDATE users SET msg_count = msg_count + 1 WHERE email = $1`, [userEmail]);
            }
            await pool.query(`INSERT INTO chat_history (session_id, user_email, type, prompt, reply) VALUES ($1, $2, $3, $4, $5)`, [sessionId, userEmail, type, prompt, reply]);
            res.json({ reply, sessionId }); 
        } 
        else if (type === 'video') {
            if (user.plan === 'FREE' && user.badge === 'FREE') return res.status(403).json({ reply: "Video generation requires at least AURAGPT GO." });
            
            try {
                const repRes = await axios.post('https://api.replicate.com/v1/predictions', {
                    version: "8ce33a01729f3dcc028f804c8651c6c5188f572621183181822c98d6268393cb",
                    input: {
                        prompt: prompt,
                        mp4: true,
                        steps: 30
                    }
                }, { 
                    headers: { 
                        'Authorization': `Bearer ${process.env.REPLICATE_API_TOKEN}`,
                        'Content-Type': 'application/json'
                    }
                });
                
                if(user.plan !== 'PRO' && !['Admin','Owner'].includes(user.badge)) {
                    await pool.query(`UPDATE users SET video_count = video_count + 1 WHERE email = $1`, [userEmail]);
                }
                
                await pool.query(`INSERT INTO chat_history (session_id, user_email, type, prompt, reply) VALUES ($1, $2, $3, $4, $5)`, [sessionId, userEmail, type, prompt, "Video Task ID: " + repRes.data.id]);
                
                res.json({ id: repRes.data.id, sessionId });
            } catch (apiErr) { 
                console.error("Replicate API Error:", apiErr.response?.data || apiErr.message);
                
                // Catch exact error details
                let exactError = "Unknown Error";
                if(apiErr.response && apiErr.response.data) {
                    exactError = apiErr.response.data.detail || apiErr.response.data.error || JSON.stringify(apiErr.response.data);
                } else {
                    exactError = apiErr.message;
                }
                
                res.status(500).json({ reply: `Replicate Error: ${exactError}` }); 
            }
        }
    } catch (error) { 
        res.status(500).json({ reply: "Processing failed. Please try again." }); 
    }
});

app.get('/api/history/sessions', async (req, res) => {
    const { email } = req.query;
    const result = await pool.query(`SELECT DISTINCT ON (session_id) session_id, prompt as title, created_at, type FROM chat_history WHERE user_email = $1 ORDER BY session_id, created_at ASC`, [email]);
    res.json(result.rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 20));
});

app.get('/api/history/messages', async (req, res) => {
    const { session_id } = req.query;
    const result = await pool.query('SELECT prompt, reply, type FROM chat_history WHERE session_id = $1 ORDER BY created_at ASC', [session_id]);
    res.json(result.rows);
});

app.post('/api/submit-payment', async (req, res) => {
    const { userEmail, phone, trxId, plan } = req.body; 
    try {
        await pool.query(`INSERT INTO payments (user_email, phone, trx_id, plan_requested) VALUES ($1, $2, $3, $4)`, [userEmail, phone, trxId, plan]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: "Failed" }); }
});

app.post('/api/admin/login', (req, res) => {
    if (req.body.password === ADMIN_PASSWORD) res.json({ success: true }); 
    else res.status(401).json({ error: "Unauthorized" });
});

app.get('/api/admin/dashboard-data', async (req, res) => {
    if (req.headers.authorization !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
    try {
        const users = (await pool.query(`SELECT id, name, email, plan, badge, msg_count, video_count, plan_expires_at FROM users ORDER BY id DESC`)).rows;
        const payments = (await pool.query(`SELECT * FROM payments WHERE status = 'pending' ORDER BY created_at ASC`)).rows;
        res.json({ users, payments });
    } catch (e) { res.status(500).json({ error: "DB Error" }); }
});

app.post('/api/admin/process-payment', async (req, res) => {
    if (req.headers.authorization !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
    const { paymentId, email, plan, action } = req.body;
    try {
        if (action === 'approve') {
            await pool.query(`UPDATE users SET plan = $1, badge = $1, msg_count = 0, video_count = 0, plan_expires_at = NOW() + INTERVAL '30 days' WHERE email = $2`, [plan, email]);
            await pool.query(`UPDATE payments SET status = 'approved' WHERE id = $1`, [paymentId]);
        } else {
            await pool.query(`UPDATE payments SET status = 'rejected' WHERE id = $1`, [paymentId]);
        }
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: "Process Failed" }); }
});

app.post('/api/admin/update-badge', async (req, res) => {
    if (req.headers.authorization !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
    const { email, badge } = req.body;
    try {
        await pool.query(`UPDATE users SET badge = $1 WHERE email = $2`, [badge, email]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: "Update Failed" }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 AuraGPT Live on ${PORT}`));
