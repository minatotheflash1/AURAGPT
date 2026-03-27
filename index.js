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
    connectionString: process.env.DATABASE_URL, // Railway তে এটি অটোমেটিক থাকে
    ssl: { rejectUnauthorized: false }
});

// Master Admin Check Setup
const MASTER_ADMIN_ID = "8037371175";

// Nodemailer Setup (AURAGPT Email)
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER, // আপনার জিমেইল
        pass: process.env.EMAIL_PASS  // Gmail App Password
    }
});

// Routes for HTML pages
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/register', (req, res) => res.sendFile(path.join(__dirname, 'register.html')));
app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
app.get('/logo.png', (req, res) => res.sendFile(path.join(__dirname, 'logo.png')));

// --- 1. SEND OTP API ---
app.post('/api/send-otp', async (req, res) => {
    const { email } = req.body;
    const code = Math.floor(100000 + Math.random() * 900000).toString(); // 6 digit OTP

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
            text: `Welcome to AURAGPT! Your verification code is: ${code}`
        });

        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: "Failed to send OTP" });
    }
});

// --- 2. REGISTER API ---
app.post('/api/register', async (req, res) => {
    const { name, email, phone, dob, password, otp } = req.body;

    try {
        // Check OTP
        const otpCheck = await pool.query(`SELECT * FROM otps WHERE email = $1 AND code = $2 AND expires_at > NOW()`, [email, otp]);
        if (otpCheck.rows.length === 0) return res.status(400).json({ error: "Invalid or expired OTP" });

        // Check if master admin
        const assignedRole = (phone === MASTER_ADMIN_ID || email.includes('admin')) ? 'admin' : 'user';
        const hashedPassword = await bcrypt.hash(password, 10);

        // Insert User
        await pool.query(
            `INSERT INTO users (name, email, phone, dob, password, plan, role, limit_reset_date) 
             VALUES ($1, $2, $3, $4, $5, 'FREE', $6, NOW() + INTERVAL '2 days')`,
            [name, email, phone, dob, hashedPassword, assignedRole]
        );

        // Delete used OTP
        await pool.query(`DELETE FROM otps WHERE email = $1`, [email]);
        res.json({ success: true });
    } catch (error) {
        res.status(500).json({ error: "Registration failed. Email might already exist." });
    }
});

// --- 3. GENERATE API (With Rate Limits) ---
app.post('/api/request', async (req, res) => {
    const { prompt, type, userEmail } = req.body; // ফ্রন্টএন্ড থেকে লগড-ইন ইউজারের ইমেইল পাঠাতে হবে

    try {
        const userQuery = await pool.query(`SELECT * FROM users WHERE email = $1`, [userEmail]);
        const user = userQuery.rows[0];
        if(!user) return res.status(404).json({ error: "User not found" });

        // ১. Two-Day Reset Logic
        if (new Date() > new Date(user.limit_reset_date)) {
            await pool.query(`UPDATE users SET msg_count = 0, limit_reset_date = NOW() + INTERVAL '2 days' WHERE email = $1`, [userEmail]);
            user.msg_count = 0;
        }

        // ২. Check Limits
        if (user.plan === 'FREE' && user.msg_count >= 100) return res.status(403).json({ reply: "Free limit reached. Please wait 2 days or upgrade." });
        if (type === 'video') {
            if (user.plan === 'FREE') return res.status(403).json({ reply: "Video generation requires at least AURAGPT GO." });
            if (user.plan === 'GO' && user.video_count >= 5) return res.status(403).json({ reply: "GO plan limit (5) reached. Please upgrade." });
            if (user.plan === 'PLUS' && user.video_count >= 20) return res.status(403).json({ reply: "PLUS plan limit (20) reached. Please upgrade." });
        }

        // ৩. Process Request
        let apiReply = "";
        if (type === 'chat' || type === 'photo') {
            // DeepSeek API Call
            const dsRes = await axios.post('https://api.deepseek.com/v1/chat/completions', {
                model: "deepseek-chat", messages: [{"role": "user", "content": prompt}]
            }, { headers: { 'Authorization': `Bearer ${process.env.DEEPSEEK_API_KEY}` }});
            apiReply = dsRes.data.choices[0].message.content;
            
            // Update Text Count
            if(user.plan !== 'PRO') await pool.query(`UPDATE users SET msg_count = msg_count + 1 WHERE email = $1`, [userEmail]);
            res.json({ reply: apiReply });
        } 
        else if (type === 'video') {
            // Runway API Call
            const rwRes = await axios.post('https://api.runwayml.com/v1/image_to_video', {
                model: "gen3a_turbo", prompt_text: prompt
            }, { headers: { 'Authorization': `Bearer ${process.env.RUNWAY_API_KEY}`, 'X-Runway-Version': '2024-11-06' }});
            
            // Update Video Count
            if(user.plan !== 'PRO') await pool.query(`UPDATE users SET video_count = video_count + 1 WHERE email = $1`, [userEmail]);
            res.json(rwRes.data);
        }

    } catch (error) {
        res.status(500).json({ error: "API processing failed" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AuraGPT is live on port ${PORT}`));
