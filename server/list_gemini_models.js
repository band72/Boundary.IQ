import 'dotenv/config';
import { fetch } from 'undici';

const apiKey = process.env.GEMINI_API_KEY;
const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`;

async function run() {
  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    const text = await res.text();
    console.log('Status:', res.status);
    const json = JSON.parse(text);
    if (json.models) {
      json.models.forEach(m => console.log(m.name, m.supportedGenerationMethods));
    } else {
      console.log('Response:', json);
    }
  } catch (err) {
    console.error('Fetch error:', err);
  }
}

run();
