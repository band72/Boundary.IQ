import { fetch, Agent, setGlobalDispatcher } from 'undici';
import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

setGlobalDispatcher(new Agent({
  connectTimeout: 30 * 60 * 1000,
  headersTimeout: 30 * 60 * 1000,
  bodyTimeout: 30 * 60 * 1000,
}));

const PORT = process.env.PORT || 5050;
const BASE_URL = `http://localhost:${PORT}`;
const FOLDER_PATH = '/home/artwalk/Downloads/training-20260530T124201Z-3-001';

let authToken = null;

async function authenticate() {
  const username = 'cli_tester';
  const password = 'CliPassword123!';
  try {
    const loginRes = await fetch(`${BASE_URL}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    if (loginRes.ok) {
      const data = await loginRes.json();
      authToken = data.token;
      return;
    }
  } catch (err) {
    // Ignore and try register
  }
  
  try {
    const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    if (regRes.ok) {
      const data = await regRes.json();
      authToken = data.token;
    }
  } catch (err) {
    console.error(`Authentication failed: ${err.message}`);
    process.exit(1);
  }
}

async function main() {
  await authenticate();
  console.log(`✓ Authenticated successfully.`);
  console.log(`Starting headless retry batch for failed deeds in: ${FOLDER_PATH}`);

  const params = new URLSearchParams({
    path: FOLDER_PATH,
    pobN: '5000',
    pobE: '5000',
    units: 'Feet',
    maxPasses: '3',
  });

  const url = `${BASE_URL}/api/folderscan/retry-failed?${params}`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${authToken}`
      }
    });

    if (!res.ok) {
      const errText = await res.text();
      console.error(`Error: /retry-failed returned status ${res.status}:`, errText);
      process.exit(1);
    }

    console.log('Stream opened. Listening to SSE events…\n');
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || '';

      for (const part of parts) {
        if (!part.trim()) continue;

        // Parse SSE line-by-line
        const eventMatch = part.match(/^event:\s*([\w-]+)/m);
        const dataMatch = part.match(/^data:\s*(.+)$/m);

        if (eventMatch && dataMatch) {
          const eventType = eventMatch[1];
          let data = {};
          try {
            data = JSON.parse(dataMatch[1].trim());
          } catch {}

          switch (eventType) {
            case 'init':
              console.log(`🏁 Initializing retry for ${data.total} failed deeds.`);
              console.log(`   Models to try in cascade: ${data.models.join(', ')}`);
              console.log(`   Max passes per model:     ${data.maxPasses}\n`);
              break;
            case 'status':
              console.log(`ℹ️ [Status] ${data.message}`);
              break;
            case 'file-start':
              console.log(`⚙️ [${data.index}/${data.total}] Starting: ${data.fileName}`);
              break;
            case 'model-try':
              console.log(`  🤖 Trying model: ${data.model}…`);
              break;
            case 'model-fail':
              console.log(`  ❌ Model ${data.model} failed: ${data.error}`);
              break;
            case 'file-pass':
              console.log(`  ✅ Passed: ${data.fileName} via ${data.model} (${data.area} ac) [Fixed: ${data.fixed}/${data.total}]`);
              break;
            case 'file-fail':
              console.log(`  ✗ Failed: ${data.fileName} — Error: ${data.error} [Still failing: ${data.stillFailing}/${data.total}]`);
              break;
            case 'done':
              console.log(`\n🎉 Processing complete!`);
              console.log(`   Total retried:  ${data.total}`);
              console.log(`   Fixed:          ${data.fixed}`);
              console.log(`   Still failing:  ${data.stillFailing}`);
              console.log(`   Not found:      ${data.notFound}`);
              console.log(`   Pass rate:      ${data.passRate}`);
              break;
            case 'error':
              console.error(`🔴 Server error event:`, data.message);
              break;
            default:
              console.log(`[Event: ${eventType}]`, data);
          }
        }
      }
    }
  } catch (err) {
    console.error('Request failed:', err);
    process.exit(1);
  }
}

main();
