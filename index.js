const express = require('express');
const axios = require('axios');
const dotenv = require('dotenv');
const path = require('path');

dotenv.config();
const app = express();
app.use(express.json());

const RUNWAY_API_KEY = process.env.RUNWAY_API_KEY;

// কোনো ফোল্ডার ছাড়া সরাসরি ফাইল সার্ভ করার নিয়ম
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/logo.png', (req, res) => {
    res.sendFile(path.join(__dirname, 'logo.png'));
});

// ভিডিও জেনারেশন রিকোয়েস্ট
app.post('/api/generate', async (req, res) => {
    try {
        const response = await axios.post('https://api.runwayml.com/v1/image_to_video', {
            model: "gen3a_turbo",
            prompt_text: req.body.prompt
        }, {
            headers: {
                'Authorization': `Bearer ${RUNWAY_API_KEY}`,
                'X-Runway-Version': '2024-11-06',
                'Content-Type': 'application/json'
            }
        });
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: "Runway API Error" });
    }
});

// স্ট্যাটাস পোলিং
app.get('/api/status/:id', async (req, res) => {
    try {
        const response = await axios.get(`https://api.runwayml.com/v1/tasks/${req.params.id}`, {
            headers: {
                'Authorization': `Bearer ${RUNWAY_API_KEY}`,
                'X-Runway-Version': '2024-11-06'
            }
        });
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: "Status Check Failed" });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`AuraGPT is live on port ${PORT}`));