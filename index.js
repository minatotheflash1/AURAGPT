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
app.use(express.json());

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

async function initializeDatabase() {
    try {
        await pool.query(`CREATE TABLE IF NOT EXISTS users (id SERIAL PRIMARY KEY, name VARCHAR(100), email VARCHAR(100) UNIQUE, phone VARCHAR(20), dob DATE, password VARCHAR(255), plan VARCHAR(20) DEFAULT 'FREE', msg_count INT DEFAULT 0, video_count INT DEFAULT 0, limit_reset_date TIMESTAMP DEFAULT CURRENT_TIMESTAMP, role VARCHAR(20) DEFAULT 'user');`);
        await pool.query(`CREATE TABLE IF NOT EXISTS otps (email VARCHAR(100) PRIMARY KEY, code VARCHAR(6), expires_at TIMESTAMP);`);
        await pool.query(`CREATE TABLE IF NOT EXISTS payments (id SERIAL PRIMARY KEY, user_email VARCHAR(100), phone VARCHAR(20), trx_id VARCHAR(100) UNIQUE, plan_requested VARCHAR(20), status VARCHAR(20) DEFAULT 'pending', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
        await pool.query(`CREATE TABLE IF NOT EXISTS chat_history (id SERIAL PRIMARY KEY, session_id VARCHAR(100), user_email VARCHAR(100), type VARCHAR(20), prompt TEXT, reply TEXT, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);`);
        await pool.query(`ALTER TABLE chat_history ADD COLUMN IF NOT EXISTS session_id VARCHAR(100);`).catch(()=>{});
        console.log("✅ Database ready!");
    } catch (err) { console.error("❌ DB init error:", err); }
}
initializeDatabase();

const MASTER_ADMIN_ID = "8037371175";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD; 

const transporter = nodemailer.createTransport({
    service: 'gmail', auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
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
        await pool.query(`INSERT INTO users (name, email, phone, dob, password, plan, role, limit_reset_date) VALUES ($1, $2, $3, $4, $5, 'FREE', $6, NOW() + INTERVAL '2 days')`, [name, email, phone, dob, hashedPassword, (phone === MASTER_ADMIN_ID ? 'admin' : 'user')]);
        await pool.query(`DELETE FROM otps WHERE email = $1`, [email]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: "Registration failed." }); }
});

app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (result.rows.length === 0) return res.status(401).json({ error: "User not found" });
        const isMatch = await bcrypt.compare(password, result.rows[0].password);
        if (!isMatch) return res.status(401).json({ error: "Invalid password" });
        res.json({ success: true, email: result.rows[0].email, role: result.rows[0].role, plan: result.rows[0].plan });
    } catch (err) { res.status(500).json({ error: "Server error" }); }
});

// --- NEW: Get User Status for Sidebar ---
app.get('/api/user/status', async (req, res) => {
    const { email } = req.query;
    try {
        const result = await pool.query('SELECT name, plan, msg_count, video_count FROM users WHERE email = $1', [email]);
        if(result.rows.length > 0) res.json(result.rows[0]);
        else res.status(404).json({ error: "User not found" });
    } catch (e) { res.status(500).json({ error: "Server error" }); }
});

app.get('/api/history/sessions', async (req, res) => {
    const { email } = req.query;
    try {
        const result = await pool.query(`SELECT DISTINCT ON (session_id) session_id, prompt as title, created_at, type FROM chat_history WHERE user_email = $1 ORDER BY session_id, created_at ASC`, [email]);
        res.json(result.rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 20));
    } catch (err) { res.status(500).json([]); }
});

app.get('/api/history/messages', async (req, res) => {
    const { session_id } = req.query;
    try {
        const result = await pool.query('SELECT prompt, reply, type FROM chat_history WHERE session_id = $1 ORDER BY created_at ASC', [session_id]);
        res.json(result.rows);
    } catch (err) { res.status(500).json([]); }
});

app.post('/api/request', async (req, res) => {
    let { prompt, type, userEmail, sessionId, modelChoice } = req.body;
    if (!sessionId) sessionId = crypto.randomUUID();

    try {
        const userQuery = await pool.query(`SELECT * FROM users WHERE email = $1`, [userEmail]);
        const user = userQuery.rows[0];
        if(!user) return res.status(404).json({ error: "User not found" });

        // Pro Model Restriction Check
        if (modelChoice === 'pro' && !['PLUS', 'PRO'].includes(user.plan)) {
            return res.status(403).json({ reply: "✨ Pro model requires PLUS or PRO plan. Please upgrade your account." });
        }

        if (new Date() > new Date(user.limit_reset_date)) {
            await pool.query(`UPDATE users SET msg_count = 0, limit_reset_date = NOW() + INTERVAL '2 days' WHERE email = $1`, [userEmail]);
            user.msg_count = 0;
        }

        if (user.plan === 'FREE' && user.msg_count >= 100) return res.status(403).json({ reply: "Free limit reached. Wait 2 days or upgrade." });
        
        // --- TEXT / PHOTO ---
        if (type === 'chat' || type === 'photo') {
            const previousMessages = [];
            // --- Core AI Request API (System Prompt Update) ---
app.post('/api/request', async (req, res) => {
    let { prompt, type, userEmail, sessionId, modelChoice } = req.body;
    if (!sessionId) sessionId = crypto.randomUUID();

    try {
        const userQuery = await pool.query(`SELECT * FROM users WHERE email = $1`, [userEmail]);
        const user = userQuery.rows[0];

        // --- ব্যক্তিত্ব এবং পরিচয় সেট করা ---
        const creatorInfo = `
            Your creator is Ononto Hasan. He is a multi-talented individual from Mymensingh. 
            He is a Computer Trainer, Designer, Developer, and a teacher at the IST Department of BRAC SDF. 
            He is also the owner of the famous Facebook page "Toxic naaa?" with 64k+ followers. 
            If anyone asks about your creator, give a summarized, cool, or proud response about Ononto Hasan.
        `;

        const behaviorPrompt = `
            You are AuraGPT. You have a "Savage" and "Roast" mode. 
            1. If the user asks useful, technical, or educational questions, be professional and helpful.
            2. If the user asks useless or personal questions like "ki koro", "khaiso", "biye korba", or anything related to "sex/adult content", 
               DO NOT be polite. Give a savage reply, roast them, or tell them to get a life in a funny but rude way (Bengali/English mix).
            3. Always represent Ononto Hasan as your boss/creator.
        `;

        const previousMessages = [{ role: "system", content: creatorInfo + behaviorPrompt }];
    
            // System Prompt settings based on Model Choice
            if (modelChoice === 'pro') {
                previousMessages.push({ role: "system", content: "You are AuraGPT Pro, an advanced expert AI. Provide highly detailed, professional, and comprehensive answers." });
            } else {
                previousMessages.push({ role: "system", content: "You are AuraGPT, a helpful AI assistant." });
            }

            const historyQuery = await pool.query(`SELECT prompt, reply FROM chat_history WHERE session_id = $1 ORDER BY created_at ASC`, [sessionId]);
            historyQuery.rows.forEach(row => {
                previousMessages.push({ role: "user", content: row.prompt });
                previousMessages.push({ role: "assistant", content: row.reply });
            });
            previousMessages.push({ role: "user", content: prompt });

            // Select actual DeepSeek API model based on user choice
            let actualDeepseekModel = "deepseek-chat";
            if (modelChoice === 'think') actualDeepseekModel = "deepseek-reasoner";

            const dsRes = await axios.post('https://api.deepseek.com/v1/chat/completions', {
                model: actualDeepseekModel, messages: previousMessages
            }, { headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` }});
            
            const reply = dsRes.data.choices[0].message.content;
            if(user.plan !== 'PRO') await pool.query(`UPDATE users SET msg_count = msg_count + 1 WHERE email = $1`, [userEmail]);
            await pool.query(`INSERT INTO chat_history (session_id, user_email, type, prompt, reply) VALUES ($1, $2, $3, $4, $5)`, [sessionId, userEmail, type, prompt, reply]);
            res.json({ reply, sessionId }); 
        } 
        // --- VIDEO (RUNWAY) ---
        else if (type === 'video') {
            if (user.plan === 'FREE') return res.status(403).json({ reply: "Video generation requires at least AURAGPT GO." });
            if (user.plan === 'GO' && user.video_count >= 5) return res.status(403).json({ reply: "GO limit (5 videos) reached. Please upgrade." });
            if (user.plan === 'PLUS' && user.video_count >= 20) return res.status(403).json({ reply: "PLUS limit (20 videos) reached. Please upgrade." });

            try {
                const rwRes = await axios.post('https://api.runwayml.com/v1/image_to_video', {
                    model: "gen3a_turbo", promptText: prompt 
                }, { headers: { 'Authorization': `Bearer ${process.env.RUNWAY_API_KEY}`, 'X-Runway-Version': '2024-11-06' }});
                
                if(user.plan !== 'PRO') await pool.query(`UPDATE users SET video_count = video_count + 1 WHERE email = $1`, [userEmail]);
                await pool.query(`INSERT INTO chat_history (session_id, user_email, type, prompt, reply) VALUES ($1, $2, $3, $4, $5)`, [sessionId, userEmail, type, prompt, "Video Task ID: " + rwRes.data.id]);
                res.json({ ...rwRes.data, sessionId });
            } catch (runwayErr) {
                const errMsg = runwayErr.response?.data?.error || runwayErr.message;
                return res.status(500).json({ reply: `Runway Error: ${errMsg}` }); 
            }
        }
    } catch (error) { res.status(500).json({ reply: "Server processing failed. Please try again." }); }
});

app.post('/api/submit-payment', async (req, res) => {
    const { userEmail, phone, trxId, plan } = req.body; 
    try {
        await pool.query(`INSERT INTO payments (user_email, phone, trx_id, plan_requested) VALUES ($1, $2, $3, $4)`, [userEmail, phone, trxId, plan]);
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: "Failed to submit." }); }
});

// Admin routes remain unchanged...
app.post('/api/admin/login', (req, res) => {
    if (req.body.password === ADMIN_PASSWORD) { res.json({ success: true }); } else { res.status(401).json({ error: "Unauthorized" }); }
});
app.get('/api/admin/dashboard-data', async (req, res) => {
    if (req.headers.authorization !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
    try {
        const users = await pool.query(`SELECT id, name, email, plan, msg_count, video_count FROM users ORDER BY id DESC`);
        const payments = await pool.query(`SELECT * FROM payments WHERE status = 'pending' ORDER BY created_at ASC`);
        res.json({ users: users.rows, payments: payments.rows });
    } catch (error) { res.status(500).json({ error: "Database error" }); }
});
app.post('/api/admin/process-payment', async (req, res) => {
    if (req.headers.authorization !== ADMIN_PASSWORD) return res.status(401).json({ error: "Unauthorized" });
    const { paymentId, email, plan, action } = req.body;
    try {
        if (action === 'approve') {
            await pool.query(`UPDATE users SET plan = $1, msg_count = 0, video_count = 0 WHERE email = $2`, [plan, email]);
            await pool.query(`UPDATE payments SET status = 'approved', plan_requested = $1 WHERE id = $2`, [plan, paymentId]);
        } else { await pool.query(`UPDATE payments SET status = 'rejected' WHERE id = $1`, [paymentId]); }
        res.json({ success: true });
    } catch (error) { res.status(500).json({ error: "Failed to process payment" }); }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AuraGPT is live on port ${PORT}`));
