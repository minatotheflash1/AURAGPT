const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const path = require('path');
// const { Pool } = require('pg'); // PostgreSQL এর জন্য এটি পরবর্তীতে লাগবে

dotenv.config();
const app = express();
app.use(express.json());

const RUNWAY_API_KEY = process.env.RUNWAY_API_KEY;
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY; // DeepSeek API অ্যাড করতে হবে

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'login.html')));
app.get('/chat', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

// Unified API Endpoint
app.post('/api/request', async (req, res) => {
    const { prompt, type } = req.body;

    // ১. Normal Chat -> DeepSeek
    if (type === 'chat') {
        try {
            const response = await axios.post('https://api.deepseek.com/v1/chat/completions', {
                model: "deepseek-chat",
                messages: [{"role": "user", "content": prompt}]
            }, {
                headers: { 'Authorization': `Bearer ${DEEPSEEK_API_KEY}` }
            });
            res.json({ reply: response.data.choices[0].message.content });
        } catch (error) {
            res.status(500).json({ error: "DeepSeek API failed" });
        }
    } 
    // ২. Video Generation -> Runway
    else if (type === 'video') {
        try {
            const response = await axios.post('https://api.runwayml.com/v1/image_to_video', {
                model: "gen3a_turbo",
                prompt_text: prompt
            }, {
                headers: {
                    'Authorization': `Bearer ${RUNWAY_API_KEY}`,
                    'X-Runway-Version': '2024-11-06'
                }
            });
            res.json(response.data);
        } catch (error) {
            res.status(500).json({ error: "Runway API Error" });
        }
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AuraGPT is live on port ${PORT}`));
