import 'dotenv/config';
import { fetch } from 'undici';

const apiKey = process.env.GEMINI_API_KEY;
console.log('Testing API key:', apiKey);
const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

const payload = {
  contents: [{
    parts: [{ text: 'Hello, are you online?' }],
  }],
};

async function run() {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const text = await res.text();
    console.log('Status:', res.status);
    console.log('Response:', text);
  } catch (err) {
    console.error('Fetch error:', err);
  }
}

run();
