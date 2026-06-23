import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { fetch } from 'undici';

const API = 'http://localhost:5050/api';

async function run() {
  console.log('Starting verification test for Title (Gator-Nole-Sandbagger-Stewart) PDF...');
  
  const folderPath = process.argv[2] || '/home/artwalk/Downloads/drive-download-20260602T132437Z-3-001';
  const fileName = 'Title (Gator-Nole-Sandbagger-Stewart).pdf';
  
  const params = new URLSearchParams({
    path: folderPath,
    file: fileName,
    pobN: '5000',
    pobE: '5000',
    units: 'Feet',
    force: 'true',
    autoOutput: 'true',
    shortFileNames: 'true'
  });

  // Authenticate first
  let authToken = null;
  const username = 'cli_tester';
  const password = 'CliPassword123!';
  try {
    const loginRes = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password })
    });
    if (loginRes.ok) {
      const data = await loginRes.json();
      authToken = data.token;
    }
  } catch (err) {}
  if (!authToken) {
    try {
      const regRes = await fetch(`${API}/auth/register`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password })
      });
      if (regRes.ok) {
        const data = await regRes.json();
        authToken = data.token;
      }
    } catch (err) {}
  }
  if (!authToken) {
    console.error('Failed to authenticate.');
    return;
  }

  console.log(`Sending POST request to process single file: ${fileName}`);
  
  try {
    const start = Date.now();
    const headers = {};
    if (authToken) headers['Authorization'] = `Bearer ${authToken}`;
    const res = await fetch(`${API}/folderscan/process-file?${params}`, {
      method: 'POST',
      headers
    });
    
    console.log(`Response status: ${res.status} (${Date.now() - start}ms)`);
    const data = await res.json();
    
    if (!res.ok) {
      console.error('Error returned:', data);
      return;
    }
    
    console.log('\n=========================================');
    console.log('API RESPONSE STATUS:', data.status);
    console.log('=========================================');
    
    const result = data.result;
    if (result) {
      console.log(`Is Multi-Parcel: ${result.isMultiParcel}`);
      if (result.parcels) {
        console.log(`Parcels Count:  ${result.parcels.length}`);
        result.parcels.forEach((p, idx) => {
          console.log(`\nParcel ${idx + 1}: ${p.fileName}`);
          console.log(`  Status:      ${p.status}`);
          console.log(`  Course Count:${p.extraction?.courses?.length || 0}`);
          if (p.traverse) {
            const linErr = p.traverse.closure?.linearError ?? p.traverse.linearError;
            const prec = p.traverse.closure?.precisionRatio ?? p.traverse.precisionRatio;
            const area = p.traverse.areaAcres ?? p.traverse.closure?.areaAcres;
            console.log(`  Linear Error: ${linErr != null ? linErr.toFixed(4) + ' ft' : 'N/A'}`);
            console.log(`  Precision:    ${prec || 'N/A'}`);
            console.log(`  Area:         ${area != null ? area.toFixed(4) + ' acres' : 'N/A'}`);
          } else {
            console.log(`  Traverse Error: ${p.error || 'N/A'}`);
          }
        });
      } else {
        console.log(`No parcels list inside result.`);
        console.log(`Status: ${result.status}`);
        console.log(`Course Count: ${result.extraction?.courses?.length || 0}`);
        if (result.traverse) {
          console.log(`Linear Error: ${result.traverse?.closure?.linearError?.toFixed(4)} ft`);
        }
      }
    }
  } catch (err) {
    console.error('Fetch error:', err);
  }
}

run();
