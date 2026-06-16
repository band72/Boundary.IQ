import { fetch } from 'undici';

const API = 'http://localhost:5050/api';
const folderPath = process.argv[2] || '/home/artwalk/Downloads/drive-download-20260602T132437Z-3-001';

async function run() {
  console.log(`Starting headless batch scan for: ${folderPath}`);

  const params = new URLSearchParams({
    path: folderPath,
    batchIndex: '0',
    pobN: '5000',
    pobE: '5000',
    units: 'Feet',
    autoOutput: 'true',
  });

  console.log(`Sending POST request to process-batch...`);
  const start = Date.now();

  try {
    const res = await fetch(`${API}/folderscan/process-batch?${params}`, {
      method: 'POST',
    });

    console.log(`Response headers received. Status: ${res.status}`);
    
    if (!res.ok) {
      const errText = await res.text();
      console.error(`Error response:`, errText);
      return;
    }

    // Since process-batch returns space characters as heartbeats, we read the response as a stream
    // or wait for it to complete. Using res.text() waits for the entire stream to finish.
    console.log(`Waiting for batch processing to complete (this may take a few minutes)...`);
    const responseText = await res.text();
    const duration = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`Response body received after ${duration}s.`);

    // Parse the JSON payload from the end of the response (trimming any prepended whitespace/heartbeats)
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
          console.log('\nProcessed Files List:');
          stats.results.forEach((r, idx) => {
            if (!r) return;
            console.log(`  ${idx + 1}. File: ${r.fileName} | Status: ${r.status} | Error: ${r.error || 'None'}`);
          });
        }
      }
    } catch (parseErr) {
      console.error(`Failed to parse response JSON:`, parseErr.message);
      console.log(`Raw response was:`, responseText);
    }

  } catch (err) {
    console.error(`Fetch request failed:`, err);
  }
}

run();
