import { fetch } from 'undici';

const OLLAMA_BASE = 'http://127.0.0.1:11434';

async function testDeepSeek(useJsonFormat) {
  console.log(`\nTesting deepseek-r1:8b with useJsonFormat=${useJsonFormat}...`);
  const payload = {
    model: 'deepseek-r1:8b',
    prompt: 'Return a JSON object with a single key "test" and value "hello". Return nothing else.',
    stream: false,
    options: { temperature: 0.1 }
  };
  if (useJsonFormat) {
    payload.format = 'json';
  }

  const start = Date.now();
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const duration = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`Response in ${duration}s:`);
    console.log(data.response);
  } catch (err) {
    console.error('Error:', err.message);
  }
}

async function run() {
  await testDeepSeek(true);
  await testDeepSeek(false);
}

run();
