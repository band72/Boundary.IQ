import 'dotenv/config';
import { fetch } from 'undici';

async function main() {
  const apiKey = process.env.GEMINI_API_KEY;
  console.log('Using API key:', apiKey ? apiKey.substring(0, 8) + '...' : 'none');
  const model = 'gemini-3.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: 'Hello, respond with exactly "Key is valid!"' }] }]
      })
    });
    const text = await res.text();
    console.log('Status:', res.status);
    console.log('Response:', text);
  } catch (err) {
    console.error('Error contacting Gemini:', err);
  }
}

main();
