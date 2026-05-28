import { fetch } from 'undici';

const apiKey = 'AIzaSyCmwqDy-qRJEB6nb7tvR75yun8MNAgvN2w';
const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;

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
