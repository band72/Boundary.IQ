import { fetch } from 'undici';

const API = 'http://localhost:5050/api';
const folderPath = '/home/artwalk/Downloads/drive-download-20260602T132437Z-3-001';

async function runBatch(batchIndex) {
  console.log(`\n======================================================`);
  console.log(`STARTING BATCH ${batchIndex}`);
  console.log(`======================================================`);

  const params = new URLSearchParams({
    path: folderPath,
    batchIndex: String(batchIndex),
    pobN: '5000',
    pobE: '5000',
    units: 'Feet',
    autoOutput: 'true',
  });

  const start = Date.now();
  try {
    const res = await fetch(`${API}/folderscan/process-batch?${params}`, {
      method: 'POST',
    });

    console.log(`Batch ${batchIndex} - Response headers received. Status: ${res.status}`);
    
    if (!res.ok) {
      const errText = await res.text();
      console.error(`Batch ${batchIndex} - Error response:`, errText);
      return { success: false, totalBatches: 0 };
    }

    console.log(`Waiting for Batch ${batchIndex} to complete (live LLM runs can take several minutes)...`);
    const responseText = await res.text();
    const duration = ((Date.now() - start) / 1000).toFixed(1);
    console.log(`Batch ${batchIndex} - Response received after ${duration}s.`);

    const jsonStr = responseText.trim();
    try {
      const data = JSON.parse(jsonStr);
      console.log('------------------------------------------------------');
      console.log(`Batch ID:          ${data.batchId}`);
      console.log(`Batch Index:       ${data.batchIndex}/${data.totalBatches - 1}`);
      console.log(`Files Processed:   ${data.filesInBatch}`);
      console.log(`Output Folder:     ${data.outputFolder}`);
      
      const stats = data.results;
      if (stats) {
        console.log(`Succeeded:         ${stats.succeeded}`);
        console.log(`Failed:            ${stats.failed}`);
        console.log(`Skipped:           ${stats.skipped ?? 0}`);
        console.log(`Total:             ${stats.totalProcessed}`);
        
        if (stats.results) {
          console.log('Files list:');
          stats.results.forEach((r, idx) => {
            if (!r) return;
            console.log(`  ${idx + 1}. File: ${r.fileName} | Status: ${r.status} | Error: ${r.error || 'None'}`);
          });
        }
      }
      return { success: true, totalBatches: data.totalBatches };
    } catch (parseErr) {
      console.error(`Batch ${batchIndex} - Failed to parse response JSON:`, parseErr.message);
      console.log(`Raw response was:`, responseText.substring(0, 1000));
      return { success: false, totalBatches: 0 };
    }

  } catch (err) {
    console.error(`Batch ${batchIndex} - Request failed:`, err);
    return { success: false, totalBatches: 0 };
  }
}

async function main() {
  console.log(`Starting headless runner for all batches in: ${folderPath}`);
  let batchIndex = 0;
  let totalBatches = 1;

  while (batchIndex < totalBatches) {
    const res = await runBatch(batchIndex);
    if (res.success) {
      totalBatches = res.totalBatches;
      console.log(`Batch ${batchIndex} completed successfully. moving to next batch...`);
      batchIndex++;
    } else {
      console.error(`Batch ${batchIndex} failed. Retrying in 10 seconds...`);
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }

  console.log(`\n======================================================`);
  console.log(`ALL BATCHES COMPLETED!`);
  console.log(`======================================================`);
}

main();
