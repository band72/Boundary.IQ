import 'dotenv/config';
import { fetch } from 'undici';

const apiKey = process.env.GEMINI_API_KEY;
const models = [
  'gemini-3.1-flash-lite',
  'gemini-3-flash-preview',
  'gemini-2.0-flash',
  'antigravity-preview-05-2026',
  'gemini-flash-latest'
];

async function run() {
  for (const model of models) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
    const payload = {
      contents: [{
        parts: [{ text: 'Hello, are you online?' }],
      }],
    };

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      console.log(`Model ${model} -> Status ${res.status}`);
      console.log('Response:', text);
      if (res.status === 200) {
        break;
      }
    } catch (err) {
      console.error(`Fetch error for ${model}:`, err);
    }
  }
}

run();
