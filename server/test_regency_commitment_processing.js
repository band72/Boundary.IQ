import 'dotenv/config';
import fs from 'fs/promises';
import path from 'path';
import { fetch } from 'undici';

const API = 'http://localhost:5050/api';

async function run() {
  console.log('Starting verification test for Regency-Commitment PDF...');
  
  const folderPath = '/home/artwalk/Downloads/drive-download-20260602T132437Z-3-001';
  const fileName = 'Regency-Commitment - Issued 3.27.25.pdf';
  
  // First, verify that the text gets extracted and cached to _extracted/ folder
  const extractedFile = path.join(folderPath, '_extracted', 'Regency-Commitment - Issued 3.27.25.txt');
  
  try {
    // Delete existing _extracted/ txt if any to force re-extraction
    await fs.rm(extractedFile, { force: true });
    console.log('Removed existing extracted text cache file (if any).');
  } catch {}

  const params = new URLSearchParams({
    path: folderPath,
    file: fileName,
    pobN: '5000',
    pobE: '5000',
    units: 'Feet',
    force: 'true',
  });

  console.log(`Sending POST request to process single file: ${fileName}`);
  
  try {
    const start = Date.now();
    const res = await fetch(`${API}/folderscan/process-file?${params}`, {
      method: 'POST',
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
            console.log(`  Linear Error:${p.traverse?.closure?.linearError?.toFixed(4)} ft`);
            console.log(`  Precision:   ${p.traverse?.closure?.precisionRatio || 'N/A'}`);
            console.log(`  Area:        ${p.traverse?.areaAcres?.toFixed(4)} acres`);
          } else {
            console.log(`  Traverse Error: ${p.error || 'N/A'}`);
          }
        });
      }
    }
    
    // Check if _extracted text cache file was written
    const exists = await fs.access(extractedFile).then(() => true).catch(() => false);
    console.log(`\nExtracted text cached on disk: ${exists ? '✓ YES' : '✗ NO'}`);
    
  } catch (err) {
    console.error('Fetch error:', err);
  }
}

run();
