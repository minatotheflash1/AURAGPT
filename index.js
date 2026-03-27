const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const path = require('path');
const { Pool } = require('pg');
const nodemailer = require('nodemailer');
const bcrypt = require('bcryptjs');

dotenv.config();
const app = express();
app.use(express.json());

// Database Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

const MASTER_ADMIN_ID = "8037371175";

const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: { user: process.env.EMAIL_USER, pass: process.env.EMAIL_PASS }
});

// --- HTML PAGE ROUTES ---
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'register.html')));
app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'admin.html')));
app.get('/logo.png', (req, res) => res.sendFile(path.join(__dirname, 'logo.png')));

// --- API ROUTES ---

// 1. Send OTP
app.post('/api/send-otp', async (req, res) => {
    const { email } = req.body;
    const code = Math.floor(100000 + Math.random() * 900000).toString();
    try {
        await pool.query(
            `INSERT INTO otps (email, code, expires_at) VALUES ($1, $2, NOW() + INTERVAL '10 minutes')
             ON CONFLICT (email) DO UPDATE SET code = $2, expires_at = NOW() + INTERVAL '10 minutes'`,
            [email, code]
        );
        await transporter.sendMail({
            from: '"AURAGPT" <no-reply@auragpt.com>',
            to: email,
            subject: 'Your AURAGPT Verification Code',
            text: `Welcome! Your verification code is: ${code}`
        });
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: "Failed to send OTP" });
    }
});

// 2. Register
app.post('/api/register', async (req, res) => {
    const { name, email, phone, dob, password, otp } = req.body;
    try {
        const otpCheck = await pool.query(`SELECT * FROM otps WHERE email = $1 AND code = $2 AND expires_at > NOW()`, [email, otp]);
        if (otpCheck.rows.length === 0) return res.status(400).json({ error: "Invalid or expired OTP" });

        const assignedRole = (phone === MASTER_ADMIN_ID) ? 'admin' : 'user';
        const hashedPassword = await bcrypt.hash(password, 10);

        await pool.query(
            `INSERT INTO users (name, email, phone, dob, password, plan, role, limit_reset_date) 
             VALUES ($1, $2, $3, $4, $5, 'FREE', $6, NOW() + INTERVAL '2 days')`,
            [name, email, phone, dob, hashedPassword, assignedRole]
        );
        await pool.query(`DELETE FROM otps WHERE email = $1`, [email]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: "Registration failed. Email might already exist." });
    }
});

// 3. Login
app.post('/api/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
        if (result.rows.length === 0) return res.status(401).json({ error: "User not found" });
        
        const user = result.rows[0];
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) return res.status(401).json({ error: "Invalid password" });
        
        res.json({ success: true, email: user.email, role: user.role, plan: user.plan });
    } catch (err) {
        res.status(500).json({ error: "Server error" });
    }
});

// 4. Generate AI Request
app.post('/api/request', async (req, res) => {
    const { prompt, type, userEmail } = req.body;
    try {
        const userQuery = await pool.query(`SELECT * FROM users WHERE email = $1`, [userEmail]);
        const user = userQuery.rows[0];
        if(!user) return res.status(404).json({ error: "User not found" });

        if (new Date() > new Date(user.limit_reset_date)) {
            await pool.query(`UPDATE users SET msg_count = 0, limit_reset_date = NOW() + INTERVAL '2 days' WHERE email = $1`, [userEmail]);
            user.msg_count = 0;
        }

        if (user.plan === 'FREE' && user.msg_count >= 100) return res.status(403).json({ reply: "Free limit reached. Wait 2 days or upgrade." });
        if (type === 'video') {
            if (user.plan === 'FREE') return res.status(403).json({ reply: "Video generation requires at least AURAGPT GO." });
            if (user.plan === 'GO' && user.video_count >= 5) return res.status(403).json({ reply: "GO limit (5 videos) reached. Please upgrade." });
            if (user.plan === 'PLUS' && user.video_count >= 20) return res.status(403).json({ reply: "PLUS limit (20 videos) reached. Please upgrade." });
        }

        if (type === 'chat' || type === 'photo') {
            const dsRes = await axios.post('https://api.deepseek.com/v1/chat/completions', {
                model: "deepseek-chat", messages: [{"role": "user", "content": prompt}]
            }, { headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` }});
            
            if(user.plan !== 'PRO') await pool.query(`UPDATE users SET msg_count = msg_count + 1 WHERE email = $1`, [userEmail]);
            res.json({ reply: dsRes.data.choices[0].message.content });
        } else if (type === 'video') {
            const rwRes = await axios.post('https://api.runwayml.com/v1/image_to_video', {
                model: "gen3a_turbo", prompt_text: prompt
            }, { headers: { 'Authorization': `Bearer ${process.env.RUNWAY_API_KEY}`, 'X-Runway-Version': '2024-11-06' }});
            
            if(user.plan !== 'PRO') await pool.query(`UPDATE users SET video_count = video_count + 1 WHERE email = $1`, [userEmail]);
            res.json(rwRes.data);
        }
    } catch (error) {
        res.status(500).json({ reply: "API processing failed." });
    }
});

// 5. Submit Payment
app.post('/api/submit-payment', async (req, res) => {
    const { userEmail, phone, trxId } = req.body; 
    try {
        await pool.query(`INSERT INTO payments (user_email, phone, trx_id) VALUES ($1, $2, $3)`, [userEmail, phone, trxId]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: "Failed to submit. TrxID might exist." });
    }
});

// 6. Admin Dashboard Data
app.get('/api/admin/dashboard-data', async (req, res) => {
    try {
        const users = await pool.query(`SELECT id, name, email, plan, msg_count, video_count FROM users ORDER BY id DESC`);
        const payments = await pool.query(`SELECT * FROM payments WHERE status = 'pending' ORDER BY created_at ASC`);
        res.json({ users: users.rows, payments: payments.rows });
    } catch (error) {
        res.status(500).json({ error: "Database error" });
    }
});

// 7. Admin Process Payment
app.post('/api/admin/process-payment', async (req, res) => {
    const { paymentId, email, plan, action } = req.body;
    try {
        if (action === 'approve') {
            await pool.query(`UPDATE users SET plan = $1, msg_count = 0, video_count = 0 WHERE email = $2`, [plan, email]);
            await pool.query(`UPDATE payments SET status = 'approved', plan_requested = $1 WHERE id = $2`, [plan, paymentId]);
        } else {
            await pool.query(`UPDATE payments SET status = 'rejected' WHERE id = $1`, [paymentId]);
        }
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: "Failed to process payment" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AuraGPT is live on port ${PORT}`));
