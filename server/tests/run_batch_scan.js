import { fetch } from 'undici';

const BASE_URL = 'http://localhost:5051';
const folderPath = '/home/artwalk/Downloads/drive-download-20260602T132437Z-3-001';

async function run() {
  console.log(`🚀 Starting headless batch scan for: ${folderPath}`);

  // 1. Register a temporary user to obtain authToken
  const username = `headless_user_${Date.now()}`;
  console.log(`Creating headless user: ${username}`);
  const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      password: 'Password123!',
      role: 'user',
      plan: 'pro'
    })
  });

  if (!regRes.ok) {
    console.error(`Registration failed: ${regRes.status}`, await regRes.text());
    return;
  }

  const regData = await regRes.json();
  const token = regData.token;
  console.log(`✓ Token acquired: ${token.substring(0, 10)}...`);

  // 2. Set active model to ollama / gemma3:4b
  console.log(`Setting active provider/model to ollama/gemma3:4b...`);
  const setModelRes = await fetch(`${BASE_URL}/api/settings/model`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${token}`
    },
    body: JSON.stringify({
      provider: 'ollama',
      model: 'gemma3:4b'
    })
  });

  if (!setModelRes.ok) {
    console.error(`Failed to set model: ${setModelRes.status}`, await setModelRes.text());
    return;
  }
  console.log(`✓ Active model successfully configured.`);

  // 3. Trigger folder batch scan
  const params = new URLSearchParams({
    path: folderPath,
    batchIndex: '0',
    pobN: '5000',
    pobE: '5000',
    units: 'Feet',
    autoOutput: 'true',
  });

  console.log(`Triggering folderscan process-batch...`);
  const start = Date.now();
  const scanRes = await fetch(`${BASE_URL}/api/folderscan/process-batch?${params}`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`
    }
  });

  if (!scanRes.ok) {
    console.error(`Scan failed: ${scanRes.status}`, await scanRes.text());
    return;
  }

  console.log(`Waiting for batch processing response stream...`);
  const responseText = await scanRes.text();
  const duration = ((Date.now() - start) / 1000).toFixed(1);
  console.log(`Response received after ${duration}s.`);

  const jsonStr = responseText.trim();
  try {
    const data = JSON.parse(jsonStr);
    console.log('\n=========================================');
    console.log('BATCH SCAN COMPLETE');
    console.log('=========================================');
    console.log(`Batch ID:          ${data.batchId}`);
    console.log(`Batch Index:       ${data.batchIndex}/${data.totalBatches - 1}`);
    console.log(`Files Processed:   ${data.filesInBatch}`);
    console.log(`Output Folder:     ${data.outputFolder}`);
    
    const stats = data.results;
    if (stats) {
      console.log(`Succeeded:         ${stats.succeeded}`);
      console.log(`Failed:            ${stats.failed}`);
      console.log(`Total:             ${stats.totalProcessed}`);
      
      if (stats.results) {
        console.log('\nProcessed Files:');
        stats.results.forEach((r, idx) => {
          if (!r) return;
          console.log(`  ${idx + 1}. File: ${r.fileName} | Status: ${r.status} | Error: ${r.error || 'None'}`);
        });
      }
    }
  } catch (parseErr) {
    console.error(`Failed to parse response JSON:`, parseErr.message);
    console.log(`Raw response:`, responseText);
  }
}

run().catch(console.error);
